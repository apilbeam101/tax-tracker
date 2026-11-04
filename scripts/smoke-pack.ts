/**
 * Packs the project, installs the tarball into an empty directory, starts it on a free port and
 * probes /health. Proves the published package runs on this OS, including the prebuilt argon2
 * binary. Usage: npm run build && npm run pack:smoke
 * SMOKE_NPM_VERSION=12 installs the tarball with that npm release instead of the running one.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runNpm } from './run-npm.ts'

const work = mkdtempSync(join(tmpdir(), 'tt-smoke-'))
const packDir = join(work, 'pack')
const installDir = join(work, 'install')
const dataDir = join(work, 'data')

async function main(): Promise<void> {
  mkdirSync(packDir)
  mkdirSync(installDir)
  writeFileSync(join(installDir, 'package.json'), '{"name":"smoke","private":true}\n')

  const [pack] = JSON.parse(runNpm(['pack', '--json', '--pack-destination', packDir])) as Array<{
    filename: string
  }>
  const tarball = join(packDir, (pack as { filename: string }).filename)
  runNpm(['install', '--no-audit', '--no-fund', tarball], installDir, installerCli())

  const cli = join(installDir, 'node_modules', 'uk-tax-tracker', 'dist', 'server', 'cli.js')
  const child = spawn(process.execPath, [cli, 'start', '--port', '0', '--data-dir', dataDir], {
    cwd: installDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => {
    output += d
  })
  child.stderr.on('data', (d) => {
    output += d
  })

  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), 30_000)
      const poll = setInterval(() => {
        const match = /running at (http:\/\/\S+)/.exec(output)
        if (match?.[1]) {
          clearTimeout(timer)
          clearInterval(poll)
          resolve(match[1])
        }
      }, 100)
      child.once('exit', (code) => {
        clearTimeout(timer)
        clearInterval(poll)
        reject(new Error(`Server exited with ${code}:\n${output}`))
      })
    })
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) })
    const body = (await res.json()) as { status?: string; version?: string }
    if (res.status !== 200 || body.status !== 'ok') {
      throw new Error(`Unexpected /health response: ${res.status} ${JSON.stringify(body)}`)
    }
    console.log(`Smoke test passed: ${url}/health -> ${JSON.stringify(body)}`)
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r))
      child.kill()
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))])
    }
    removeWork()
  }
}

// npm 12 stopped running dependency install scripts and resolving git/URL dependencies by default,
// so the install is also proven with the npm a user will have. Runners ship an older npm.
function installerCli(): string | undefined {
  const version = process.env.SMOKE_NPM_VERSION
  if (!version) return undefined
  const toolDir = join(work, 'npm-tool')
  mkdirSync(toolDir)
  runNpm(['install', '--no-audit', '--no-fund', '--prefix', toolDir, `npm@${version}`])
  const cli = join(toolDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  console.log(`Installing the tarball with npm ${runNpm(['--version'], work, cli).trim()}`)
  return cli
}

// Windows can hold the SQLite files for a moment after the process exits.
function removeWork(): void {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  try {
    removeWork()
  } catch {
    /* leftover temp files are not worth masking the real failure */
  }
  process.exit(1)
})

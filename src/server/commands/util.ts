import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { DatabaseSync } from 'node:sqlite'
import { readConfigFile } from '../config/file.ts'
import { type DataPaths, resolveDataPaths } from '../config/paths.ts'

export class CliError extends Error {}

export function dataPaths(env: NodeJS.ProcessEnv = process.env): DataPaths {
  return resolveDataPaths({
    env,
    cwd: process.cwd(),
    platform: process.platform,
    home: homedir(),
  })
}

export function openExistingDb(dbPath: string, options: { readOnly?: boolean } = {}): DatabaseSync {
  if (!existsSync(dbPath)) throw new CliError(`No database at ${dbPath}. Start the app once first.`)
  const db = new DatabaseSync(dbPath, { readOnly: options.readOnly === true })
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

// Environment over config.json, as the server resolves it in self-configured mode, but read-only:
// nothing is generated or written. In env-supplied mode the server ignores the file, so this does too.
export function settingsWithFile(env: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env }
  if (env.AUTO_CONFIG !== 'true') return merged
  const file = readConfigFile(dataDir) ?? {}
  for (const [name, value] of Object.entries(file)) {
    if (env[name]) continue
    if (name === 'SESSION_SECRET' && env.SESSION_SECRET_FILE) continue
    merged[name] = value
  }
  return merged
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// The passphrase is typed, never passed as an argument or read from the environment, so it cannot
// end up in a process listing. Without a terminal (a pipe, or a shell that does not provide one)
// the first line of standard input is used, and it is not hidden.
export async function promptSecret(question: string): Promise<string> {
  const { stdin, stderr } = process
  if (!stdin.isTTY) {
    stderr.write(
      `${question}(no terminal: reading one line from standard input, input is not hidden)\n`,
    )
    const rl = createInterface({ input: stdin })
    try {
      for await (const line of rl) return line
    } finally {
      rl.close()
    }
    throw new CliError('No input on standard input')
  }

  stderr.write(question)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (): void => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      stderr.write('\n')
    }
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          finish()
          resolve(value)
          return
        }
        if (ch === '\u0003') {
          finish()
          reject(new CliError('Cancelled'))
          return
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}

export async function promptLine(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = (await rl.question(`${question} [${fallback}]: `)).trim()
    return answer || fallback
  } finally {
    rl.close()
  }
}

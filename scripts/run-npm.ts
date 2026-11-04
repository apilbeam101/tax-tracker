import { spawnSync } from 'node:child_process'

// npm_execpath is set when running under npm, and avoids spawning npm.cmd through a shell on
// Windows (which Node refuses to do without one). `npmCli` runs a specific npm instead.
export function runNpm(
  args: string[],
  cwd: string = process.cwd(),
  npmCli: string | undefined = process.env.npm_execpath,
): string {
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8' })
    : spawnSync('npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed:\n${result.stderr}`)
  return result.stdout
}

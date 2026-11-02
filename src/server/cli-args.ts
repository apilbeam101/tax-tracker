import { parseArgs } from 'node:util'

export const COMMANDS = [
  'start',
  'init',
  'info',
  'doctor',
  'backup',
  'backfill-fx',
  'keys',
] as const
export type Command = (typeof COMMANDS)[number]

export const KEYS_SUBCOMMANDS = ['add-unattended', 'remove-unattended', 'rotate-recovery'] as const
export type KeysSubcommand = (typeof KEYS_SUBCOMMANDS)[number]

export interface ParsedCli {
  command: Command | 'help' | 'version'
  subcommand: string | undefined
  port: string | undefined
  host: string | undefined
  dataDir: string | undefined
  envFile: string | undefined
  open: boolean
  interactive: boolean
}

export class UsageError extends Error {}

export const HELP = `Usage: tax-tracker [command] [options]

Commands:
  start                 Run the server (the default when no command is given)
  init                  Create the config file and show where everything lives
  info                  Show version, data directory, configuration and unlock mode
  doctor                Check the installation (never prints or asks for key material)
  backup                Write a consistent snapshot of the database to <data dir>/backups
  backfill-fx           Fill in GBP amounts for imported transactions (unencrypted databases only)
  keys add-unattended   Add the unattended unlock slot, using ENCRYPTION_KEY or ENCRYPTION_KEY_FILE
  keys remove-unattended
  keys rotate-recovery  Replace the recovery key and print the new one once

Options:
  --port <n>            Port to listen on (0 picks a free port)
  --host <address>      Address to listen on
  --data-dir <path>     Where the database and config file live
  --env-file <path>     Load environment variables from a file
  --open                Open the browser once the server is listening (start)
  --interactive         Prompt for non-secret settings (init)
  -v, --version
  -h, --help
`

function parsePort(raw: string): string {
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(n) || n < 0 || n > 65535) {
    throw new UsageError(`--port must be an integer between 0 and 65535, got: ${raw}`)
  }
  return String(n)
}

function parseFlags(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        'data-dir': { type: 'string' },
        'env-file': { type: 'string' },
        open: { type: 'boolean' },
        interactive: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    })
  } catch (err) {
    throw new UsageError((err as Error).message)
  }
}

export function parseCli(argv: string[]): ParsedCli {
  const { values, positionals } = parseFlags(argv)
  const [first, second, ...extra] = positionals

  const base = {
    subcommand: undefined as string | undefined,
    port: values.port === undefined ? undefined : parsePort(values.port),
    host: values.host,
    dataDir: values['data-dir'],
    envFile: values['env-file'],
    open: values.open === true,
    interactive: values.interactive === true,
  }

  if (values.help) return { ...base, command: 'help' }
  if (values.version) return { ...base, command: 'version' }
  if (first === undefined) return { ...base, command: 'start' }
  if (!(COMMANDS as readonly string[]).includes(first)) {
    throw new UsageError(`Unknown command: ${first}`)
  }
  const command = first as Command

  if (command === 'keys') {
    if (!second || !(KEYS_SUBCOMMANDS as readonly string[]).includes(second) || extra.length > 0) {
      throw new UsageError(`Usage: tax-tracker keys <${KEYS_SUBCOMMANDS.join('|')}>`)
    }
    return { ...base, command, subcommand: second }
  }
  if (second !== undefined) throw new UsageError(`Unexpected argument: ${second}`)
  return { ...base, command }
}

// Flags override the environment. Self-configured mode is the default for the CLI, so a one-command
// start works; an explicit AUTO_CONFIG (including false) is left alone.
export function applyCliEnv(env: NodeJS.ProcessEnv, cli: ParsedCli): void {
  if (!env.AUTO_CONFIG) env.AUTO_CONFIG = 'true'
  if (cli.port !== undefined) env.PORT = cli.port
  if (cli.host !== undefined) env.HOST = cli.host
  if (cli.dataDir !== undefined) {
    if (env.DB_PATH) {
      throw new UsageError(
        '--data-dir cannot be combined with DB_PATH, which already names the database file',
      )
    }
    env.DATA_DIR = cli.dataDir
  }
}

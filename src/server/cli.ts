#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { applyCliEnv, HELP, type ParsedCli, parseCli, UsageError } from './cli-args.ts'
import { CliError, closePrompts, errorMessage, promptLine, promptSecret } from './commands/util.ts'

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  const child = spawn(cmd, args, {
    stdio: 'ignore',
    detached: true,
    windowsVerbatimArguments: true,
    windowsHide: true,
  })
  child.on('error', () => console.log(`  Open ${url} in your browser.`))
  child.unref()
}

async function init(cli: ParsedCli): Promise<void> {
  const { runInit } = await import('./init.ts')
  const report = runInit(process.env)
  console.log(`Data directory: ${report.dataDir} (from ${report.dataDirSource})`)
  console.log(`Database:       ${report.dbPath}`)
  console.log(`Config file:    ${report.configFile}`)
  console.log(`Session secret: ${report.sessionSecret}`)

  if (!cli.interactive) return
  if (!process.stdin.isTTY) throw new CliError('--interactive needs a terminal')
  if (process.env.AUTO_CONFIG !== 'true') {
    throw new CliError('The config file is only used in self-configured mode (AUTO_CONFIG=true).')
  }
  if (process.env.FX_RATE_POLICY) {
    throw new CliError('FX_RATE_POLICY is set in the environment, which overrides the config file.')
  }
  const { readConfigFile, updateConfigSettings } = await import('./config/file.ts')
  const current = readConfigFile(report.dataDir)?.FX_RATE_POLICY ?? 'hmrc-monthly'
  let policy = ''
  while (policy !== 'hmrc-monthly' && policy !== 'daily-spot') {
    policy = await promptLine('FX rate policy (hmrc-monthly or daily-spot)', current)
  }
  updateConfigSettings(report.dataDir, { FX_RATE_POLICY: policy })
  console.log(`FX rate policy set to ${policy}. API keys are entered in the app after setup.`)
}

const dbPassphrase = () => promptSecret('Passphrase or recovery key: ')

async function exportPassphraseTwice(): Promise<string> {
  const first = await promptSecret('Export passphrase (12 characters or more): ')
  const again = await promptSecret('Repeat the export passphrase: ')
  if (first !== again) throw new CliError('The passphrases do not match.')
  return first
}

let assumeYes = false

async function confirm(question: string, word: string): Promise<void> {
  if (assumeYes) return
  if (!process.stdin.isTTY) {
    throw new CliError('This needs a terminal to confirm. Pass --yes to confirm without one.')
  }
  if ((await promptLine(question, '')) !== word) throw new CliError('Cancelled.')
}

async function keys(sub: string): Promise<void> {
  const { addUnattended, removeUnattended, rotateRecovery } = await import('./commands/keys.ts')
  const passphrase = () => promptSecret('Passphrase or recovery key: ')
  if (sub === 'add-unattended') console.log(await addUnattended(process.env, passphrase))
  else if (sub === 'remove-unattended') console.log(await removeUnattended(process.env, passphrase))
  else {
    const recoveryKey = await rotateRecovery(process.env, passphrase)
    console.log(`New recovery key (shown once, store it somewhere safe):\n\n  ${recoveryKey}\n`)
    console.log('The previous recovery key no longer works. Confirm the new one in the app.')
  }
}

async function run(cli: ParsedCli): Promise<void> {
  switch (cli.command) {
    case 'help':
      console.log(HELP)
      return
    case 'version': {
      const { appVersion } = await import('./commands/info.ts')
      console.log(appVersion())
      return
    }
    case 'init':
      return init(cli)
    case 'info': {
      const { gatherInfo, formatInfo } = await import('./commands/info.ts')
      console.log(formatInfo(gatherInfo(process.env)))
      return
    }
    case 'doctor': {
      const { runDoctor, formatChecks } = await import('./commands/doctor.ts')
      const checks = await runDoctor(process.env)
      console.log(formatChecks(checks))
      if (checks.some((c) => c.status === 'fail')) process.exitCode = 1
      return
    }
    case 'backup': {
      const { runBackup } = await import('./commands/backup.ts')
      console.log(`Backup written to ${await runBackup(process.env)}`)
      return
    }
    case 'backfill-fx': {
      const { runBackfillFx } = await import('./commands/backfill-fx.ts')
      const result = await runBackfillFx(process.env)
      if (result.failed > 0) process.exitCode = 1
      return
    }
    case 'keys':
      return keys(cli.subcommand as string)
    case 'restore': {
      const { runRestore } = await import('./commands/archive.ts')
      await confirm(
        'This replaces your current database with the backup. Type "restore" to continue',
        'restore',
      )
      console.log(await runRestore(process.env, cli.file as string))
      return
    }
    case 'export': {
      const { runExport } = await import('./commands/archive.ts')
      if (cli.plaintext) {
        await confirm(
          'The archive will hold your data unencrypted. Type "plaintext" to continue',
          'plaintext',
        )
      }
      const out = cli.out ?? `tax-tracker-archive-${new Date().toISOString().slice(0, 10)}.json`
      const path = await runExport(process.env, dbPassphrase, exportPassphraseTwice, {
        out,
        plaintext: cli.plaintext,
      })
      console.log(`Archive written to ${path}`)
      return
    }
    case 'import': {
      const { runImport } = await import('./commands/archive.ts')
      if (cli.replace) {
        await confirm(
          'This deletes your current instruments and transactions (a backup is taken first). Type "replace" to continue',
          'replace',
        )
      }
      const summary = await runImport(
        process.env,
        cli.file as string,
        dbPassphrase,
        () => promptSecret('Export passphrase: '),
        { replace: cli.replace },
      )
      console.log(
        `Imported ${summary.instruments} instruments, ${summary.transactions} transactions, ${summary.vestSchedule} scheduled vests, ${summary.prices} prices.`,
      )
      return
    }
    case 'start': {
      // Loaded now, after the flags have been applied to the environment: the config module reads
      // it when first imported.
      const { startServer } = await import('./start.ts')
      const url = await startServer()
      if (cli.open)
        openBrowser(url.replace('//0.0.0.0', '//127.0.0.1').replace('//[::]', '//[::1]'))
      return
    }
  }
}

try {
  const cli = parseCli(process.argv.slice(2))
  if (cli.envFile) process.loadEnvFile(cli.envFile)
  applyCliEnv(process.env, cli)
  assumeYes = cli.yes
  try {
    await run(cli)
  } finally {
    closePrompts()
  }
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`${err.message}\n\n${HELP}`)
    process.exit(2)
  }
  console.error(err instanceof CliError ? err.message : errorMessage(err))
  process.exit(1)
}

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readSecret } from '../config/secrets.ts'
import { HttpError } from '../errors.ts'
import {
  ARCHIVE_PASSPHRASE_REQUIRED,
  buildArchive,
  encryptArchive,
  type ImportSummary,
  importArchive,
  parseArchive,
} from '../services/backup/archive.ts'
import { createBackup } from '../services/backup/backups.ts'
import { applyPendingRestore, stageRestore } from '../services/backup/restore.ts'
import {
  isServerRunning,
  serverLockIsFresh,
  writeServerLock,
} from '../services/backup/server-lock.ts'
import { recalcAllInstruments } from '../services/tax/recalc.ts'
import { appVersion } from './info.ts'
import type { PassphraseSource } from './keys.ts'
import { openData } from './open-data.ts'
import { CliError, dataPaths, errorMessage } from './util.ts'

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024

const RUNNING_MESSAGE = (dataDir: string) =>
  `The app appears to be running: server.lock in ${dataDir} was refreshed recently. Stop it first (in a container, stop the app container; a one-off container on the same volume is fine). If it was just stopped or crashed, wait 30 seconds and retry.`

// Refuses while a server holds the data directory, then holds it itself for the rest of the
// command, so a server that starts meanwhile waits instead of opening a database that is about to
// be swapped or rewritten.
async function claimDataDir(dataDir: string): Promise<void> {
  if (await isServerRunning(dataDir)) throw new CliError(RUNNING_MESSAGE(dataDir))
  writeServerLock(dataDir)
}

// The key the server will be started with, so a restore it could not open is refused here rather
// than turning into a restart loop. A key that cannot be read is simply not checked.
function readUnattendedKeyIfAny(env: NodeJS.ProcessEnv): { encryptionKey: string | undefined } {
  const key = readSecret('ENCRYPTION_KEY', env, [])
  return { encryptionKey: key || undefined }
}

// Turns a validation failure from the shared services into the plain message a user should see.
async function userFacing<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof HttpError) throw new CliError(err.message)
    throw err
  }
}

export async function runRestore(env: NodeJS.ProcessEnv, file: string): Promise<string> {
  const { dbPath, dataDir } = dataPaths(env)
  await claimDataDir(dataDir)
  const { encryptionKey } = readUnattendedKeyIfAny(env)
  await userFacing(() => stageRestore(dbPath, resolve(file), { encryptionKey }))
  const lines: string[] = []
  const result = await applyPendingRestore(dbPath, (m) => lines.push(m), {
    encryptionKey,
    // After the slow steps, in case a server started anyway.
    beforeSwap: () => {
      if (serverLockIsFresh(dataDir)) throw new CliError(RUNNING_MESSAGE(dataDir))
    },
  })
  if (!result?.applied) throw new CliError(result?.reason ?? 'The restore was not applied')
  return `${lines.join('\n')}\nStart the app; it will ask for the passphrase (or recovery key) belonging to this backup.`
}

export interface ExportOptions {
  out: string
  plaintext: boolean
}

export async function runExport(
  env: NodeJS.ProcessEnv,
  dbPassphrase: PassphraseSource,
  exportPassphrase: PassphraseSource,
  options: ExportOptions,
): Promise<string> {
  const data = await openData(env, dbPassphrase)
  try {
    const archive = buildArchive(data.stores, appVersion())
    const output = options.plaintext
      ? archive
      : await userFacing(async () => encryptArchive(archive, await exportPassphrase()))
    const path = resolve(options.out)
    try {
      writeFileSync(path, JSON.stringify(output), { mode: 0o600, flag: 'wx' })
    } catch (err) {
      throw new CliError(`Could not write ${path}: ${errorMessage(err)}`)
    }
    return path
  } finally {
    data.close()
  }
}

export interface ImportOptions {
  replace: boolean
}

export async function runImport(
  env: NodeJS.ProcessEnv,
  file: string,
  dbPassphrase: PassphraseSource,
  exportPassphrase: PassphraseSource,
  options: ImportOptions,
): Promise<ImportSummary> {
  const { dataDir } = dataPaths(env)
  await claimDataDir(dataDir)
  const path = resolve(file)
  if (statSync(path).size > MAX_ARCHIVE_BYTES) throw new CliError('That archive is too large')
  const text = readFileSync(path, 'utf8')

  const archive = await userFacing(async () => {
    try {
      return await parseArchive(text)
    } catch (err) {
      if (err instanceof HttpError && err.code === ARCHIVE_PASSPHRASE_REQUIRED) {
        return parseArchive(text, await exportPassphrase())
      }
      throw err
    }
  })

  const data = await openData(env, dbPassphrase)
  try {
    if (options.replace) await createBackup(data.db, data.dataDir, 'pre-import')
    const summary = await userFacing(() =>
      importArchive(data.stores, archive, options.replace ? 'replace' : 'into-empty', data.userId),
    )
    recalcAllInstruments(data.recalc)
    return summary
  } finally {
    data.close()
  }
}

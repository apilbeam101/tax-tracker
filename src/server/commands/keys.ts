import type { DatabaseSync } from 'node:sqlite'
import { readSecret, validateStrongSecret } from '../config/secrets.ts'
import {
  hasUnattendedSlot,
  isEncryptedDatabase,
  removeUnattendedKey,
  rotateRecoveryKey,
  setUnattendedKey,
  unlockWithPassphrase,
} from '../crypto/keyslots.ts'
import { checkUnattendedKeyLocation } from './doctor.ts'
import { CliError, dataPaths, openExistingDb } from './util.ts'

export type PassphraseSource = () => Promise<string>

async function withUnlockedDb<T>(
  env: NodeJS.ProcessEnv,
  passphrase: PassphraseSource,
  fn: (db: DatabaseSync, dek: Buffer) => Promise<T> | T,
): Promise<T> {
  const { dbPath } = dataPaths(env)
  const db = openExistingDb(dbPath)
  let dek: Buffer | null = null
  try {
    if (!isEncryptedDatabase(db)) {
      throw new CliError('This database has no key slots. Encrypt it from the app first.')
    }
    dek = await unlockWithPassphrase(db, await passphrase())
    if (!dek) throw new CliError('That passphrase does not open this database.')
    return await fn(db, dek)
  } finally {
    dek?.fill(0)
    db.close()
  }
}

// The key comes from the same place the server reads it (ENCRYPTION_KEY or ENCRYPTION_KEY_FILE), so
// the value that creates the slot is exactly the one that later opens it, and it is never typed
// on a command line.
function readUnattendedKey(env: NodeJS.ProcessEnv): string {
  const errors: string[] = []
  const key = readSecret('ENCRYPTION_KEY', env, errors)
  if (key) validateStrongSecret('ENCRYPTION_KEY', key, errors)
  if (errors.length > 0) throw new CliError(errors.join('\n'))
  if (!key) {
    throw new CliError(
      'Set ENCRYPTION_KEY_FILE (or ENCRYPTION_KEY) to the key the deployment will supply, then run this again.',
    )
  }
  return key
}

export async function addUnattended(
  env: NodeJS.ProcessEnv,
  passphrase: PassphraseSource,
): Promise<string> {
  const key = readUnattendedKey(env)
  const location = checkUnattendedKeyLocation(env, dataPaths(env).dataDir)
  if (location.status === 'fail') throw new CliError(location.detail)

  return withUnlockedDb(env, passphrase, async (db, dek) => {
    const replacing = hasUnattendedSlot(db)
    await setUnattendedKey(db, dek, key)
    const done = replacing ? 'Unattended key replaced.' : 'Unattended key added.'
    return `${done} The server must be given this same key (ENCRYPTION_KEY or ENCRYPTION_KEY_FILE) from its next start, or it will refuse to start.`
  })
}

export async function removeUnattended(
  env: NodeJS.ProcessEnv,
  passphrase: PassphraseSource,
): Promise<string> {
  return withUnlockedDb(env, passphrase, (db) =>
    removeUnattendedKey(db) ? 'Unattended key removed.' : 'There was no unattended key.',
  )
}

export async function rotateRecovery(
  env: NodeJS.ProcessEnv,
  passphrase: PassphraseSource,
): Promise<string> {
  return withUnlockedDb(env, passphrase, (db, dek) => rotateRecoveryKey(db, dek))
}

import { readSecret, validateStrongSecret } from '../config/secrets.ts'
import { unlockWithPassphrase } from '../crypto/keyslots.ts'
import { type RotateResult, rotateDataKey } from '../crypto/rotate.ts'
import { ConflictError } from '../errors.ts'
import { createBackup } from '../services/backup/backups.ts'
import { claimDataDir } from './data-dir-lock.ts'
import { checkUnattendedKeyLocation } from './doctor.ts'
import type { PassphraseSource } from './keys.ts'
import { assertMigrated } from './open-data.ts'
import { CliError, dataPaths, openExistingDb } from './util.ts'

export interface RotateReport extends RotateResult {
  backup: string
}

// The unattended key the environment supplies, if any. rotateDataKey checks that it opens the
// existing slot before wrapping it around the new data key, and never creates a slot with it.
function unattendedKeyFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const errors: string[] = []
  const key = readSecret('ENCRYPTION_KEY', env, errors)
  if (key) validateStrongSecret('ENCRYPTION_KEY', key, errors)
  if (errors.length > 0) throw new CliError(errors.join('\n'))
  return key || undefined
}

/**
 * `tax-tracker keys rotate`: offline replacement of the data encryption key. Refuses while the app
 * is running and holds the data directory itself meanwhile. Needs the passphrase (not the recovery
 * key): it is wrapped around the new key, and must stay the one the sign-in page accepts.
 */
export async function runRotate(
  env: NodeJS.ProcessEnv,
  passphrase: PassphraseSource,
  options: { dropUnattended?: boolean } = {},
): Promise<RotateReport> {
  const { dbPath, dataDir } = dataPaths(env)
  const key = unattendedKeyFromEnv(env)
  if (key) {
    const location = checkUnattendedKeyLocation(env, dataDir)
    if (location.status === 'fail') throw new CliError(location.detail)
  }

  await claimDataDir(dataDir)
  const secret = await passphrase()
  const db = openExistingDb(dbPath)
  try {
    assertMigrated(db)
    // Checked before the backup is taken: pre-rotation backups are kept, and a mistyped passphrase
    // must not leave a full copy of the database behind each time.
    const check = await unlockWithPassphrase(db, secret)
    if (!check) throw new CliError('That passphrase does not open this database.')
    check.fill(0)
    const backup = await createBackup(db, dataDir, 'pre-rotation')
    try {
      const result = await rotateDataKey(db, {
        passphrase: secret,
        unattendedKey: key,
        dropUnattended: options.dropUnattended === true,
      })
      return { ...result, backup: backup.name }
    } catch (err) {
      if (err instanceof ConflictError) throw new CliError(err.message)
      throw err
    }
  } finally {
    db.close()
  }
}

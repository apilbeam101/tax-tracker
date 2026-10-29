import type { DatabaseSync } from 'node:sqlite'
import { isEncryptedDatabase } from '../src/server/crypto/keyslots.ts'

// These scripts read and write columns directly, with no way to unlock the database. Against an
// encrypted database they would write plaintext into encrypted columns, leaving rows the app
// can no longer read, so they stop instead.
export function refuseIfEncrypted(db: DatabaseSync, scriptName: string): void {
  if (!isEncryptedDatabase(db)) return
  console.error(
    `${scriptName} cannot run against an encrypted database: it has no way to unlock it. ` +
      'Use the application (Import / Export page) instead.',
  )
  db.close()
  process.exit(1)
}

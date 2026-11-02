import { join } from 'node:path'
import { createBackup } from '../services/backup/backups.ts'
import { dataPaths, openExistingDb } from './util.ts'

// Taking a backup copies ciphertext, so it needs no passphrase and works on a locked database.
export async function runBackup(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { dbPath, dataDir } = dataPaths(env)
  const db = openExistingDb(dbPath, { readOnly: true })
  try {
    const created = await createBackup(db, dataDir, 'manual')
    return join(dataDir, 'backups', created.name)
  } finally {
    db.close()
  }
}

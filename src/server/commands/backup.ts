import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { backup } from 'node:sqlite'
import { dataPaths, openExistingDb } from './util.ts'

// SQLite's backup API rather than a file copy: in WAL mode a plain copy can miss committed
// transactions that are still in the -wal file. Encrypted columns stay encrypted in the copy.
export async function runBackup(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { dbPath, dataDir } = dataPaths(env)
  const backupDir = join(dataDir, 'backups')
  mkdirSync(backupDir, { recursive: true })

  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '')
  const dest = join(backupDir, `taxtracker-${ts}.db`)

  const db = openExistingDb(dbPath, { readOnly: true })
  try {
    await backup(db, dest)
  } finally {
    db.close()
  }
  return dest
}

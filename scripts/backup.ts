/**
 * Database backup utility.
 * Usage: npm run backup
 * Writes a consistent snapshot of the live DB to <data dir>/backups/taxtracker-YYYY-MM-DDTHH-MM-SS.db
 *
 * Uses SQLite's backup API rather than copying the file: in WAL mode a plain file copy can miss
 * committed transactions that are still in the -wal file.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { resolveDataPaths } from '../src/server/config/paths.ts'

const { dbPath, dataDir } = resolveDataPaths()
const backupDir = join(dataDir, 'backups')
mkdirSync(backupDir, { recursive: true })

const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '')
const dest = join(backupDir, `taxtracker-${ts}.db`)

const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  await backup(db, dest)
} finally {
  db.close()
}
console.log(`Backup written to ${dest}`)

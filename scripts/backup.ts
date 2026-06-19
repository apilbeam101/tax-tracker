/**
 * Database backup utility.
 * Usage: npm run backup
 * Copies the live DB file to data/backups/taxtracker-YYYY-MM-DDTHH-MM-SS.db
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const dbPath = process.env['DB_PATH'] ?? './data/taxtracker.db'
const backupDir = join(dirname(dbPath), 'backups')
mkdirSync(backupDir, { recursive: true })

const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '')
const dest = join(backupDir, `taxtracker-${ts}.db`)

copyFileSync(dbPath, dest)
console.log(`Backup written to ${dest}`)

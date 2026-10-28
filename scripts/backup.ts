/**
 * Database backup utility.
 * Usage: npm run backup
 * Copies the live DB file to <data dir>/backups/taxtracker-YYYY-MM-DDTHH-MM-SS.db
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDataPaths } from '../src/server/config/paths.ts'

const { dbPath, dataDir } = resolveDataPaths()
const backupDir = join(dataDir, 'backups')
mkdirSync(backupDir, { recursive: true })

const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '')
const dest = join(backupDir, `taxtracker-${ts}.db`)

copyFileSync(dbPath, dest)
console.log(`Backup written to ${dest}`)

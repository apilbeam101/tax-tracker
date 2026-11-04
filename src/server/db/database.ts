/**
 * Database initialisation and migration runner.
 *
 * Uses the built-in node:sqlite module (Node >=24, no native addon).
 * WAL mode is enabled for concurrent reads during writes.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createBackup, listBackups } from '../services/backup/backups.ts'
import { applyPendingRestore } from '../services/backup/restore.ts'
import { listMigrationFiles, MIGRATIONS_DIR } from './migration-files.ts'

export type Db = DatabaseSync

/**
 * Open the database, enable WAL mode, and run any pending migrations.
 * Returns the open DatabaseSync instance to be shared across the process.
 */
export async function initDb(
  dbPath: string,
  options: { encryptionKey?: string | undefined } = {},
): Promise<Db> {
  // Ensure the data directory exists
  mkdirSync(dirname(dbPath), { recursive: true })

  // A restore staged through the app or the CLI is swapped in before the file is opened.
  if (dbPath !== ':memory:') {
    await applyPendingRestore(dbPath, console.warn, { encryptionKey: options.encryptionKey })
  }

  const db = new DatabaseSync(dbPath)

  // Enable WAL mode for concurrent reads
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  // Reasonable cache size (4 MB)
  db.exec('PRAGMA cache_size = -4000')
  // Synchronous = NORMAL is safe with WAL
  db.exec('PRAGMA synchronous = NORMAL')
  // Keep temp b-trees/sorters in memory rather than spilling to
  // SQLITE_TMPDIR/TMPDIR -- avoids depending on a writable temp directory
  // at all (e.g. under a read-only container filesystem).
  db.exec('PRAGMA temp_store = MEMORY')
  // Overwrite deleted content with zeros instead of leaving it in freed pages, so data removed
  // (or re-encrypted) stays removed. Per connection, hence set on every open.
  db.exec('PRAGMA secure_delete = ON')
  // Wait briefly for another connection's write lock instead of failing at once.
  db.exec('PRAGMA busy_timeout = 5000')

  await runMigrations(db, dbPath)
  return db
}

async function runMigrations(db: Db, dbPath: string): Promise<void> {
  // Bootstrap the migrations tracking table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      filename  TEXT    NOT NULL UNIQUE,
      applied_at TEXT   NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const applied = new Set(
    (
      db.prepare('SELECT filename FROM _migrations ORDER BY id').all() as Array<{
        filename: string
      }>
    ).map((r) => r.filename),
  )

  const files = listMigrationFiles()
  const pending = files.filter((f) => !applied.has(f))

  // The safety net for upgrading the app: an existing database is snapshotted before any
  // migration changes it. A brand-new database has nothing to protect.
  // A start that keeps failing (a bad migration, a crash loop) must not fill the disk with
  // copies, so a recent one is reused. If the copy cannot be made the app does not start: it
  // will not change a database it could not first protect.
  if (pending.length > 0 && applied.size > 0 && dbPath !== ':memory:') {
    const dataDir = dirname(dbPath)
    const latest = listBackups(dataDir).find((b) => b.reason === 'pre-migration')
    const recent = latest && Date.now() - new Date(latest.createdAt).getTime() < 10 * 60 * 1000
    if (!recent) await createBackup(db, dataDir, 'pre-migration')
  }

  for (const file of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8')

    // Run each migration in a transaction so partial failures are rolled back
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file)
      db.exec('COMMIT')
      console.log(`  ✓ migration: ${file}`)
    } catch (err) {
      // Guard the rollback — if the migration SQL caused an implicit commit
      // (or SQLite already rolled back internally), ROLLBACK itself will throw
      // and would mask the original error.
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore secondary rollback failure */
      }
      throw new Error(`Migration failed: ${file}\n${(err as Error).message}`)
    }
  }
}

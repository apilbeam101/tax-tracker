/**
 * Database initialisation and migration runner.
 *
 * Uses the built-in node:sqlite module (Node >=24, no native addon).
 * WAL mode is enabled for concurrent reads during writes.
 */

import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export type Db = DatabaseSync

/**
 * Open the database, enable WAL mode, and run any pending migrations.
 * Returns the open DatabaseSync instance to be shared across the process.
 */
export async function initDb(dbPath: string): Promise<Db> {
  // Ensure the data directory exists
  mkdirSync(dirname(dbPath), { recursive: true })

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

  await runMigrations(db)
  return db
}

async function runMigrations(db: Db): Promise<void> {
  // Bootstrap the migrations tracking table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      filename  TEXT    NOT NULL UNIQUE,
      applied_at TEXT   NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const migrationsDir = join(__dirname, 'migrations')
  const applied = new Set(
    (
      db.prepare('SELECT filename FROM _migrations ORDER BY id').all() as Array<{
        filename: string
      }>
    ).map((r) => r.filename),
  )

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort() // lexicographic — filename prefix 001_, 002_ etc. determines order

  for (const file of files) {
    if (applied.has(file)) continue

    const sql = readFileSync(join(migrationsDir, file), 'utf-8')

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

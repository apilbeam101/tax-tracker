import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations')

// A database (in memory unless a path is given) with every migration applied, in order. Tests
// use this rather than listing migration files by hand, so a new migration cannot leave them on
// an old schema.
export function createTestDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  // Recorded like the real runner does, so a backup taken from a test database validates.
  db.exec(
    "CREATE TABLE _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  )
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'))
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file)
  }
  return db
}

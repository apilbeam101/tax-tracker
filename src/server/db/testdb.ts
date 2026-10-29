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
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'))
  }
  return db
}

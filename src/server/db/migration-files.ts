import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

// Lexicographic order: the numeric filename prefix (001_, 002_ ...) decides the order.
export function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

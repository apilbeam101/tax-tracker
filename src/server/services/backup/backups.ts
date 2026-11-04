import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Db } from '../../db/database.ts'

export const BACKUP_DIRNAME = 'backups'
export const DEFAULT_BACKUP_KEEP = 14

export const BACKUP_REASONS = [
  'manual',
  'scheduled',
  'pre-migration',
  'pre-restore',
  'pre-import',
  'pre-rotation',
] as const
export type BackupReason = (typeof BACKUP_REASONS)[number]

// Only these are pruned. Anything taken before a change to the database is kept.
const PRUNABLE: readonly BackupReason[] = ['manual', 'scheduled']

const NAME_PATTERN = /^taxtracker-[\w.-]+\.db$/

export interface BackupInfo {
  name: string
  bytes: number
  createdAt: string
  reason: BackupReason | 'other'
}

export function backupDir(dataDir: string): string {
  return join(dataDir, BACKUP_DIRNAME)
}

function reasonOf(name: string): BackupReason | 'other' {
  for (const reason of BACKUP_REASONS) if (name.endsWith(`-${reason}.db`)) return reason
  return 'other'
}

// The upgrade's safety copy holds plaintext and has its own lifecycle (removed once the recovery
// key is confirmed), so it is neither listed nor offered for download or restore here.
function isListed(name: string): boolean {
  return NAME_PATTERN.test(name) && !name.endsWith('-pre-encryption.db')
}

export function listBackups(dataDir: string): BackupInfo[] {
  const dir = backupDir(dataDir)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const found: BackupInfo[] = []
  for (const name of names.filter(isListed)) {
    try {
      const stat = lstatSync(join(dir, name))
      if (!stat.isFile()) continue
      found.push({
        name,
        bytes: stat.size,
        createdAt: stat.mtime.toISOString(),
        reason: reasonOf(name),
      })
    } catch {
      /* vanished between listing and stat */
    }
  }
  return found.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name),
  )
}

// Resolves a name from a request to a path, only if it is one of the listed backups.
export function backupPath(dataDir: string, name: string): string | undefined {
  return isListed(name) && existsSync(join(backupDir(dataDir), name))
    ? join(backupDir(dataDir), name)
    : undefined
}

function verifyCopy(path: string): void {
  const copy = new DatabaseSync(path)
  try {
    // A copy of a WAL database is itself marked WAL; a plain rollback journal keeps it one file.
    copy.exec('PRAGMA journal_mode = DELETE')
    const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    if (check.integrity_check !== 'ok') throw new Error('the copy failed its integrity check')
  } finally {
    copy.close()
  }
}

// A consistent online snapshot (a plain file copy can miss commits still in the -wal file). It
// cannot run inside a transaction. The copy is checked before it takes its final name, so a listed backup is always
// one that passed. Encrypted columns stay encrypted; taking a backup does not need the key.
export async function createBackup(
  db: Db,
  dataDir: string,
  reason: BackupReason,
  options: { keep?: number } = {},
): Promise<BackupInfo> {
  const dir = backupDir(dataDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-').replace(/Z$/, '')
  const name = `taxtracker-${stamp}-${reason}.db`
  const final = join(dir, name)
  const partial = join(dir, `.${name}.partial`)
  try {
    // VACUUM INTO, not the backup API: the backup API restarts its copy every time another
    // connection writes to the source, so against a database that is busy (the offline CLI against a
    // running server, or the reverse) it can run for ever, whereas this reads one consistent
    // snapshot and, in WAL mode, writers carry on meanwhile. It runs synchronously, which for a
    // personal database is a fraction of a second. Encrypted values are copied as stored.
    db.prepare('VACUUM INTO ?').run(partial)
    verifyCopy(partial)
    try {
      chmodSync(partial, 0o600)
    } catch {
      /* not supported on every platform */
    }
    renameSync(partial, final)
  } catch (err) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(partial + suffix, { force: true })
    throw new Error(`Backup failed: ${(err as Error).message}`)
  }
  const stat = lstatSync(final)
  const info = { name, bytes: stat.size, createdAt: stat.mtime.toISOString(), reason }
  if (PRUNABLE.includes(reason)) pruneBackups(dataDir, options.keep ?? DEFAULT_BACKUP_KEEP, name)
  return info
}

// Manual and scheduled backups are kept in separate pools, so clicking "back up now" a few times
// cannot push out the daily history. Ordered by the timestamp in the name rather than file times,
// so a clock that moved backwards cannot make a new backup look like the oldest; the backup just
// taken is never removed.
export function pruneBackups(dataDir: string, keep: number, protect?: string): string[] {
  const removed: string[] = []
  for (const reason of PRUNABLE) {
    const pool = listBackups(dataDir)
      .filter((b) => b.reason === reason)
      .sort((a, b) => b.name.localeCompare(a.name))
    for (const old of pool.slice(keep)) {
      if (old.name === protect) continue
      rmSync(join(backupDir(dataDir), old.name), { force: true })
      removed.push(old.name)
    }
  }
  return removed
}

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  hasUnattendedSlot,
  isEncryptedDatabase,
  listSlots,
  unlockWithUnattendedKey,
} from '../../crypto/keyslots.ts'
import { listMigrationFiles } from '../../db/migration-files.ts'
import { BadRequestError, HttpError } from '../../errors.ts'
import { BACKUP_DIRNAME, createBackup } from './backups.ts'

export const PENDING_RESTORE = 'restore-pending.db'
const SQLITE_HEADER = 'SQLite format 3\u0000'

export interface BackupValidation {
  protected: boolean
  /** Fingerprint of the backup's data key; equal to the live database's when both share keys. */
  keyId: string | null
}

export interface RestoreOptions {
  /** The deployment's ENCRYPTION_KEY, if any: a restore it could not open at boot is refused. */
  encryptionKey?: string | undefined
  /** Runs just before the swap; throwing puts the staged file back and aborts. */
  beforeSwap?: (() => Promise<void> | void) | undefined
}

function hasSqliteHeader(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(SQLITE_HEADER.length)
    const read = readSync(fd, buf, 0, buf.length, 0)
    return read === buf.length && buf.toString('latin1') === SQLITE_HEADER
  } finally {
    closeSync(fd)
  }
}

function passphraseKeyId(db: DatabaseSync): string | null {
  const slot = listSlots(db).find((s) => s.slotType === 'passphrase')
  return slot?.keyId ?? null
}

// Checks a private copy of a backup. Opens it read-write (it is ours to modify, and a WAL-marked
// file cannot be opened read-only without its sidecar files) and leaves it as a single file. Any
// failure to read the file is a bad upload, never an internal error.
export function validateBackupFile(path: string): BackupValidation {
  if (!hasSqliteHeader(path)) throw new BadRequestError('That file is not a SQLite database')
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path)
  } catch {
    throw new BadRequestError('That file could not be opened as a database')
  }
  try {
    db.exec('PRAGMA journal_mode = DELETE')
    const check = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    if (check.integrity_check !== 'ok') {
      throw new BadRequestError('The backup failed its integrity check')
    }
    const hasMigrations = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_migrations'")
      .get()
    if (!hasMigrations) throw new BadRequestError('That file is not a Tax Tracker backup')

    const known = new Set(listMigrationFiles())
    const applied = db.prepare('SELECT filename FROM _migrations').all() as Array<{
      filename: string
    }>
    if (applied.some((m) => !known.has(m.filename))) {
      throw new BadRequestError(
        'That backup was made by a newer version of Tax Tracker. Upgrade the app, then restore it.',
      )
    }
    if (!db.prepare('SELECT 1 FROM tenant WHERE id = 1').get()) {
      throw new BadRequestError('That file is not a Tax Tracker backup')
    }

    if (!isEncryptedDatabase(db)) return { protected: false, keyId: null }

    const types = listSlots(db).map((s) => s.slotType)
    if (!types.includes('passphrase') || !types.includes('recovery')) {
      throw new BadRequestError(
        'The backup has damaged key slots (a passphrase and a recovery slot are required)',
      )
    }
    // Protected data with no account is a database nobody can sign in to.
    if (!db.prepare('SELECT 1 FROM "user" WHERE tenant_id = 1 LIMIT 1').get()) {
      throw new BadRequestError('The backup has key slots but no account to sign in with')
    }
    return { protected: true, keyId: passphraseKeyId(db) }
  } catch (err) {
    if (err instanceof HttpError) throw err
    // A file that is damaged or is not what it claims is the uploader's problem; a full disk or a
    // permissions error is ours and must not be reported as a bad file.
    if (isDamagedFile(err))
      throw new BadRequestError('That file is not a usable Tax Tracker backup')
    throw err
  } finally {
    db.close()
  }
}

const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26

// A file that SQLite itself says is damaged or not a database (as opposed to busy, read-only,
// out of space or unreadable).
export function isDamagedFile(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string }
  return (
    e.errcode === SQLITE_CORRUPT ||
    e.errcode === SQLITE_NOTADB ||
    /not a database|malformed|corrupt/i.test(e.message ?? '')
  )
}

interface LiveState {
  protected: boolean
  keyId: string | null
}

// A live file that is damaged is the very situation a restore exists for, so it counts as
// "nothing to protect" rather than blocking the recovery. Any other failure (busy, no permission)
// is not an answer and is raised.
function liveState(dbPath: string): LiveState {
  if (!existsSync(dbPath)) return { protected: false, keyId: null }
  try {
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      const encrypted = isEncryptedDatabase(db)
      return { protected: encrypted, keyId: encrypted ? passphraseKeyId(db) : null }
    } finally {
      db.close()
    }
  } catch (err) {
    if (isDamagedFile(err)) return { protected: false, keyId: null }
    throw err
  }
}

function assertNoDowngrade(live: LiveState, backup: BackupValidation): void {
  if (!backup.protected && live.protected) {
    throw new BadRequestError(
      'That backup has no key slots, so restoring it would replace your protected data with an unprotected copy',
    )
  }
}

// At boot an unattended ENCRYPTION_KEY must open the unattended slot or the app refuses to start.
// Swapping in a database that key cannot open would turn a restore into a restart loop.
async function assertKeyOpensBackup(path: string, options: RestoreOptions): Promise<void> {
  if (!options.encryptionKey) return
  const db = new DatabaseSync(path)
  try {
    if (!isEncryptedDatabase(db) || !hasUnattendedSlot(db)) return
    const dek = await unlockWithUnattendedKey(db, options.encryptionKey)
    if (!dek) {
      throw new BadRequestError(
        "This server's ENCRYPTION_KEY does not open the backup's unattended key slot, so the app would refuse to start after restoring it. Use the key that belongs to that backup, or remove the unattended slot there first.",
      )
    }
    dek.fill(0)
  } finally {
    db.close()
  }
}

function removeSidecars(path: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true })
}

function removeDatabaseFiles(path: string): void {
  rmSync(path, { force: true })
  removeSidecars(path)
}

export function pendingRestorePath(dataDir: string): string {
  return join(dataDir, PENDING_RESTORE)
}

export function hasPendingRestore(dataDir: string): boolean {
  return existsSync(pendingRestorePath(dataDir))
}

export function cancelPendingRestore(dataDir: string): boolean {
  const had = hasPendingRestore(dataDir)
  removeDatabaseFiles(pendingRestorePath(dataDir))
  return had
}

export interface StagedRestore extends BackupValidation {
  /** True when the backup shares the live database's data key; null if either has no key slots. */
  sameKeys: boolean | null
}

// Copies `source` beside the database, validates the copy, and leaves it as restore-pending.db
// for the next start (or the offline command) to swap in. The live database is not touched. A
// file that still has write-ahead-log content beside it is refused: copying only the main file
// would silently drop committed data.
export async function stageRestore(
  dbPath: string,
  source: string | Buffer,
  options: RestoreOptions = {},
): Promise<StagedRestore> {
  const dataDir = dirname(dbPath)
  const pending = pendingRestorePath(dataDir)
  // Unique per call: two uploads in flight must not share, and so overwrite, one file.
  const partial = `${pending}.${randomBytes(4).toString('hex')}.partial`
  try {
    if (typeof source === 'string') {
      if (existsSync(`${source}-wal`)) {
        throw new BadRequestError(
          'That file has a write-ahead log beside it (-wal), so a plain copy would miss data. Use a backup made by Tax Tracker.',
        )
      }
      copyFileSync(source, partial)
    } else {
      writeFileSync(partial, source, { mode: 0o600 })
    }
    const validation = validateBackupFile(partial)
    const live = liveState(dbPath)
    assertNoDowngrade(live, validation)
    await assertKeyOpensBackup(partial, options)
    removeDatabaseFiles(pending)
    renameSync(partial, pending)
    return {
      ...validation,
      sameKeys: validation.keyId && live.keyId ? validation.keyId === live.keyId : null,
    }
  } finally {
    removeDatabaseFiles(partial)
  }
}

export interface RestoreResult {
  applied: boolean
  reason?: string
  safetyBackup?: string
}

const APPLYING_RESTORE = 'restore-applying.db'
const STALE_CLAIM_MS = 5 * 60 * 1000

// Swaps a staged restore in. Runs before the database is opened (at start, or from the offline
// command). It first claims the staged file by renaming it, so two processes cannot both apply it.
// The current database is then backed up and checkpointed, so nothing it still holds in its
// write-ahead log is lost and the swap only replaces one complete file with another. Raw file
// copies are made only when SQLite says the file is damaged; a database that is merely busy or
// unreadable puts the staged file back to be retried. A staged file that does not validate, or a
// swap that fails, is set aside in backups/ so a failure cannot repeat on every start.
export async function applyPendingRestore(
  dbPath: string,
  log: (message: string) => void = console.warn,
  options: RestoreOptions = {},
): Promise<RestoreResult | null> {
  const dataDir = dirname(dbPath)
  const pending = pendingRestorePath(dataDir)
  const applying = join(dataDir, APPLYING_RESTORE)

  // A claimed file left by an attempt that was interrupted (a crash between claiming and finishing)
  // goes back in the queue once it is clearly not being worked on: the claim time is its mtime.
  if (!existsSync(pending) && existsSync(applying)) {
    const claimedAt = statSync(applying).mtimeMs
    if (Date.now() - claimedAt > STALE_CLAIM_MS) renameSync(applying, pending)
  }
  if (!existsSync(pending)) return null
  try {
    renameSync(pending, applying)
    const now = new Date()
    utimesSync(applying, now, now)
  } catch {
    return null
  }

  const unclaim = (reason: string): RestoreResult => {
    renameSync(applying, pending)
    log(`Restore postponed: ${reason}.`)
    return { applied: false, reason }
  }

  const reject = (reason: string): RestoreResult => {
    // In the backups folder so a plaintext copy is listed with the others, not left unseen. If
    // even that fails the file is kept beside the database or, as a last resort, dropped: the
    // user still has the file they uploaded, and the one thing this must not do is throw and make
    // every start fail the same way.
    let kept: string | undefined
    try {
      mkdirSync(join(dataDir, BACKUP_DIRNAME), { recursive: true, mode: 0o700 })
      kept = join(dataDir, BACKUP_DIRNAME, `taxtracker-${Date.now()}-rejected-restore.db`)
      renameSync(applying, kept)
    } catch {
      try {
        kept = join(dataDir, 'restore-rejected.db')
        renameSync(applying, kept)
      } catch {
        kept = undefined
        rmSync(applying, { force: true })
      }
    }
    log(
      `Restore not applied: ${reason}. ${kept ? `The staged file was kept as ${kept}.` : 'The staged file was discarded.'}`,
    )
    return { applied: false, reason }
  }

  try {
    const validation = validateBackupFile(applying)
    assertNoDowngrade(liveState(dbPath), validation)
    await assertKeyOpensBackup(applying, options)
  } catch (err) {
    return reject((err as Error).message)
  }

  let safetyBackup: string | undefined
  if (existsSync(dbPath)) {
    try {
      const current = new DatabaseSync(dbPath)
      try {
        current.exec('PRAGMA busy_timeout = 5000')
        safetyBackup = (await createBackup(current, dataDir, 'pre-restore')).name
        current.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } finally {
        current.close()
      }
    } catch (err) {
      if (!isDamagedFile(err)) {
        return unclaim(
          `the current database could not be read or backed up (${(err as Error).message}); stop the app and try again`,
        )
      }
      const raw = join(dataDir, BACKUP_DIRNAME, `taxtracker-${Date.now()}-raw-pre-restore.db`)
      try {
        mkdirSync(join(dataDir, BACKUP_DIRNAME), { recursive: true, mode: 0o700 })
        copyFileSync(dbPath, raw)
        if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${raw}-wal`)
        safetyBackup = raw
      } catch (copyError) {
        return reject(
          `the current database could not be backed up (${(copyError as Error).message})`,
        )
      }
    }
  }

  try {
    // The offline command re-checks for a running server here, after the slow steps above.
    await options.beforeSwap?.()
  } catch (err) {
    renameSync(applying, pending)
    throw err
  }

  try {
    removeSidecars(dbPath)
    renameSync(applying, dbPath)
  } catch (err) {
    return reject(`the database file could not be replaced (${(err as Error).message})`)
  }
  log(
    `Restored the staged backup.${safetyBackup ? ` Previous database kept as ${safetyBackup}.` : ''}`,
  )
  return { applied: true, ...(safetyBackup ? { safetyBackup } : {}) }
}

import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import type { Db } from '../db/database.ts'
import { ConflictError } from '../errors.ts'
import { createRowCodec } from '../repositories/sqlite/rowcodec.ts'
import { createFieldCipher, encryptedColumns, FIELD_REGISTRY, isSealed } from './fields.ts'
import { Keyring } from './keyring.ts'
import {
  hasKeySlots,
  insertInitialSlots,
  isEncryptedDatabase,
  type KeySlotOptions,
  prepareInitialSlots,
} from './keyslots.ts'

export const ALREADY_ENCRYPTED = 'This database is already encrypted'
export const ALREADY_ENCRYPTED_CODE = 'ALREADY_ENCRYPTED'
const PRE_ENCRYPTION_SUFFIX = '-pre-encryption.db'
const SEALED_PREFIX = 'v1.'

export interface UpgradeOptions extends KeySlotOptions {
  passphrase: string
  /** Also creates the unattended slot. Only passed when the user explicitly opted in. */
  unattendedKey?: string | undefined
  backupDir: string
  /** Default true. Tests turn it off to show what the scrub is for. */
  scrub?: boolean
  /**
   * Runs inside the transaction, just before it commits. Throwing aborts the upgrade. Lets the
   * caller re-check anything it verified before the (asynchronous) preparation, such as that the
   * login passphrase has not changed in the meantime.
   */
  beforeCommit?: () => void
}

export interface UpgradeResult {
  recoveryKey: string
  keyId: string
  backupPath: string
  rowsEncrypted: number
  /** False if the post-upgrade clean-up did not complete; it is retried at the next start. */
  scrubbed: boolean
}

function tablesWithEncryptedColumns(): string[] {
  return Object.keys(FIELD_REGISTRY).filter((table) => encryptedColumns(table).length > 0)
}

// Events in the audit log (plaintext columns only) that carry the state of the upgrade across
// restarts, so it does not depend on which files happen to be on disk.
const EVENT = {
  encrypted: 'database.encrypted',
  scrubPending: 'database.scrub_pending',
  scrubDone: 'database.scrub_done',
  recoveryRotated: 'key_slot.recovery.rotate',
  recoveryConfirmed: 'recovery_key.confirmed',
} as const

function recordEvent(db: Db, action: string): void {
  db.prepare(
    "INSERT INTO audit_log (tenant_id, user_id, action, entity_type) VALUES (1, NULL, ?, 'database')",
  ).run(action)
}

function latestEvent(db: Db, actions: readonly string[]): string | undefined {
  const placeholders = actions.map(() => '?').join(', ')
  const row = db
    .prepare(
      `SELECT action FROM audit_log WHERE action IN (${placeholders}) ORDER BY id DESC LIMIT 1`,
    )
    .get(...actions) as { action: string } | undefined
  return row?.action
}

// A SQLite database may have sidecar files; removing only the main file would leave them.
function removeDatabaseFile(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true })
}

function assertNotAlreadyEncrypted(db: Db): void {
  if (hasKeySlots(db)) throw new ConflictError(ALREADY_ENCRYPTED, ALREADY_ENCRYPTED_CODE)
  for (const table of tablesWithEncryptedColumns()) {
    for (const column of encryptedColumns(table)) {
      const candidates = db
        .prepare(`SELECT ${column} AS value FROM ${table} WHERE ${column} LIKE ?`)
        .all(`${SEALED_PREFIX}%`) as Array<{ value: unknown }>
      if (candidates.some((c) => isSealed(c.value))) {
        throw new ConflictError(
          `Refusing to upgrade: ${table}.${column} already holds encrypted values but there are no key slots to open them`,
        )
      }
    }
  }
}

async function writePreEncryptionBackup(db: Db, backupDir: string): Promise<string> {
  // The copy holds everything in the clear, so keep it private to the owner where the platform
  // supports it.
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '')
  // The random part keeps two upgrades started in the same second from sharing (and one of them
  // deleting) a single safety copy.
  const path = join(
    backupDir,
    `taxtracker-${stamp}-${randomBytes(3).toString('hex')}${PRE_ENCRYPTION_SUFFIX}`,
  )
  try {
    await backup(db, path)
    try {
      chmodSync(path, 0o600)
    } catch {
      /* not supported on every platform */
    }
    const copy = new DatabaseSync(path)
    try {
      // A copy of a WAL database is itself marked WAL, and opening it would leave -wal and -shm
      // files beside it. Switching it to a plain rollback journal keeps it a single file.
      copy.exec('PRAGMA journal_mode = DELETE')
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      if (check.integrity_check !== 'ok') throw new Error('the copy failed its integrity check')
    } finally {
      copy.close()
    }
  } catch (err) {
    removeDatabaseFile(path)
    throw new Error(
      `Could not make the safety copy needed before encrypting: ${(err as Error).message}`,
    )
  }
  return path
}

const stringOrNull = (value: unknown): string | null => (value === null ? null : String(value))

// Seals every encrypted column of every row in place, then reads each row back through the same
// codec and compares it with what was there before. Returns the number of rows rewritten.
function rewriteAll(db: Db, cipher: ReturnType<typeof createFieldCipher>): number {
  let rows = 0
  for (const table of tablesWithEncryptedColumns()) {
    const columns = encryptedColumns(table)
    const codec = createRowCodec(cipher, table)
    const extra = table === 'instrument' ? ', tenant_id' : ''
    const originals = db
      .prepare(`SELECT id, ${columns.join(', ')}${extra} FROM ${table}`)
      .all() as Array<Record<string, unknown>>

    for (const original of originals) {
      const id = Number(original.id)
      const values = Object.fromEntries(
        columns.map((c) => [c, original[c] as string | number | null]),
      )
      const sealed = codec.seal(id, values)
      const assignments = Object.keys(sealed).map((c) => `${c} = ?`)
      const params = Object.values(sealed)
      if (table === 'instrument') {
        // The blind index goes in the same UPDATE as the sealed ticker: once key slots exist, a
        // trigger refuses an instrument row without one.
        assignments.push('ticker_bidx = ?')
        params.push(
          cipher.blindIndex(
            'instrument',
            'ticker',
            Number(original.tenant_id),
            String(original.ticker),
          ),
        )
      }
      db.prepare(`UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ?`).run(...params, id)
      rows++
    }

    for (const original of originals) {
      const id = Number(original.id)
      const stored = db
        .prepare(`SELECT id, ${columns.join(', ')} FROM ${table} WHERE id = ?`)
        .get(id) as Record<string, unknown>
      const opened = codec.open(stored)
      for (const column of columns) {
        if (stringOrNull(opened[column]) !== stringOrNull(original[column])) {
          throw new Error(`Verification failed for ${table}.${column} row ${id}`)
        }
      }
    }
  }
  return rows
}

/**
 * Encrypts an existing, unprotected database in place: creates the key slots, seals every
 * classified column and builds the blind indexes, all in one transaction that is verified before
 * it commits, so an interruption or failure leaves the database exactly as it was. Afterwards the
 * keyring switches to encrypting and the old plaintext is scrubbed from freed pages and the WAL.
 *
 * A copy of the database is written first (and kept until the caller removes it): it is the
 * restore point if anything about the result is wrong, and it is plaintext, so it must not be
 * left around once the user has confirmed their recovery key.
 */
export async function upgradeToEncrypted(
  db: Db,
  keyring: Keyring,
  options: UpgradeOptions,
): Promise<UpgradeResult> {
  if (keyring.isProtected) throw new ConflictError(ALREADY_ENCRYPTED, ALREADY_ENCRYPTED_CODE)
  assertNotAlreadyEncrypted(db)

  // The slow key derivation comes first and the safety copy second, so the copy is as close as
  // possible to the state that is then encrypted.
  const prepared = await prepareInitialSlots(options.passphrase, {
    ...(options.passphraseKdf ? { passphraseKdf: options.passphraseKdf } : {}),
    unattendedKey: options.unattendedKey,
  })
  let backupPath: string
  try {
    backupPath = await writePreEncryptionBackup(db, options.backupDir)
  } catch (err) {
    prepared.dek.fill(0)
    throw err
  }

  // Everything from the BEGIN to keyring.protect() is synchronous, so no request can write a
  // plaintext row between the commit and the moment the stores start encrypting.
  const rowKeyring = new Keyring({ protected: true })
  const working = Buffer.alloc(prepared.dek.length)
  prepared.dek.copy(working)
  rowKeyring.unlock(working)
  let rowsEncrypted: number
  let began = false
  try {
    db.exec('PRAGMA secure_delete = ON')
    db.exec('BEGIN IMMEDIATE')
    began = true
    assertNotAlreadyEncrypted(db)
    insertInitialSlots(db, prepared.slots)
    rowsEncrypted = rewriteAll(db, createFieldCipher(rowKeyring))
    recordEvent(db, EVENT.encrypted)
    recordEvent(db, EVENT.scrubPending)
    options.beforeCommit?.()
    try {
      db.exec('COMMIT')
    } catch (commitError) {
      // An I/O error on COMMIT can still have landed. If the key slots are there, the data is
      // encrypted and the user must be given the recovery key, not told it failed.
      if (!hasKeySlots(db)) throw commitError
    }
  } catch (err) {
    if (began) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore secondary rollback failure */
      }
    }
    prepared.dek.fill(0)
    rowKeyring.destroy()
    removeDatabaseFile(backupPath)
    throw err
  }
  rowKeyring.destroy()
  keyring.protect(prepared.dek, { permanent: Boolean(options.unattendedKey) })

  const scrubbed = options.scrub === false ? false : scrubAndRecord(db)

  return {
    recoveryKey: prepared.recoveryKey,
    keyId: prepared.keyId,
    backupPath,
    rowsEncrypted,
    scrubbed,
  }
}

/**
 * Removes superseded plaintext from the database file and its write-ahead log: checkpoint, rebuild
 * the file (VACUUM), checkpoint again. Returns false unless every step demonstrably completed:
 * a checkpoint that was blocked by another reader does not throw, it reports "busy", and is
 * treated as a failure here.
 */
export function scrubDatabase(db: Db): boolean {
  const truncated = () => {
    const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
      | { busy: number; log: number }
      | undefined
    // In a database that is not in WAL mode the pragma returns -1 for the frame counts.
    return result !== undefined && result.busy === 0 && result.log <= 0
  }
  try {
    if (!truncated()) return false
    db.exec('VACUUM')
    if (!truncated()) return false
    const free = db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }
    return free.freelist_count === 0
  } catch {
    return false
  }
}

function scrubAndRecord(db: Db): boolean {
  const done = scrubDatabase(db)
  if (done) {
    try {
      recordEvent(db, EVENT.scrubDone)
    } catch {
      // The clean-up did happen; failing to note it only means it is repeated at the next start.
    }
  }
  return done
}

/**
 * Retries a scrub that did not complete after an upgrade (for example because the disk was full
 * or another program had the file open). Returns null when nothing was pending, else whether the
 * retry completed.
 */
export function scrubIfPending(db: Db): boolean | null {
  if (latestEvent(db, [EVENT.scrubPending, EVENT.scrubDone]) !== EVENT.scrubPending) return null
  return scrubAndRecord(db)
}

/**
 * True from the upgrade (or a recovery-key rotation) until the user has typed the current
 * recovery key back. Tracked in the audit log rather than by the presence of the safety copy, so
 * deleting that file cannot hide a recovery key the user never saw.
 */
export function recoveryKeyNeedsConfirmation(db: Db): boolean {
  const latest = latestEvent(db, [EVENT.encrypted, EVENT.recoveryRotated, EVENT.recoveryConfirmed])
  return latest === EVENT.encrypted || latest === EVENT.recoveryRotated
}

export function recordRecoveryKeyConfirmed(db: Db): void {
  recordEvent(db, EVENT.recoveryConfirmed)
}

export function listPreEncryptionBackups(backupDir: string): string[] {
  try {
    return readdirSync(backupDir).filter((f) => f.endsWith(PRE_ENCRYPTION_SUFFIX))
  } catch {
    return []
  }
}

export function removePreEncryptionBackups(backupDir: string): string[] {
  const removed = listPreEncryptionBackups(backupDir)
  for (const name of removed) removeDatabaseFile(join(backupDir, name))
  return removed
}

export interface PlaintextCopy {
  name: string
  location: 'backups' | 'data'
  bytes: number
}

// A database file counts as plaintext unless it can be opened and is seen to have key slots. A
// file that cannot be read at all is reported rather than assumed safe.
function holdsPlaintext(path: string): boolean {
  try {
    const copy = new DatabaseSync(path, { readOnly: true })
    try {
      return !isEncryptedDatabase(copy)
    } finally {
      copy.close()
    }
  } catch {
    return true
  }
}

/**
 * Copies of the database that hold the data unencrypted: backup-script output and manual `.bak`
 * files, other leftover safety copies, and Ghostfolio exports. Backups made after encryption (which
 * carry key slots) are not listed. Never throws: an unreadable entry is skipped, not fatal.
 */
export function listPlaintextCopies(
  dataDir: string,
  backupDir: string,
  options: { exceptSafetyCopy?: string } = {},
): PlaintextCopy[] {
  const found: PlaintextCopy[] = []
  const scan = (
    dir: string,
    location: PlaintextCopy['location'],
    keep: (name: string) => boolean,
    isPlaintext: (path: string) => boolean,
  ) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names.filter(keep)) {
      try {
        const path = join(dir, name)
        const stat = lstatSync(path)
        if (stat.isFile() && isPlaintext(path)) found.push({ name, location, bytes: stat.size })
      } catch {
        /* vanished or unreadable between listing and stat */
      }
    }
  }
  scan(
    backupDir,
    'backups',
    (n) => n.endsWith('.db') && n !== options.exceptSafetyCopy,
    holdsPlaintext,
  )
  scan(dataDir, 'data', (n) => /^taxtracker\.db\.bak/.test(n), holdsPlaintext)
  scan(
    dataDir,
    'data',
    (n) => /^ghostfolio-export.*\.json$/.test(n),
    () => true,
  )
  return found
}

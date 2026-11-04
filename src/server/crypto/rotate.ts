import type { Db } from '../db/database.ts'
import { ConflictError } from '../errors.ts'
import { createRowCodec } from '../repositories/sqlite/rowcodec.ts'
import { createFieldCipher, encryptedColumns } from './fields.ts'
import { Keyring } from './keyring.ts'
import {
  insertInitialSlots,
  isEncryptedDatabase,
  type KeySlotOptions,
  keyIdOf,
  prepareInitialSlots,
  unlockWithPassphrase,
  unlockWithUnattendedKey,
} from './keyslots.ts'
import { recordKeyRotation, scrubAndRecord, tablesWithEncryptedColumns } from './upgrade.ts'

export interface RotateOptions extends KeySlotOptions {
  /** The current passphrase: it opens the old key and is wrapped around the new one. */
  passphrase: string
  /**
   * The deployment's current ENCRYPTION_KEY. If an unattended slot exists it must open it, and it is
   * wrapped around the new key. It never creates a slot that did not exist.
   */
  unattendedKey?: string | undefined
  /** Required to rotate when an unattended slot exists and no key is supplied: the slot is removed. */
  dropUnattended?: boolean
  /** Runs inside the transaction just before it commits; throwing rolls everything back. */
  beforeCommit?: () => void
  /** Default true. Tests turn it off to look at the file as the transaction left it. */
  scrub?: boolean
}

export interface RotateResult {
  recoveryKey: string
  keyId: string
  previousKeyId: string
  rowsRewritten: number
  unattendedSlot: 'kept' | 'dropped' | 'none'
  /** False if the post-rotation clean-up did not complete; it is retried at the next start. */
  scrubbed: boolean
}

function keyringFor(dek: Buffer): Keyring {
  const keyring = new Keyring({ protected: true })
  keyring.unlock(Buffer.from(dek))
  return keyring
}

const asText = (value: unknown): string | null => (value === null ? null : String(value))

// Re-seals every encrypted column of every row under the new key, and reads each row back through
// the new key to compare it with what the old key gave. Returns how many rows were rewritten.
function resealAll(db: Db, from: Keyring, to: Keyring): number {
  const oldCipher = createFieldCipher(from)
  const newCipher = createFieldCipher(to)
  let rows = 0
  for (const table of tablesWithEncryptedColumns()) {
    const columns = encryptedColumns(table)
    const extra = table === 'instrument' ? ', tenant_id' : ''
    const oldCodec = createRowCodec(oldCipher, table)
    const newCodec = createRowCodec(newCipher, table)
    const stored = db
      .prepare(`SELECT id, ${columns.join(', ')}${extra} FROM ${table}`)
      .all() as Array<Record<string, unknown>>

    const plain = stored.map((row) => oldCodec.open(row))
    for (const [i, row] of plain.entries()) {
      const id = Number(row.id)
      const sealed = newCodec.seal(
        id,
        Object.fromEntries(columns.map((c) => [c, row[c] as string | number | null])),
      )
      const assignments = Object.keys(sealed).map((c) => `${c} = ?`)
      const params = Object.values(sealed)
      if (table === 'instrument') {
        // Same UPDATE as the sealed ticker: the trigger from migration 007 refuses a row without it.
        assignments.push('ticker_bidx = ?')
        params.push(
          newCipher.blindIndex(
            'instrument',
            'ticker',
            Number(stored[i]?.tenant_id),
            String(row.ticker),
          ),
        )
      }
      db.prepare(`UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ?`).run(...params, id)
      rows++
    }

    for (const row of plain) {
      const id = Number(row.id)
      const back = newCodec.open(
        db.prepare(`SELECT id, ${columns.join(', ')} FROM ${table} WHERE id = ?`).get(id) as {
          id: number
        },
      ) as Record<string, unknown>
      for (const column of columns) {
        if (asText(back[column]) !== asText(row[column])) {
          throw new Error(`Verification failed for ${table}.${column} row ${id}`)
        }
      }
    }
  }
  return rows
}

/**
 * Replaces the data encryption key. Opens the old key with the passphrase, then in one transaction
 * re-seals every encrypted column under a new key, rebuilds the blind index and replaces the key
 * slots (passphrase re-wrapped, a new recovery key, the unattended key if the caller still has it).
 * Everything is verified by reading it back before the commit, so a failure or interruption leaves
 * the database exactly as it was. The old ciphertext is then scrubbed from free pages and the WAL.
 *
 * The caller must hold the database exclusively (no running server) and should take a backup first.
 */
export async function rotateDataKey(db: Db, options: RotateOptions): Promise<RotateResult> {
  if (!isEncryptedDatabase(db)) {
    throw new ConflictError('This database has no key slots, so there is no key to rotate')
  }
  const hadUnattended =
    db.prepare("SELECT 1 FROM key_slot WHERE slot_type = 'unattended'").get() !== undefined

  const oldDek = await unlockWithPassphrase(db, options.passphrase)
  if (!oldDek)
    throw new ConflictError('That passphrase does not open this database', 'WRONG_PASSPHRASE')

  // The unattended slot is what lets the server start without anyone signing in, and a server whose
  // ENCRYPTION_KEY does not open it refuses to start. So an existing slot is only carried over with
  // the key that really opens it, a slot is never created here, and dropping one is explicit.
  let keepUnattendedKey: string | undefined
  try {
    if (hadUnattended) {
      if (options.unattendedKey) {
        const current = await unlockWithUnattendedKey(db, options.unattendedKey)
        if (!current) {
          throw new ConflictError(
            'ENCRYPTION_KEY does not open the existing unattended key slot, so the server would refuse to start after the rotation. Use the key the server is configured with.',
            'WRONG_UNATTENDED_KEY',
          )
        }
        current.fill(0)
        keepUnattendedKey = options.unattendedKey
      } else if (!options.dropUnattended) {
        throw new ConflictError(
          'An unattended key slot exists. Supply its key (ENCRYPTION_KEY or ENCRYPTION_KEY_FILE) to keep it, or confirm that it should be removed.',
          'UNATTENDED_KEY_NEEDED',
        )
      }
    }
  } catch (err) {
    oldDek.fill(0)
    throw err
  }

  // The slow key derivation comes before the transaction, so the write lock is held briefly.
  let prepared: Awaited<ReturnType<typeof prepareInitialSlots>>
  try {
    prepared = await prepareInitialSlots(options.passphrase, {
      ...(options.passphraseKdf ? { passphraseKdf: options.passphraseKdf } : {}),
      unattendedKey: keepUnattendedKey,
    })
  } catch (err) {
    oldDek.fill(0)
    throw err
  }
  const previousKeyId = keyIdOf(oldDek)
  const from = keyringFor(oldDek)
  const to = keyringFor(prepared.dek)
  let rowsRewritten: number
  let began = false
  try {
    db.exec('PRAGMA secure_delete = ON')
    db.exec('BEGIN IMMEDIATE')
    began = true
    rowsRewritten = resealAll(db, from, to)
    db.exec('DELETE FROM key_slot WHERE tenant_id = 1')
    insertInitialSlots(db, prepared.slots)
    recordKeyRotation(db)
    options.beforeCommit?.()
    try {
      db.exec('COMMIT')
    } catch (commitError) {
      // An I/O error on COMMIT can still have landed. If the slots now carry the new key id the
      // rotation happened and the user must be given the new recovery key, not told it failed.
      const landed = db
        .prepare("SELECT key_id FROM key_slot WHERE tenant_id = 1 AND slot_type = 'passphrase'")
        .get() as { key_id: string } | undefined
      if (landed?.key_id !== prepared.keyId) throw commitError
    }
  } catch (err) {
    if (began && db.isTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore secondary rollback failure */
      }
    }
    throw err
  } finally {
    from.destroy()
    to.destroy()
    oldDek.fill(0)
    prepared.dek.fill(0)
  }

  return {
    recoveryKey: prepared.recoveryKey,
    keyId: prepared.keyId,
    previousKeyId,
    rowsRewritten,
    unattendedSlot: !hadUnattended ? 'none' : keepUnattendedKey ? 'kept' : 'dropped',
    scrubbed: options.scrub === false ? false : scrubAndRecord(db),
  }
}

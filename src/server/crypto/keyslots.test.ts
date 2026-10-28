import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { ConflictError, NotFoundError } from '../errors.ts'
import type { Argon2idParams } from './kdf.ts'
import {
  applySlot,
  changePassphrase,
  createKeySlots,
  hasKeySlots,
  hasUnattendedSlot,
  keyIdOf,
  listSlots,
  preparePassphraseSlot,
  removeUnattendedKey,
  resetPassphraseWithRecoveryKey,
  rotateRecoveryKey,
  setUnattendedKey,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  unlockWithUnattendedKey,
} from './keyslots.ts'
import { formatRecoveryKey, InvalidRecoveryKeyError } from './recovery.ts'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'db', 'migrations')
const FAST: { passphraseKdf: Argon2idParams } = {
  passphraseKdf: { kdf: 'argon2id', memoryKiB: 64, timeCost: 1, parallelism: 1 },
}
const PASSPHRASE = 'a reasonably long passphrase'
const UNATTENDED = 'f'.repeat(64)

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'))
  }
  return db
}

function dumpDb(db: DatabaseSync): string {
  const rows = db.prepare('SELECT * FROM key_slot').all()
  return JSON.stringify(rows)
}

let db: DatabaseSync

beforeEach(() => {
  db = setupDb()
})

describe('createKeySlots', () => {
  it('creates a passphrase and a recovery slot sharing one key id', async () => {
    const { dek, keyId, recoveryKey } = await createKeySlots(db, PASSPHRASE, FAST)
    expect(dek.length).toBe(32)
    expect(keyId).toBe(keyIdOf(dek))
    expect(recoveryKey).toMatch(/^([0-9A-Z]{5}-){10}[0-9A-Z]{5}$/)
    expect(hasKeySlots(db)).toBe(true)
    expect(listSlots(db).map((s) => [s.slotType, s.keyId])).toEqual([
      ['passphrase', keyId],
      ['recovery', keyId],
    ])
  })

  it('refuses to run twice', async () => {
    await createKeySlots(db, PASSPHRASE, FAST)
    await expect(createKeySlots(db, 'another passphrase', FAST)).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  it('never stores the DEK, the recovery key or the passphrase in a readable form', async () => {
    const { dek, recoveryKey } = await createKeySlots(db, PASSPHRASE, FAST)
    const dump = dumpDb(db)
    expect(dump).not.toContain(dek.toString('hex'))
    expect(dump).not.toContain(dek.toString('base64url'))
    expect(dump).not.toContain(dek.toString('base64'))
    expect(dump).not.toContain(recoveryKey.replace(/-/g, ''))
    expect(dump).not.toContain(PASSPHRASE)
  })

  it('writes both slots or neither', async () => {
    db.exec(`CREATE TRIGGER fail_recovery BEFORE INSERT ON key_slot
             WHEN NEW.slot_type = 'recovery' BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    await expect(createKeySlots(db, PASSPHRASE, FAST)).rejects.toThrow(/boom/)
    expect(hasKeySlots(db)).toBe(false)
    expect(listSlots(db)).toEqual([])
    expect(db.isTransaction).toBe(false)
  })

  it('does not hold a transaction open across the argon2 await', async () => {
    const pending = createKeySlots(db, PASSPHRASE, FAST)
    expect(db.isTransaction).toBe(false)
    await pending
    expect(db.isTransaction).toBe(false)
  })

  it('works with the production argon2id parameters', async () => {
    const { dek } = await createKeySlots(db, PASSPHRASE)
    const unlocked = await unlockWithPassphrase(db, PASSPHRASE)
    expect(unlocked?.equals(dek)).toBe(true)
    const params = JSON.parse(
      (
        db.prepare("SELECT kdf_params FROM key_slot WHERE slot_type = 'passphrase'").get() as {
          kdf_params: string
        }
      ).kdf_params,
    )
    expect(params).toMatchObject({ kdf: 'argon2id', memoryKiB: 65536, timeCost: 3 })
  })
})

describe('unlocking', () => {
  it('unlocks with the passphrase and rejects a wrong one', async () => {
    const { dek } = await createKeySlots(db, PASSPHRASE, FAST)
    expect((await unlockWithPassphrase(db, PASSPHRASE))?.equals(dek)).toBe(true)
    expect(await unlockWithPassphrase(db, 'wrong passphrase')).toBeNull()
    expect(await unlockWithPassphrase(db, '')).toBeNull()
  })

  it('unlocks with the recovery key, tolerating how the user retyped it', async () => {
    const { dek, recoveryKey } = await createKeySlots(db, PASSPHRASE, FAST)
    expect((await unlockWithRecoveryKey(db, recoveryKey))?.equals(dek)).toBe(true)
    const retyped = recoveryKey.toLowerCase().replace(/-/g, ' ')
    expect((await unlockWithRecoveryKey(db, retyped))?.equals(dek)).toBe(true)
  })

  it('distinguishes a mistyped recovery key from a well-formed wrong one', async () => {
    const { recoveryKey } = await createKeySlots(db, PASSPHRASE, FAST)
    const mistyped = (recoveryKey[0] === '0' ? '1' : '0') + recoveryKey.slice(1)
    await expect(unlockWithRecoveryKey(db, mistyped)).rejects.toBeInstanceOf(
      InvalidRecoveryKeyError,
    )
    const wrong = formatRecoveryKey(Buffer.alloc(32, 5))
    expect(await unlockWithRecoveryKey(db, wrong)).toBeNull()
  })

  it('returns null, not an error, when no slots exist', async () => {
    expect(await unlockWithPassphrase(db, PASSPHRASE)).toBeNull()
    expect(await unlockWithUnattendedKey(db, UNATTENDED)).toBeNull()
  })

  it('reaches the same DEK through every slot', async () => {
    const { dek, recoveryKey } = await createKeySlots(db, PASSPHRASE, FAST)
    await setUnattendedKey(db, dek, UNATTENDED)
    const viaPassphrase = await unlockWithPassphrase(db, PASSPHRASE)
    const viaRecovery = await unlockWithRecoveryKey(db, recoveryKey)
    const viaUnattended = await unlockWithUnattendedKey(db, UNATTENDED)
    expect(viaPassphrase?.equals(dek)).toBe(true)
    expect(viaRecovery?.equals(dek)).toBe(true)
    expect(viaUnattended?.equals(dek)).toBe(true)
  })
})

describe('slot integrity', () => {
  it('binds the slot type into the AAD: an identical KEK still cannot open a re-labelled slot', async () => {
    await createKeySlots(db, PASSPHRASE, FAST)
    // Same salt, params and wrapped DEK under another label derives the exact same KEK from the
    // same string, so only the slot type in the AAD can make the unwrap fail.
    db.exec(`INSERT INTO key_slot (slot_type, kdf_params, salt, wrapped_dek, key_id)
             SELECT 'unattended', kdf_params, salt, wrapped_dek, key_id
             FROM key_slot WHERE slot_type = 'passphrase'`)
    expect(await unlockWithPassphrase(db, PASSPHRASE)).not.toBeNull()
    expect(await unlockWithUnattendedKey(db, PASSPHRASE)).toBeNull()
  })

  it('rejects a slot whose KDF does not match its type', async () => {
    await createKeySlots(db, PASSPHRASE, FAST)
    db.prepare(
      `UPDATE key_slot SET kdf_params = '{"kdf":"hkdf-sha256","info":"x"}' WHERE slot_type = 'passphrase'`,
    ).run()
    await expect(unlockWithPassphrase(db, PASSPHRASE)).rejects.toThrow(
      /does not match the slot type/,
    )
  })

  it('rejects a tampered wrapped DEK', async () => {
    await createKeySlots(db, PASSPHRASE, FAST)
    const row = db
      .prepare("SELECT wrapped_dek FROM key_slot WHERE slot_type = 'passphrase'")
      .get() as { wrapped_dek: string }
    const bytes = Buffer.from(row.wrapped_dek, 'base64url')
    bytes[20] = (bytes[20] ?? 0) ^ 1
    db.prepare("UPDATE key_slot SET wrapped_dek = ? WHERE slot_type = 'passphrase'").run(
      bytes.toString('base64url'),
    )
    expect(await unlockWithPassphrase(db, PASSPHRASE)).toBeNull()
  })

  it('rejects a slot whose key_id was altered', async () => {
    await createKeySlots(db, PASSPHRASE, FAST)
    db.prepare("UPDATE key_slot SET key_id = 'deadbeef' WHERE slot_type = 'passphrase'").run()
    expect(await unlockWithPassphrase(db, PASSPHRASE)).toBeNull()
  })

  it('rejects a tampered salt', async () => {
    await createKeySlots(db, PASSPHRASE, FAST)
    db.prepare(
      "UPDATE key_slot SET salt = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE slot_type = 'passphrase'",
    ).run()
    expect(await unlockWithPassphrase(db, PASSPHRASE)).toBeNull()
  })

  it('fails loudly on corrupt kdf_params rather than guessing', async () => {
    await createKeySlots(db, PASSPHRASE, FAST)
    db.prepare("UPDATE key_slot SET kdf_params = '{}' WHERE slot_type = 'passphrase'").run()
    await expect(unlockWithPassphrase(db, PASSPHRASE)).rejects.toThrow(/Corrupt key slot/)
  })

  it('allows one slot per type', async () => {
    await createKeySlots(db, PASSPHRASE, FAST)
    expect(() =>
      db
        .prepare(
          "INSERT INTO key_slot (slot_type, kdf_params, salt, wrapped_dek, key_id) VALUES ('passphrase', '{}', 'x', 'x', 'x')",
        )
        .run(),
    ).toThrow(/UNIQUE/)
  })
})

describe('changing the passphrase', () => {
  it('rewraps the passphrase slot: the old one stops working, the DEK stays the same', async () => {
    const { dek, recoveryKey } = await createKeySlots(db, PASSPHRASE, FAST)
    const before = db
      .prepare("SELECT salt, wrapped_dek FROM key_slot WHERE slot_type = 'passphrase'")
      .get()

    await changePassphrase(db, dek, 'a brand new passphrase', FAST)

    const after = db
      .prepare("SELECT salt, wrapped_dek FROM key_slot WHERE slot_type = 'passphrase'")
      .get()
    expect(after).not.toEqual(before)
    expect(await unlockWithPassphrase(db, PASSPHRASE)).toBeNull()
    expect((await unlockWithPassphrase(db, 'a brand new passphrase'))?.equals(dek)).toBe(true)
    expect((await unlockWithRecoveryKey(db, recoveryKey))?.equals(dek)).toBe(true)
  })

  it('refuses a DEK that does not belong to the stored slots', async () => {
    await createKeySlots(db, PASSPHRASE, FAST)
    await expect(changePassphrase(db, Buffer.alloc(32, 1), 'new passphrase', FAST)).rejects.toThrow(
      /does not match/,
    )
    expect(await unlockWithPassphrase(db, PASSPHRASE)).not.toBeNull()
  })

  it('refuses when no slots exist', async () => {
    await expect(changePassphrase(db, Buffer.alloc(32, 1), 'x', FAST)).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })
})

describe('forgotten passphrase', () => {
  it('lets the recovery key set a new passphrase without changing the DEK', async () => {
    const { dek, recoveryKey } = await createKeySlots(db, PASSPHRASE, FAST)
    const recovered = await resetPassphraseWithRecoveryKey(
      db,
      recoveryKey,
      'fresh passphrase',
      FAST,
    )
    expect(recovered?.equals(dek)).toBe(true)
    expect(await unlockWithPassphrase(db, PASSPHRASE)).toBeNull()
    expect((await unlockWithPassphrase(db, 'fresh passphrase'))?.equals(dek)).toBe(true)
  })

  it('leaves the old passphrase working when the recovery key is wrong', async () => {
    await createKeySlots(db, PASSPHRASE, FAST)
    const wrong = formatRecoveryKey(Buffer.alloc(32, 5))
    expect(await resetPassphraseWithRecoveryKey(db, wrong, 'fresh passphrase', FAST)).toBeNull()
    expect(await unlockWithPassphrase(db, PASSPHRASE)).not.toBeNull()
    expect(await unlockWithPassphrase(db, 'fresh passphrase')).toBeNull()
  })
})

describe('concurrency and transactions', () => {
  it('lets exactly one of two concurrent setups win and never overwrites it', async () => {
    const [a, b] = await Promise.allSettled([
      createKeySlots(db, 'passphrase for caller A', FAST),
      createKeySlots(db, 'passphrase for caller B', FAST),
    ])
    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled')
    const rejected = [a, b].filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError)

    const winner = (fulfilled[0] as PromiseFulfilledResult<{ dek: Buffer }>).value
    const winnerPassphrase =
      a.status === 'fulfilled' ? 'passphrase for caller A' : 'passphrase for caller B'
    const loserPassphrase =
      a.status === 'fulfilled' ? 'passphrase for caller B' : 'passphrase for caller A'
    expect((await unlockWithPassphrase(db, winnerPassphrase))?.equals(winner.dek)).toBe(true)
    expect(await unlockWithPassphrase(db, loserPassphrase)).toBeNull()
    expect(listSlots(db)).toHaveLength(2)
  })

  it('works inside a caller transaction and rolls back with it', async () => {
    db.exec('BEGIN')
    await createKeySlots(db, PASSPHRASE, FAST)
    expect(hasKeySlots(db)).toBe(true)
    db.exec('ROLLBACK')
    expect(hasKeySlots(db)).toBe(false)

    db.exec('BEGIN')
    await createKeySlots(db, PASSPHRASE, FAST)
    db.exec('COMMIT')
    expect(hasKeySlots(db)).toBe(true)
  })

  it('lets a caller apply a prepared passphrase slot atomically with other changes', async () => {
    const { dek } = await createKeySlots(db, PASSPHRASE, FAST)
    const prepared = await preparePassphraseSlot(dek, 'rolled back passphrase', FAST)

    db.exec('BEGIN')
    applySlot(db, prepared)
    db.exec('ROLLBACK')
    expect(await unlockWithPassphrase(db, PASSPHRASE)).not.toBeNull()
    expect(await unlockWithPassphrase(db, 'rolled back passphrase')).toBeNull()

    db.exec('BEGIN')
    applySlot(db, prepared)
    db.exec('COMMIT')
    expect(await unlockWithPassphrase(db, 'rolled back passphrase')).not.toBeNull()
  })
})

describe('compatibility-critical outputs', () => {
  it('derives the key id from the DEK exactly as installed databases expect', () => {
    expect(keyIdOf(Buffer.alloc(32, 0x11))).toBe('eaee4a2d')
  })

  it('returns a private 32-byte buffer, not a view into the shared Buffer pool', async () => {
    await createKeySlots(db, PASSPHRASE, FAST)
    const dek = await unlockWithPassphrase(db, PASSPHRASE)
    expect(dek?.buffer.byteLength).toBe(32)
  })
})

describe('write-time KDF validation', () => {
  it('refuses parameters the reader would later reject, leaving the old slot usable', async () => {
    const { dek } = await createKeySlots(db, PASSPHRASE, FAST)
    const bad = { passphraseKdf: { ...FAST.passphraseKdf, timeCost: 500 } }
    await expect(changePassphrase(db, dek, 'new passphrase', bad)).rejects.toThrow(
      /Corrupt key slot/,
    )
    expect(await unlockWithPassphrase(db, PASSPHRASE)).not.toBeNull()
  })

  it('refuses invalid parameters at setup without writing anything', async () => {
    const bad = { passphraseKdf: { ...FAST.passphraseKdf, memoryKiB: 0 } }
    await expect(createKeySlots(db, PASSPHRASE, bad)).rejects.toThrow(/Corrupt key slot/)
    expect(hasKeySlots(db)).toBe(false)
  })
})

describe('slot timestamps and audit trail', () => {
  it('keeps created_at when a slot is rewrapped and moves updated_at', async () => {
    const { dek } = await createKeySlots(db, PASSPHRASE, FAST)
    db.exec(
      "UPDATE key_slot SET created_at = '2020-01-01 00:00:00', updated_at = '2020-01-01 00:00:00'",
    )
    await changePassphrase(db, dek, 'new passphrase', FAST)
    const [passphrase, recovery] = listSlots(db)
    expect(passphrase?.createdAt).toBe('2020-01-01 00:00:00')
    expect(passphrase?.updatedAt).not.toBe('2020-01-01 00:00:00')
    expect(recovery?.updatedAt).toBe('2020-01-01 00:00:00')
  })

  it('records every slot mutation in audit_log without any key material', async () => {
    const { dek, recoveryKey } = await createKeySlots(db, PASSPHRASE, FAST)
    await changePassphrase(db, dek, 'second passphrase', FAST)
    await resetPassphraseWithRecoveryKey(db, recoveryKey, 'third passphrase', FAST)
    const newRecovery = rotateRecoveryKey(db, dek)
    await setUnattendedKey(db, dek, UNATTENDED)
    removeUnattendedKey(db)

    const rows = db
      .prepare('SELECT action, entity_type, old_data, new_data FROM audit_log ORDER BY id')
      .all() as Array<{
      action: string
      entity_type: string
      old_data: string | null
      new_data: string | null
    }>
    expect(rows.map((r) => r.action)).toEqual([
      'key_slot.create',
      'key_slot.passphrase.change',
      'key_slot.passphrase.reset',
      'key_slot.recovery.rotate',
      'key_slot.unattended.set',
      'key_slot.unattended.remove',
    ])
    expect(new Set(rows.map((r) => r.entity_type))).toEqual(new Set(['key_slot']))
    const dump = JSON.stringify(rows)
    for (const secret of [dek.toString('hex'), recoveryKey, newRecovery, UNATTENDED]) {
      expect(dump).not.toContain(secret)
    }
  })

  it('does not audit a removal that removed nothing', async () => {
    await createKeySlots(db, PASSPHRASE, FAST)
    removeUnattendedKey(db)
    const actions = db.prepare('SELECT action FROM audit_log').all() as Array<{ action: string }>
    expect(actions.map((a) => a.action)).toEqual(['key_slot.create'])
  })
})

describe('rotating the recovery key', () => {
  it('invalidates the old key, issues a new one and leaves the passphrase alone', async () => {
    const { dek, recoveryKey } = await createKeySlots(db, PASSPHRASE, FAST)
    const fresh = rotateRecoveryKey(db, dek)
    expect(fresh).not.toBe(recoveryKey)
    expect(await unlockWithRecoveryKey(db, recoveryKey)).toBeNull()
    expect((await unlockWithRecoveryKey(db, fresh))?.equals(dek)).toBe(true)
    expect((await unlockWithPassphrase(db, PASSPHRASE))?.equals(dek)).toBe(true)
  })

  it('refuses a DEK that does not belong to the stored slots', async () => {
    const { recoveryKey } = await createKeySlots(db, PASSPHRASE, FAST)
    expect(() => rotateRecoveryKey(db, Buffer.alloc(32, 1))).toThrow(/does not match/)
    expect(await unlockWithRecoveryKey(db, recoveryKey)).not.toBeNull()
  })
})

describe('unattended slot', () => {
  it('is optional, can be added and removed, and removal does not affect other slots', async () => {
    const { dek, recoveryKey } = await createKeySlots(db, PASSPHRASE, FAST)
    expect(hasUnattendedSlot(db)).toBe(false)

    await setUnattendedKey(db, dek, UNATTENDED)
    expect(hasUnattendedSlot(db)).toBe(true)
    expect((await unlockWithUnattendedKey(db, UNATTENDED))?.equals(dek)).toBe(true)
    expect(await unlockWithUnattendedKey(db, 'e'.repeat(64))).toBeNull()

    expect(removeUnattendedKey(db)).toBe(true)
    expect(removeUnattendedKey(db)).toBe(false)
    expect(await unlockWithUnattendedKey(db, UNATTENDED)).toBeNull()
    expect(await unlockWithPassphrase(db, PASSPHRASE)).not.toBeNull()
    expect(await unlockWithRecoveryKey(db, recoveryKey)).not.toBeNull()
  })

  it('replaces the key when set again', async () => {
    const { dek } = await createKeySlots(db, PASSPHRASE, FAST)
    await setUnattendedKey(db, dek, UNATTENDED)
    await setUnattendedKey(db, dek, 'e'.repeat(64))
    expect(await unlockWithUnattendedKey(db, UNATTENDED)).toBeNull()
    expect((await unlockWithUnattendedKey(db, 'e'.repeat(64)))?.equals(dek)).toBe(true)
    expect(listSlots(db).filter((s) => s.slotType === 'unattended')).toHaveLength(1)
  })

  it('refuses a DEK that does not match the stored slots', async () => {
    await createKeySlots(db, PASSPHRASE, FAST)
    await expect(setUnattendedKey(db, Buffer.alloc(32, 1), UNATTENDED)).rejects.toThrow(
      /does not match/,
    )
    expect(hasUnattendedSlot(db)).toBe(false)
  })

  it('does not store the unattended key in a readable form', async () => {
    const { dek } = await createKeySlots(db, PASSPHRASE, FAST)
    await setUnattendedKey(db, dek, UNATTENDED)
    expect(dumpDb(db)).not.toContain(UNATTENDED)
  })
})

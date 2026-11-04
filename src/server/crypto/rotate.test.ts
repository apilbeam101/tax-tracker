import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runRotate } from '../commands/rotate.ts'
import { initDb } from '../db/database.ts'
import { loadFixture, MARKERS, NAME, storesOn, TICKER } from '../repositories/sqlite/fixture.ts'
import { listBackups } from '../services/backup/backups.ts'
import { createFieldCipher, FieldCryptoError } from './fields.ts'
import type { Argon2idParams } from './kdf.ts'
import { Keyring } from './keyring.ts'
import {
  createKeySlots,
  hasUnattendedSlot,
  isEncryptedDatabase,
  listSlots,
  setUnattendedKey,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  unlockWithUnattendedKey,
} from './keyslots.ts'
import { rotateDataKey } from './rotate.ts'
import { recoveryKeyNeedsConfirmation, scrubIfPending } from './upgrade.ts'

const FAST: Argon2idParams = { kdf: 'argon2id', memoryKiB: 64, timeCost: 1, parallelism: 1 }
const PASSPHRASE = 'a reasonably long passphrase'
const UNATTENDED = 'u'.repeat(40)

let dir: string
let dbPath: string

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  dir = mkdtempSync(join(tmpdir(), 'tt-rotate-'))
  dbPath = join(dir, 'taxtracker.db')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

// An encrypted database holding the shared fixture, written through the stores with the real key.
async function encryptedDb(options: { unattended?: string } = {}) {
  const db = await initDb(dbPath)
  db.prepare('INSERT INTO "user" (tenant_id, username, password_hash) VALUES (1, ?, ?)').run(
    'a',
    'x',
  )
  const created = await createKeySlots(db, PASSPHRASE, { passphraseKdf: FAST })
  if (options.unattended) await setUnattendedKey(db, created.dek, options.unattended)
  const keyring = new Keyring({ protected: true })
  keyring.unlock(Buffer.from(created.dek))
  const stores = storesOn(db, createFieldCipher(keyring))
  loadFixture(stores)
  return { db, stores, keyring, recoveryKey: created.recoveryKey, dek: created.dek }
}

// Everything the stores can read, as plain objects.
function snapshot(stores: ReturnType<typeof storesOn>) {
  const instruments = stores.instruments.list(1)
  return {
    instruments,
    transactions: stores.transactions.list(1),
    disposals: stores.cgtDisposals.list(1),
    pools: instruments.map((i) => stores.s104Pools.get(1, i.id)),
    vests: stores.vestSchedules.list(1),
    prices: instruments.flatMap((i) => stores.prices.listRange(i.id, '0000-01-01', '9999-12-31')),
  }
}

async function openedWith(db: Awaited<ReturnType<typeof initDb>>, passphrase = PASSPHRASE) {
  const dek = await unlockWithPassphrase(db, passphrase)
  const keyring = new Keyring({ protected: true })
  keyring.unlock(dek as Buffer)
  return { keyring, stores: storesOn(db, createFieldCipher(keyring)) }
}

const rotate = (db: Awaited<ReturnType<typeof initDb>>, extra = {}) =>
  rotateDataKey(db, { passphrase: PASSPHRASE, passphraseKdf: FAST, ...extra })

describe('rotateDataKey', () => {
  it('re-encrypts everything under a new key without changing any value', async () => {
    const { db, stores, recoveryKey } = await encryptedDb()
    const before = snapshot(stores)
    expect(before.transactions.length).toBeGreaterThan(5)
    const oldKeyId = listSlots(db)[0]?.keyId

    const result = await rotate(db)
    expect(result.previousKeyId).toBe(oldKeyId)
    expect(result.keyId).not.toBe(oldKeyId)
    expect(result.rowsRewritten).toBeGreaterThan(10)
    expect(listSlots(db).map((s) => s.keyId)).toEqual([result.keyId, result.keyId])

    const after = await openedWith(db)
    expect(snapshot(after.stores)).toEqual(before)
    expect(after.stores.instruments.getByTicker(1, TICKER)?.name).toBe(NAME)

    // The old key no longer reads anything, and the old recovery key no longer opens the slots.
    expect(() => stores.instruments.list(1)).toThrow(FieldCryptoError)
    expect(await unlockWithRecoveryKey(db, recoveryKey)).toBeNull()
    const fresh = await unlockWithRecoveryKey(db, result.recoveryKey)
    expect(fresh).not.toBeNull()
    expect(recoveryKeyNeedsConfirmation(db)).toBe(true)
    db.close()
  })

  it('leaves no trace of the old ciphertext, or of any plaintext, in the file or its log', async () => {
    const { db } = await encryptedDb()
    const sealed = [
      ...(db.prepare('SELECT quantity AS v FROM txn').all() as Array<{ v: string }>),
      ...(db.prepare('SELECT ticker AS v FROM instrument').all() as Array<{ v: string }>),
      ...(db
        .prepare('SELECT old_data AS v FROM audit_log WHERE old_data IS NOT NULL')
        .all() as Array<{
        v: string
      }>),
    ]
      .map((r) => r.v)
      .filter((v) => v?.startsWith('v1.'))
    expect(sealed.length).toBeGreaterThan(10)

    const result = await rotate(db)
    expect(result.scrubbed).toBe(true)
    db.close()

    const bytes = [dbPath, `${dbPath}-wal`]
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p).toString('latin1'))
      .join('\n')
    for (const old of sealed) expect(bytes.includes(old)).toBe(false)
    for (const marker of MARKERS) expect(bytes.includes(marker)).toBe(false)
  })

  it('changes nothing when it fails before the commit', async () => {
    const { db, stores } = await encryptedDb()
    const before = snapshot(stores)
    const slotsBefore = listSlots(db)

    await expect(
      rotate(db, {
        beforeCommit: () => {
          throw new Error('interrupted')
        },
      }),
    ).rejects.toThrow('interrupted')

    expect(snapshot(stores)).toEqual(before)
    expect(listSlots(db)).toEqual(slotsBefore)
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'key_slot.recovery.rotate'")
        .get(),
    ).toEqual({ n: 0 })
    db.close()
  })

  it('verifies what is stored, not what was written: a mismatch on read-back rolls everything back', async () => {
    const { db, stores } = await encryptedDb()
    const before = snapshot(stores)
    const slots = listSlots(db)
    // Something that changes a value after the rotation wrote it, as a faulty disk or a hostile
    // trigger would.
    db.exec(
      'CREATE TRIGGER tamper AFTER UPDATE OF notes ON txn BEGIN UPDATE txn SET notes = NULL WHERE id = NEW.id; END',
    )

    await expect(rotate(db)).rejects.toThrow(/Verification failed/)
    db.exec('DROP TRIGGER tamper')
    expect(snapshot(stores)).toEqual(before)
    expect(listSlots(db)).toEqual(slots)
    db.close()
  })

  it('refuses a wrong passphrase and a database without key slots', async () => {
    const { db, stores } = await encryptedDb()
    const before = snapshot(stores)
    await expect(rotate(db, { passphrase: 'not the passphrase' })).rejects.toThrow(/does not open/)
    expect(snapshot(stores)).toEqual(before)
    db.close()

    const plain = await initDb(join(dir, 'plain.db'))
    expect(isEncryptedDatabase(plain)).toBe(false)
    await expect(rotate(plain)).rejects.toThrow(/no key slots/)
    plain.close()
  })

  it('keeps an unattended slot only with the key that opens it', async () => {
    const kept = await encryptedDb({ unattended: UNATTENDED })
    const result = await rotate(kept.db, { unattendedKey: UNATTENDED })
    expect(result.unattendedSlot).toBe('kept')
    expect(await unlockWithUnattendedKey(kept.db, UNATTENDED)).not.toBeNull()
    expect(
      listSlots(kept.db)
        .map((s) => s.slotType)
        .sort(),
    ).toEqual(['passphrase', 'recovery', 'unattended'])
    kept.db.close()
  })

  it('refuses a key that does not open the existing unattended slot, or none at all, and changes nothing', async () => {
    const { db, stores } = await encryptedDb({ unattended: UNATTENDED })
    const before = snapshot(stores)
    const slots = listSlots(db)

    await expect(rotate(db, { unattendedKey: 'w'.repeat(40) })).rejects.toThrow(
      /does not open the existing unattended/,
    )
    await expect(rotate(db)).rejects.toThrow(/unattended key slot exists/)
    expect(listSlots(db)).toEqual(slots)
    expect(snapshot(stores)).toEqual(before)
    db.close()
  })

  it('drops the unattended slot only when asked to', async () => {
    const { db } = await encryptedDb({ unattended: UNATTENDED })
    const result = await rotate(db, { dropUnattended: true })
    expect(result.unattendedSlot).toBe('dropped')
    expect(hasUnattendedSlot(db)).toBe(false)
    db.close()
  })

  it('never creates an unattended slot, even when ENCRYPTION_KEY is set', async () => {
    const { db } = await encryptedDb()
    const result = await rotate(db, { unattendedKey: UNATTENDED })
    expect(result.unattendedSlot).toBe('none')
    expect(hasUnattendedSlot(db)).toBe(false)
    db.close()
  })

  it('reads and rewrites app secrets, and leaves a pending clean-up that is retried', async () => {
    const { db, stores } = await encryptedDb()
    stores.appSecrets.set(1, 'TIINGO_API_KEY', 'tiingo-secret-value')
    const result = await rotate(db, { scrub: false })
    expect(result.scrubbed).toBe(false)

    const after = await openedWith(db)
    expect(after.stores.appSecrets.get(1, 'TIINGO_API_KEY')).toBe('tiingo-secret-value')
    expect(scrubIfPending(db)).toBe(true)
    expect(scrubIfPending(db)).toBeNull()
    db.close()
  })
})

describe('keys rotate command', () => {
  it('takes a backup first, rotates, and refuses while the app is running', async () => {
    const { db, stores } = await encryptedDb()
    const before = snapshot(stores)
    db.close()
    const env = { DATA_DIR: dir }

    writeFileSync(join(dir, 'server.lock'), JSON.stringify({ id: 'x', pid: 1, host: 'elsewhere' }))
    await expect(runRotate(env, () => Promise.resolve(PASSPHRASE))).rejects.toThrow(
      /appears to be running/,
    )

    rmSync(join(dir, 'server.lock'))
    const report = await runRotate(env, () => Promise.resolve(PASSPHRASE))
    expect(report.rowsRewritten).toBeGreaterThan(10)
    expect(listBackups(dir).map((b) => b.reason)).toContain('pre-rotation')
    expect(report.backup).toMatch(/-pre-rotation\.db$/)

    const reopened = await initDb(dbPath)
    expect(snapshot((await openedWith(reopened)).stores)).toEqual(before)
    reopened.close()
  })

  it('does not rotate with the recovery key or a wrong passphrase, and leaves no backup behind', async () => {
    const { db, recoveryKey } = await encryptedDb()
    db.close()
    await expect(runRotate({ DATA_DIR: dir }, () => Promise.resolve(recoveryKey))).rejects.toThrow(
      /does not open/,
    )
    await expect(
      runRotate({ DATA_DIR: dir }, () => Promise.resolve('a wrong passphrase')),
    ).rejects.toThrow(/does not open/)
    expect(listBackups(dir)).toEqual([])
  })

  it('needs the unattended key, or --drop-unattended, when a slot exists', async () => {
    const { db } = await encryptedDb({ unattended: UNATTENDED })
    db.close()
    const passphrase = () => Promise.resolve(PASSPHRASE)

    await expect(runRotate({ DATA_DIR: dir }, passphrase)).rejects.toThrow(/unattended key slot/)
    await expect(
      runRotate({ DATA_DIR: dir, ENCRYPTION_KEY: 'w'.repeat(40) }, passphrase),
    ).rejects.toThrow(/does not open the existing unattended/)
    const kept = await runRotate({ DATA_DIR: dir, ENCRYPTION_KEY: UNATTENDED }, passphrase)
    expect(kept.unattendedSlot).toBe('kept')
    const dropped = await runRotate({ DATA_DIR: dir }, passphrase, { dropUnattended: true })
    expect(dropped.unattendedSlot).toBe('dropped')
  })
})

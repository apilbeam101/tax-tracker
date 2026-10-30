import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../db/testdb.ts'
import { ConflictError } from '../errors.ts'
import { loadFixture, MARKERS, storesOn, TICKER } from '../repositories/sqlite/fixture.ts'
import {
  createFieldCipher,
  encryptedColumns,
  FIELD_REGISTRY,
  isSealed,
  plainCipher,
} from './fields.ts'
import { Keyring } from './keyring.ts'
import {
  hasKeySlots,
  listSlots,
  rotateRecoveryKey,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  unlockWithUnattendedKey,
} from './keyslots.ts'
import {
  listPlaintextCopies,
  listPreEncryptionBackups,
  recordRecoveryKeyConfirmed,
  recoveryKeyNeedsConfirmation,
  removePreEncryptionBackups,
  scrubDatabase,
  scrubIfPending,
  upgradeToEncrypted,
} from './upgrade.ts'

const FAST = {
  passphraseKdf: { kdf: 'argon2id', memoryKiB: 64, timeCost: 1, parallelism: 1 },
} as const
const PASSPHRASE = 'a reasonably long passphrase'
const UNATTENDED = 'a-deployment-supplied-key-of-32-chars-or-more'

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tt-upgrade-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

type Raw = Record<string, unknown>

function rows(db: DatabaseSync, table: string): Raw[] {
  return db.prepare(`SELECT * FROM ${table}`).all() as Raw[]
}

// Everything the app can read, through plaintext stores, so before and after can be compared.
function snapshot(db: DatabaseSync, cipher = plainCipher) {
  const s = storesOn(db, cipher)
  const strip = <T extends object>(list: T[]) =>
    list.map((r) => {
      const { fetchedAt, ...rest } = r as Record<string, unknown>
      return rest
    })
  return {
    instruments: s.instruments.list(1),
    transactions: s.transactions.list(1),
    disposals: s.cgtDisposals.list(1),
    pool: s.s104Pools.get(1, 1),
    vests: s.vestSchedules.list(1),
    prices: strip([s.prices.get(1, '2025-03-03')].filter((p) => p !== undefined)),
  }
}

async function loadAndUpgrade(options: { unattendedKey?: string; scrub?: boolean } = {}) {
  const db = createTestDb()
  loadFixture(storesOn(db, plainCipher))
  const before = snapshot(db)
  const keyring = new Keyring({ protected: false })
  const backupDir = tempDir()
  const result = await upgradeToEncrypted(db, keyring, {
    passphrase: PASSPHRASE,
    backupDir,
    scrub: options.scrub ?? false,
    unattendedKey: options.unattendedKey,
    ...FAST,
  })
  return { db, keyring, backupDir, before, result }
}

describe('upgrading an unencrypted database', () => {
  it('leaves every store reading exactly what it read before', async () => {
    const { db, keyring, before } = await loadAndUpgrade()
    expect(snapshot(db, createFieldCipher(keyring))).toEqual(before)
  })

  it('seals every non-null encrypted column of every row, and builds the blind indexes', async () => {
    const { db, result } = await loadAndUpgrade()
    let sealed = 0
    for (const [table, columns] of Object.entries(FIELD_REGISTRY)) {
      const names = encryptedColumns(table)
      if (names.length === 0) continue
      for (const row of rows(db, table)) {
        for (const column of names) {
          const value = row[column]
          if (value !== null) {
            expect(isSealed(value), `${table}.${column}`).toBe(true)
            sealed++
          }
        }
        expect(columns).toBeDefined()
      }
    }
    expect(sealed).toBeGreaterThan(100)
    expect(result.rowsEncrypted).toBeGreaterThan(0)
    for (const instrument of rows(db, 'instrument')) {
      expect(instrument.ticker_bidx).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('switches the running keyring to encrypting, unlocked, so new writes are sealed at once', async () => {
    const { db, keyring } = await loadAndUpgrade()
    expect(keyring.state).toBe('unlocked')
    expect(keyring.isProtected).toBe(true)
    expect(keyring.isPermanent).toBe(false)

    const stores = storesOn(db, createFieldCipher(keyring))
    const added = stores.instruments.create(
      1,
      { ticker: 'AFTER', name: 'After', currency: 'GBP' },
      1,
    )
    const raw = rows(db, 'instrument').find((r) => r.id === added.id) as Raw
    expect(isSealed(raw.ticker)).toBe(true)
    expect(stores.instruments.getByTicker(1, TICKER)?.name).toBe('Zebra Quartz Holdings')
    expect(stores.instruments.getByTicker(1, 'AFTER')?.id).toBe(added.id)
  })

  it('creates the passphrase and recovery slots, and either opens the same key the keyring holds', async () => {
    const { db, keyring, result } = await loadAndUpgrade()
    expect(listSlots(db).map((s) => s.slotType)).toEqual(['passphrase', 'recovery'])

    const viaPassphrase = await unlockWithPassphrase(db, PASSPHRASE)
    const viaRecovery = await unlockWithRecoveryKey(db, result.recoveryKey)
    expect(viaPassphrase).not.toBeNull()
    expect(viaRecovery?.equals(viaPassphrase as Buffer)).toBe(true)
    expect(keyring.withDek((dek) => dek.equals(viaPassphrase as Buffer))).toBe(true)
  })

  it('also creates the unattended slot, and keeps the key unlocked for good, when a key is supplied', async () => {
    const { db, keyring } = await loadAndUpgrade({ unattendedKey: UNATTENDED })
    expect(listSlots(db).map((s) => s.slotType)).toEqual(['passphrase', 'recovery', 'unattended'])
    expect(keyring.isPermanent).toBe(true)
    expect(await unlockWithUnattendedKey(db, UNATTENDED)).not.toBeNull()
  })

  it('records the key-slot creation in the audit log', async () => {
    const { db } = await loadAndUpgrade()
    const actions = rows(db, 'audit_log').map((r) => r.action)
    expect(actions).toContain('key_slot.create')
  })

  it('refuses a second upgrade', async () => {
    const { db, keyring, backupDir } = await loadAndUpgrade()
    await expect(
      upgradeToEncrypted(db, keyring, { passphrase: PASSPHRASE, backupDir, ...FAST }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('refuses a database that already holds encrypted values but has no key slots', async () => {
    const { db } = await loadAndUpgrade()
    db.exec('DELETE FROM key_slot')
    await expect(
      upgradeToEncrypted(db, new Keyring({ protected: false }), {
        passphrase: PASSPHRASE,
        backupDir: tempDir(),
        ...FAST,
      }),
    ).rejects.toThrow(/already holds encrypted values/)
  })
})

describe('the safety copy', () => {
  it('is a complete, readable, plaintext copy made before anything changed', async () => {
    const { result, before, backupDir } = await loadAndUpgrade()
    expect(existsSync(result.backupPath)).toBe(true)
    expect(listPreEncryptionBackups(backupDir)).toHaveLength(1)

    const copy = new DatabaseSync(result.backupPath, { readOnly: true })
    cleanup.push(() => copy.close())
    expect((copy.prepare('PRAGMA integrity_check').get() as Raw).integrity_check).toBe('ok')
    expect(snapshot(copy)).toEqual(before)
    expect(rows(copy, 'key_slot')).toEqual([])
  })

  it('can be removed once the user has confirmed, and only that file is removed', async () => {
    const { backupDir } = await loadAndUpgrade()
    writeFileSync(join(backupDir, 'taxtracker-manual.db'), 'older backup')
    expect(removePreEncryptionBackups(backupDir)).toHaveLength(1)
    expect(listPreEncryptionBackups(backupDir)).toEqual([])
    expect(readdirSync(backupDir)).toEqual(['taxtracker-manual.db'])
  })
})

describe('an upgrade that fails part-way', () => {
  it('leaves the database exactly as it was, with no key slots and no leftover files', async () => {
    const db = createTestDb()
    loadFixture(storesOn(db, plainCipher))
    const before = snapshot(db)
    const rawBefore = ['instrument', 'txn', 's104_pool', 'cgt_disposal', 'audit_log'].map((t) =>
      rows(db, t),
    )
    db.exec(
      "CREATE TRIGGER boom BEFORE UPDATE ON txn WHEN NEW.id = 3 BEGIN SELECT RAISE(ABORT, 'boom'); END",
    )
    const keyring = new Keyring({ protected: false })
    const backupDir = tempDir()

    await expect(
      upgradeToEncrypted(db, keyring, { passphrase: PASSPHRASE, backupDir, ...FAST }),
    ).rejects.toThrow(/boom/)

    expect(db.isTransaction).toBe(false)
    expect(hasKeySlots(db)).toBe(false)
    expect(keyring.state).toBe('unprotected')
    expect(snapshot(db)).toEqual(before)
    expect(
      ['instrument', 'txn', 's104_pool', 'cgt_disposal', 'audit_log'].map((t) => rows(db, t)),
    ).toEqual(rawBefore)
    for (const instrument of rows(db, 'instrument')) expect(instrument.ticker_bidx).toBeNull()
    expect(readdirSync(backupDir)).toEqual([])
  })

  it('can simply be run again once the cause is fixed', async () => {
    const db = createTestDb()
    loadFixture(storesOn(db, plainCipher))
    const before = snapshot(db)
    db.exec(
      "CREATE TRIGGER boom BEFORE UPDATE ON txn WHEN NEW.id = 3 BEGIN SELECT RAISE(ABORT, 'boom'); END",
    )
    const keyring = new Keyring({ protected: false })
    const backupDir = tempDir()
    await expect(
      upgradeToEncrypted(db, keyring, { passphrase: PASSPHRASE, backupDir, ...FAST }),
    ).rejects.toThrow(/boom/)

    db.exec('DROP TRIGGER boom')
    await upgradeToEncrypted(db, keyring, {
      passphrase: PASSPHRASE,
      backupDir,
      scrub: false,
      ...FAST,
    })

    expect(snapshot(db, createFieldCipher(keyring))).toEqual(before)
  })

  it('does not touch the database when the safety copy cannot be made', async () => {
    const db = createTestDb()
    loadFixture(storesOn(db, plainCipher))
    const before = snapshot(db)
    const blocker = join(tempDir(), 'not-a-directory')
    writeFileSync(blocker, 'x')
    const keyring = new Keyring({ protected: false })

    await expect(
      upgradeToEncrypted(db, keyring, {
        passphrase: PASSPHRASE,
        backupDir: join(blocker, 'sub'),
        ...FAST,
      }),
    ).rejects.toThrow()

    expect(hasKeySlots(db)).toBe(false)
    expect(snapshot(db)).toEqual(before)
  })
})

describe('the safety copy of a database in WAL mode', () => {
  it('is a single self-contained file, with no -wal or -shm left beside it', async () => {
    const dir = tempDir()
    const db = createTestDb(join(dir, 'data.db'))
    db.exec('PRAGMA journal_mode = WAL')
    loadFixture(storesOn(db, plainCipher))
    const before = snapshot(db)
    const backupDir = tempDir()

    const result = await upgradeToEncrypted(db, new Keyring({ protected: false }), {
      passphrase: PASSPHRASE,
      backupDir,
      scrub: false,
      ...FAST,
    })

    expect(readdirSync(backupDir)).toEqual([result.backupPath.split(/[\\/]/).pop()])
    const copy = new DatabaseSync(result.backupPath, { readOnly: true })
    cleanup.push(() => copy.close())
    expect(snapshot(copy)).toEqual(before)
    db.close()
  })
})

describe('guarding the transaction', () => {
  it('rolls everything back when the caller vetoes the commit', async () => {
    const db = createTestDb()
    loadFixture(storesOn(db, plainCipher))
    const before = snapshot(db)
    const keyring = new Keyring({ protected: false })
    const backupDir = tempDir()

    await expect(
      upgradeToEncrypted(db, keyring, {
        passphrase: PASSPHRASE,
        backupDir,
        ...FAST,
        beforeCommit: () => {
          throw new Error('credentials changed')
        },
      }),
    ).rejects.toThrow(/credentials changed/)

    expect(hasKeySlots(db)).toBe(false)
    expect(keyring.isProtected).toBe(false)
    expect(snapshot(db)).toEqual(before)
    expect(readdirSync(backupDir)).toEqual([])
    expect(db.isTransaction).toBe(false)
  })

  it('catches a rewritten value that does not read back, and rolls back', async () => {
    const db = createTestDb()
    loadFixture(storesOn(db, plainCipher))
    const before = snapshot(db)
    // Corrupts the row right after the upgrade has written it, so only the read-back can notice.
    db.exec(
      `CREATE TRIGGER corrupt AFTER UPDATE ON instrument
       BEGIN UPDATE instrument SET name = 'tampered' WHERE id = NEW.id; END`,
    )
    const keyring = new Keyring({ protected: false })

    await expect(
      upgradeToEncrypted(db, keyring, { passphrase: PASSPHRASE, backupDir: tempDir(), ...FAST }),
    ).rejects.toThrow()

    expect(hasKeySlots(db)).toBe(false)
    db.exec('DROP TRIGGER corrupt')
    expect(snapshot(db)).toEqual(before)
  })

  it('fails cleanly, leaving nothing behind, when another connection holds the write lock', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'data.db')
    const db = createTestDb(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    loadFixture(storesOn(db, plainCipher))
    const before = snapshot(db)
    const other = new DatabaseSync(dbPath)
    cleanup.push(() => other.close())
    other.exec('BEGIN IMMEDIATE')

    const backupDir = tempDir()
    const keyring = new Keyring({ protected: false })
    await expect(
      upgradeToEncrypted(db, keyring, { passphrase: PASSPHRASE, backupDir, ...FAST }),
    ).rejects.toThrow(/locked/)

    other.exec('ROLLBACK')
    expect(readdirSync(backupDir)).toEqual([])
    expect(db.isTransaction).toBe(false)
    expect(hasKeySlots(db)).toBe(false)
    expect(keyring.isProtected).toBe(false)
    expect(snapshot(db)).toEqual(before)
    db.close()
  })
})

describe('the clean-up after encryption', () => {
  // Writes a marker into a row, checkpoints it into the main file, then deletes the row so its
  // page goes to the free list without being zeroed (secure_delete is off on this connection).
  function dbWithFreedMarker(dir: string): DatabaseSync {
    const db = createTestDb(join(dir, 'data.db'))
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA secure_delete = OFF')
    loadFixture(storesOn(db, plainCipher))
    db.exec(
      "INSERT INTO instrument (ticker, name, currency) VALUES ('FREEDMARKER-TICKER', 'FREEDMARKER-NAME', 'GBP')",
    )
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.exec("DELETE FROM instrument WHERE ticker = 'FREEDMARKER-TICKER'")
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return db
  }

  async function bytesAfter(scrub: boolean): Promise<Buffer> {
    const dir = tempDir()
    const db = dbWithFreedMarker(dir)
    try {
      await upgradeToEncrypted(db, new Keyring({ protected: false }), {
        passphrase: PASSPHRASE,
        backupDir: tempDir(),
        scrub,
        ...FAST,
      })
      const files = readdirSync(dir).filter((f) => f.startsWith('data.db'))
      return Buffer.concat(files.map((f) => readFileSync(join(dir, f))))
    } finally {
      db.close()
    }
  }

  it('control: without VACUUM, content deleted long before the upgrade lingers in a free page', async () => {
    expect((await bytesAfter(false)).includes(Buffer.from('FREEDMARKER-NAME'))).toBe(true)
  })

  it('VACUUM removes it', async () => {
    expect((await bytesAfter(true)).includes(Buffer.from('FREEDMARKER-NAME'))).toBe(false)
  })

  it('is reported as not done while another reader keeps the WAL from being truncated', () => {
    const dir = tempDir()
    const dbPath = join(dir, 'data.db')
    const db = createTestDb(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    loadFixture(storesOn(db, plainCipher))
    const reader = new DatabaseSync(dbPath)
    cleanup.push(() => reader.close())
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM txn').get()
    // Another writer moves the WAL past the reader's snapshot, so a full checkpoint cannot finish.
    db.exec('UPDATE instrument SET currency = currency WHERE id = 1')

    expect(scrubDatabase(db)).toBe(false)

    reader.exec('ROLLBACK')
    expect(scrubDatabase(db)).toBe(true)
    db.close()
  })

  it('is retried by scrubIfPending until it completes, then forgotten', async () => {
    const db = createTestDb()
    loadFixture(storesOn(db, plainCipher))
    // Skipping the scrub leaves it pending, as a failed one would.
    await upgradeToEncrypted(db, new Keyring({ protected: false }), {
      passphrase: PASSPHRASE,
      backupDir: tempDir(),
      scrub: false,
      ...FAST,
    })

    expect(scrubIfPending(db)).toBe(true)
    expect(scrubIfPending(db)).toBeNull()
  })

  it('has nothing pending on a database that was never upgraded', () => {
    expect(scrubIfPending(createTestDb())).toBeNull()
  })
})

describe('tracking whether the recovery key was confirmed', () => {
  it('is pending from the upgrade until the key is typed back, and again after each rotation', async () => {
    const { db, keyring } = await loadAndUpgrade()
    expect(recoveryKeyNeedsConfirmation(db)).toBe(true)

    recordRecoveryKeyConfirmed(db)
    expect(recoveryKeyNeedsConfirmation(db)).toBe(false)

    keyring.withDek((dek) => rotateRecoveryKey(db, dek))
    expect(recoveryKeyNeedsConfirmation(db)).toBe(true)
    recordRecoveryKeyConfirmed(db)
    expect(recoveryKeyNeedsConfirmation(db)).toBe(false)
  })

  it('does not depend on the safety copy still being on disk', async () => {
    const { db, backupDir } = await loadAndUpgrade()
    removePreEncryptionBackups(backupDir)
    expect(recoveryKeyNeedsConfirmation(db)).toBe(true)
  })

  it('has nothing to confirm on a database that was never upgraded', () => {
    expect(recoveryKeyNeedsConfirmation(createTestDb())).toBe(false)
  })
})

describe('what is left on disk', () => {
  // Loads the fixture into a real WAL-mode file, upgrades it, and returns every byte of the
  // database file, its WAL and its shared-memory file while the connection is still open.
  async function bytesAfterUpgrade(scrub: boolean): Promise<Buffer> {
    const dir = tempDir()
    const db = createTestDb(join(dir, 'data.db'))
    try {
      db.exec('PRAGMA journal_mode = WAL')
      loadFixture(storesOn(db, plainCipher))
      await upgradeToEncrypted(db, new Keyring({ protected: false }), {
        passphrase: PASSPHRASE,
        // Outside the scanned directory: the safety copy is plaintext by design.
        backupDir: tempDir(),
        scrub,
        ...FAST,
      })
      const files = readdirSync(dir).filter((f) => f.startsWith('data.db'))
      return Buffer.concat(files.map((f) => readFileSync(join(dir, f))))
    } finally {
      db.close()
    }
  }

  it('control: without the scrub, superseded plaintext is still in the file or its WAL', async () => {
    const bytes = await bytesAfterUpgrade(false)
    expect(MARKERS.filter((m) => bytes.includes(Buffer.from(m))).length).toBeGreaterThan(0)
  })

  it('after the scrub, none of the fixture values remain anywhere in the file or its WAL', async () => {
    const bytes = await bytesAfterUpgrade(true)
    expect(MARKERS.filter((m) => bytes.includes(Buffer.from(m)))).toEqual([])
  })

  it('reports a failed scrub rather than claiming success', () => {
    const db = createTestDb()
    db.exec('BEGIN')
    expect(scrubDatabase(db)).toBe(false)
    db.exec('ROLLBACK')
    expect(scrubDatabase(db)).toBe(true)
  })
})

describe('older plaintext copies of the database', () => {
  it('lists backups, .bak files and Ghostfolio exports, but not the live database or the current safety copy', () => {
    const dataDir = tempDir()
    const backupDir = join(dataDir, 'backups')
    mkdirSync(backupDir)
    writeFileSync(join(dataDir, 'taxtracker.db'), 'live')
    writeFileSync(join(dataDir, 'taxtracker.db-wal'), 'wal')
    writeFileSync(join(dataDir, 'taxtracker.db.bak-20260101'), 'old copy')
    writeFileSync(join(dataDir, 'ghostfolio-export-202606181149.json'), '{}')
    writeFileSync(join(dataDir, 'notes.txt'), 'unrelated')
    writeFileSync(join(backupDir, 'taxtracker-2026-01-01.db'), 'backup')
    writeFileSync(join(backupDir, 'taxtracker-2026-02-02-pre-encryption.db'), 'current safety copy')
    writeFileSync(join(backupDir, 'taxtracker-2026-01-05-aaaaaa-pre-encryption.db'), 'orphaned one')

    expect(
      listPlaintextCopies(dataDir, backupDir, {
        exceptSafetyCopy: 'taxtracker-2026-02-02-pre-encryption.db',
      })
        .map((c) => `${c.location}:${c.name}`)
        .sort(),
    ).toEqual([
      'backups:taxtracker-2026-01-01.db',
      'backups:taxtracker-2026-01-05-aaaaaa-pre-encryption.db',
      'data:ghostfolio-export-202606181149.json',
      'data:taxtracker.db.bak-20260101',
    ])
  })

  it('does not flag a backup that carries key slots, i.e. one made after encryption', async () => {
    const dataDir = tempDir()
    const backupDir = join(dataDir, 'backups')
    mkdirSync(backupDir)
    const encrypted = createTestDb(join(backupDir, 'taxtracker-after.db'))
    encrypted.exec(
      "INSERT INTO key_slot (slot_type, kdf_params, salt, wrapped_dek, key_id) VALUES ('passphrase', '{}', 'x', 'x', 'x')",
    )
    encrypted.close()
    const plain = createTestDb(join(backupDir, 'taxtracker-before.db'))
    plain.close()

    expect(listPlaintextCopies(dataDir, backupDir).map((c) => c.name)).toEqual([
      'taxtracker-before.db',
    ])
  })

  it('never throws on an entry it cannot stat', () => {
    const dataDir = tempDir()
    const backupDir = join(dataDir, 'backups')
    mkdirSync(backupDir)
    mkdirSync(join(backupDir, 'a-directory.db'))
    writeFileSync(join(backupDir, 'ok.db'), 'x')
    expect(() => listPlaintextCopies(dataDir, backupDir)).not.toThrow()
    expect(listPlaintextCopies(dataDir, backupDir).map((c) => c.name)).toEqual(['ok.db'])
  })

  it('returns an empty list when the directories do not exist', () => {
    expect(listPlaintextCopies(join(tempDir(), 'nope'), join(tempDir(), 'nope2'))).toEqual([])
  })
})

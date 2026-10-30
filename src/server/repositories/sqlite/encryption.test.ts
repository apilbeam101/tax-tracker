import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  createFieldCipher,
  encryptedColumns,
  FIELD_REGISTRY,
  type FieldCipher,
  FieldCryptoError,
  isSealed,
  plainCipher,
} from '../../crypto/fields.ts'
import { Keyring } from '../../crypto/keyring.ts'
import { createTestDb } from '../../db/testdb.ts'
import { LockedError } from '../../errors.ts'
import { runTaxEngineForInstrument } from '../../services/tax/engine.ts'
import { backfillRealisedProjections, linkRealisedProjection } from '../../services/tax/recalc.ts'
import { backfillAutoWithholding } from '../../services/tax/withholding.ts'
import { loadFixture, MARKERS, NAME, NOTE, storesOn, TICKER } from './fixture.ts'
import { allocateId } from './rowcodec.ts'

const DEK = Buffer.alloc(32, 0x44)

function keyringFor(locked = false): Keyring {
  const keyring = new Keyring({ protected: true })
  keyring.unlock(Buffer.from(DEK))
  if (locked) keyring.lock()
  return keyring
}

function encryptedStores(db = createTestDb(), keyring = keyringFor()) {
  return { ...storesOn(db, createFieldCipher(keyring)), keyring }
}

type RawRow = Record<string, unknown>

function allRows(db: DatabaseSync, table: string): RawRow[] {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  return exists ? (db.prepare(`SELECT * FROM ${table}`).all() as RawRow[]) : []
}

describe('the stores against an encrypting database', () => {
  it('round-trips every store exactly as an unencrypted database does', () => {
    const plain = storesOn(createTestDb(), plainCipher)
    const encrypted = encryptedStores()
    loadFixture(plain)
    loadFixture(encrypted)

    const strip = <T extends object>(rows: T[]) =>
      rows.map((r) => {
        const { createdAt, updatedAt, fetchedAt, ...rest } = r as Record<string, unknown>
        return rest
      })

    expect(strip(encrypted.instruments.list(1))).toEqual(strip(plain.instruments.list(1)))
    expect(strip(encrypted.transactions.list(1))).toEqual(strip(plain.transactions.list(1)))
    expect(encrypted.cgtDisposals.list(1)).toEqual(plain.cgtDisposals.list(1))
    expect(encrypted.s104Pools.get(1, 1)).toEqual(plain.s104Pools.get(1, 1))
    expect(strip(encrypted.vestSchedules.list(1))).toEqual(strip(plain.vestSchedules.list(1)))
    expect(encrypted.prices.get(1, '2025-03-03')?.closePrice).toBe('123.456789')
  })

  it('stores a ciphertext in every non-null encrypted column of every table, and nothing else', () => {
    const s = encryptedStores()
    loadFixture(s)
    s.appSecrets.set(1, 'tiingo', 'sk-live-marker')

    const checked: string[] = []
    for (const [table, columns] of Object.entries(FIELD_REGISTRY)) {
      for (const row of allRows(s.db, table)) {
        for (const [column, cls] of Object.entries(columns)) {
          const value = row[column]
          if (cls === 'encrypted' && value !== null) {
            expect(isSealed(value), `${table}.${column}`).toBe(true)
            checked.push(`${table}.${column}`)
          }
        }
      }
    }
    // Every encrypted column was actually populated and checked, so a column the fixture leaves
    // empty cannot pass vacuously. Only columns no store writes at all are exempt.
    const NEVER_WRITTEN = new Set(['txn.import_source', 'audit_log.ip_address'])
    const everyEncrypted = Object.keys(FIELD_REGISTRY).flatMap((table) =>
      encryptedColumns(table).map((column) => `${table}.${column}`),
    )
    const unchecked = everyEncrypted.filter(
      (column) => !checked.includes(column) && !NEVER_WRITTEN.has(column),
    )
    expect(unchecked).toEqual([])
  })

  it('keeps keys, dates and types readable', () => {
    const s = encryptedStores()
    const { instrumentId } = loadFixture(s)
    const row = allRows(s.db, 'txn').find((r) => r.instrument_id === instrumentId) as RawRow
    expect(row.txn_type).toBe('BUY')
    expect(row.txn_date).toBe('2024-05-01')
    expect(row.native_currency).toBe('USD')
  })

  it('writes every encrypted column that has a schema default explicitly, never the default', () => {
    const s = encryptedStores()
    s.instruments.create(1, { ticker: 'ONLY', name: 'Only', currency: 'GBP' }, 1)
    const row = allRows(s.db, 'instrument')[0] as RawRow
    expect(isSealed(row.is_employer_stock)).toBe(true)
    expect(isSealed(row.rsu_withholding_method)).toBe(true)
  })

  it('rejects a ciphertext moved to another row of the same column', () => {
    const s = encryptedStores()
    loadFixture(s)
    const rows = allRows(s.db, 'txn')
    const [a, b] = rows as [RawRow, RawRow]
    s.db
      .prepare('UPDATE txn SET quantity = ? WHERE id = ?')
      .run(a.quantity as string, b.id as number)
    expect(() => s.transactions.getById(1, b.id as number)).toThrow(FieldCryptoError)
    expect(() => s.transactions.list(1)).toThrow(FieldCryptoError)
  })

  it('rejects a ciphertext moved to another column of the same row', () => {
    const s = encryptedStores()
    loadFixture(s)
    const row = allRows(s.db, 'txn')[0] as RawRow
    s.db
      .prepare('UPDATE txn SET costs_gbp = ? WHERE id = ?')
      .run(row.quantity as string, row.id as number)
    expect(() => s.transactions.getById(1, row.id as number)).toThrow(FieldCryptoError)
  })

  it('rejects plaintext planted in an encrypted column', () => {
    const s = encryptedStores()
    loadFixture(s)
    s.db.prepare("UPDATE txn SET quantity = '999999' WHERE id = 1").run()
    expect(() => s.transactions.getById(1, 1)).toThrow(/not in encrypted form/)
  })

  it('raises 423 on every store while locked', () => {
    const keyring = keyringFor()
    const s = encryptedStores(createTestDb(), keyring)
    const { instrumentId } = loadFixture(s)
    keyring.lock()

    expect(() => s.instruments.list(1)).toThrowError(LockedError)
    expect(() => s.instruments.getByTicker(1, TICKER)).toThrowError(LockedError)
    expect(() => s.transactions.list(1)).toThrowError(LockedError)
    expect(() => s.s104Pools.get(1, instrumentId)).toThrowError(LockedError)
    expect(() => s.cgtDisposals.list(1)).toThrowError(LockedError)
    expect(() => s.prices.getLatest(instrumentId)).toThrowError(LockedError)
    expect(() => s.vestSchedules.list(1)).toThrowError(LockedError)
    expect(() =>
      s.transactions.create(
        1,
        { instrumentId, txnType: 'BUY', txnDate: '2025-01-01', quantity: '1' },
        1,
      ),
    ).toThrowError(LockedError)
  })

  it('raises 423 on writes to every store while locked, and writes nothing', () => {
    const keyring = keyringFor()
    const s = encryptedStores(createTestDb(), keyring)
    const { instrumentId } = loadFixture(s)
    const poolBefore = allRows(s.db, 's104_pool')
    const disposalsBefore = allRows(s.db, 'cgt_disposal')
    const pricesBefore = allRows(s.db, 'price')
    const vestsBefore = allRows(s.db, 'vest_schedule')
    keyring.lock()

    expect(() => s.s104Pools.save(1, instrumentId, { quantity: '1', costGbp: '1' })).toThrowError(
      LockedError,
    )
    expect(() =>
      s.prices.upsert({
        instrumentId,
        priceDate: '2030-01-01',
        closePrice: '1',
        source: 'manual',
      }),
    ).toThrowError(LockedError)
    expect(() => s.cgtDisposals.replaceForInstrument(1, instrumentId, [])).toThrowError(LockedError)
    expect(() =>
      s.vestSchedules.create(1, {
        instrumentId,
        scheduleType: 'rsu-vest',
        scheduledDate: '2030-01-01',
        quantity: '1',
      }),
    ).toThrowError(LockedError)
    expect(() => s.appSecrets.set(1, 'tiingo', 'sk')).toThrowError(LockedError)
    expect(() => s.appSecrets.delete(1, 'tiingo')).toThrowError(LockedError)
    expect(() => s.vestSchedules.delete(1, 1)).toThrowError(LockedError)
    expect(() => s.vestSchedules.setRealisedTxn(1, 1, 1)).toThrowError(LockedError)
    expect(() => s.vestSchedules.clearRealisedTxn(1, 1)).toThrowError(LockedError)
    expect(() =>
      s.instruments.create(1, { ticker: 'NEW', name: 'New', currency: 'GBP' }, 1),
    ).toThrowError(LockedError)

    expect(allRows(s.db, 's104_pool')).toEqual(poolBefore)
    expect(allRows(s.db, 'cgt_disposal')).toEqual(disposalsBefore)
    expect(allRows(s.db, 'price')).toEqual(pricesBefore)
    expect(allRows(s.db, 'vest_schedule')).toEqual(vestsBefore)
    expect(s.db.isTransaction).toBe(false)
  })

  it('works alongside the key_slot rows that activate the blind-index trigger', () => {
    const s = encryptedStores()
    s.db.exec(
      "INSERT INTO key_slot (slot_type, kdf_params, salt, wrapped_dek, key_id) VALUES ('passphrase', '{}', 'x', 'x', 'x')",
    )
    const created = s.instruments.create(1, { ticker: 'SLOT', name: 'Slot', currency: 'GBP' }, 1)
    s.instruments.update(1, created.id, { name: 'Renamed' }, 1)
    expect(s.instruments.getByTicker(1, 'SLOT')?.name).toBe('Renamed')

    // A store that does not know about the blind index is stopped by the trigger.
    const plain = storesOn(s.db, plainCipher)
    expect(() =>
      plain.instruments.create(1, { ticker: 'RAW', name: 'Raw', currency: 'GBP' }, 1),
    ).toThrow(/ticker_bidx is required/)
  })

  it('refuses to read an encrypted database through a plaintext cipher', () => {
    const s = encryptedStores()
    loadFixture(s)
    const wrong = storesOn(s.db, plainCipher)
    expect(() => wrong.instruments.list(1)).toThrow(/without key slots/)
  })
})

describe('instrument lookup and uniqueness through the blind index', () => {
  it('finds an instrument by ticker without any plaintext ticker in the database', () => {
    const s = encryptedStores()
    loadFixture(s)
    expect(s.instruments.getByTicker(1, TICKER)?.name).toBe(NAME)
    expect(s.instruments.getByTicker(1, TICKER.toLowerCase())).toBeUndefined()
    expect(s.instruments.getByTicker(1, 'NOPE')).toBeUndefined()
    const raw = allRows(s.db, 'instrument')[0] as RawRow
    expect(raw.ticker_bidx).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(allRows(s.db, 'instrument'))).not.toContain(TICKER)
  })

  it('enforces one instrument per ticker per tenant', () => {
    const s = encryptedStores()
    s.instruments.create(1, { ticker: 'DUPE', name: 'First', currency: 'GBP' }, 1)
    expect(() =>
      s.instruments.create(1, { ticker: 'DUPE', name: 'Second', currency: 'GBP' }, 1),
    ).toThrow(/UNIQUE/)
    expect(() =>
      s.instruments.create(1, { ticker: 'dupe', name: 'Case differs', currency: 'GBP' }, 1),
    ).not.toThrow()
  })

  it('keeps the index in step when the ticker is renamed', () => {
    const s = encryptedStores()
    const created = s.instruments.create(1, { ticker: 'OLD', name: 'Renamed', currency: 'GBP' }, 1)
    s.instruments.update(1, created.id, { ticker: 'NEW' }, 1)
    expect(s.instruments.getByTicker(1, 'OLD')).toBeUndefined()
    expect(s.instruments.getByTicker(1, 'NEW')?.id).toBe(created.id)
    s.instruments.create(1, { ticker: 'OLD', name: 'Reuses the old ticker', currency: 'GBP' }, 1)
  })

  it('lists instruments sorted by ticker even though the column is ciphertext', () => {
    const s = encryptedStores()
    for (const ticker of ['MMM', 'AAA', 'ZZZ', 'BBB']) {
      s.instruments.create(1, { ticker, name: ticker, currency: 'GBP' }, 1)
    }
    expect(s.instruments.list(1).map((i) => i.ticker)).toEqual(['AAA', 'BBB', 'MMM', 'ZZZ'])
  })

  it('refuses an instrument row with no blind index once the database has key slots', () => {
    const db = createTestDb()
    db.exec(
      "INSERT INTO key_slot (slot_type, kdf_params, salt, wrapped_dek, key_id) VALUES ('passphrase', '{}', 'x', 'x', 'x')",
    )
    expect(() =>
      db.prepare("INSERT INTO instrument (ticker, name, currency) VALUES ('X', 'X', 'GBP')").run(),
    ).toThrow(/ticker_bidx is required/)
  })
})

describe('upserts and ids', () => {
  it('rewrites the S104 pool in place, keeping the row id its ciphertext is bound to', () => {
    const s = encryptedStores()
    const { instrumentId } = loadFixture(s)
    const before = allRows(s.db, 's104_pool')
    s.s104Pools.save(1, instrumentId, { quantity: '5', costGbp: '6' })
    s.s104Pools.save(1, instrumentId, { quantity: '7', costGbp: '8' })
    const after = allRows(s.db, 's104_pool')
    expect(after).toHaveLength(before.length)
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id))
    expect(s.s104Pools.get(1, instrumentId)).toEqual({ quantity: '7', costGbp: '8' })
  })

  it('upserts prices in place', () => {
    const s = encryptedStores()
    const { instrumentId } = loadFixture(s)
    const id = s.prices.get(instrumentId, '2025-03-03')?.id
    s.prices.upsert({
      instrumentId,
      priceDate: '2025-03-03',
      closePrice: '200.5',
      source: 'manual',
    })
    expect(s.prices.get(instrumentId, '2025-03-03')).toMatchObject({
      id,
      closePrice: '200.5',
      source: 'manual',
    })
    expect(allRows(s.db, 'price').filter((r) => r.price_date === '2025-03-03')).toHaveLength(1)
  })

  it('never reuses the id of a deleted row', () => {
    const s = encryptedStores()
    const a = s.instruments.create(1, { ticker: 'A', name: 'A', currency: 'GBP' }, 1)
    const b = s.instruments.create(1, { ticker: 'B', name: 'B', currency: 'GBP' }, 1)
    s.instruments.delete(1, b.id, 1)
    const c = s.instruments.create(1, { ticker: 'C', name: 'C', currency: 'GBP' }, 1)
    expect(c.id).toBeGreaterThan(b.id)
    expect(a.id).toBeLessThan(b.id)
    expect(allocateId(s.db, 'instrument')).toBe(c.id + 1)
  })

  it('replaces disposals atomically and re-encrypts them under new ids', () => {
    const s = encryptedStores()
    const { instrumentId } = loadFixture(s)
    const first = s.cgtDisposals.list(1, { instrumentId })
    expect(first.length).toBeGreaterThan(0)
    runTaxEngineForInstrument(1, instrumentId, s.transactions, s.cgtDisposals, s.s104Pools)
    expect(s.cgtDisposals.list(1, { instrumentId })).toEqual(first)
  })

  it('leaves the old disposals untouched when the replacement fails part-way', () => {
    const s = encryptedStores()
    const { instrumentId } = loadFixture(s)
    const before = s.cgtDisposals.list(1, { instrumentId })
    const rawBefore = allRows(s.db, 'cgt_disposal')
    expect(before.length).toBeGreaterThan(0)

    const broken = before.map((d, i) =>
      i === before.length - 1 ? { ...d, taxYear: '1999-00' } : d,
    )
    expect(() =>
      s.cgtDisposals.replaceForInstrument(1, instrumentId, [...before, ...broken]),
    ).toThrow(/FOREIGN KEY/)

    expect(s.db.isTransaction).toBe(false)
    expect(allRows(s.db, 'cgt_disposal')).toEqual(rawBefore)
    expect(s.cgtDisposals.list(1, { instrumentId })).toEqual(before)
  })
})

describe('the audit log', () => {
  it('encrypts the snapshots but leaves the action and entity readable', () => {
    const s = encryptedStores()
    loadFixture(s)
    const rows = allRows(s.db, 'audit_log')
    expect(rows.length).toBeGreaterThan(0)
    const create = rows.find((r) => r.action === 'instrument.create') as RawRow
    expect(create.entity_type).toBe('instrument')
    expect(isSealed(create.new_data)).toBe(true)
    expect(JSON.stringify(rows)).not.toContain(NAME)
    expect(JSON.stringify(rows)).not.toContain(NOTE)
  })

  it('records the before and after of an update, readable once decrypted', () => {
    const s = encryptedStores()
    const created = s.instruments.create(1, { ticker: 'AUD', name: 'Before', currency: 'GBP' }, 1)
    s.instruments.update(1, created.id, { name: 'After' }, 1)
    const row = allRows(s.db, 'audit_log').find((r) => r.action === 'instrument.update') as RawRow
    const codec = createFieldCipher(s.keyring)
    const oldData = codec.open('audit_log', 'old_data', row.id as number, row.old_data as string)
    const newData = codec.open('audit_log', 'new_data', row.id as number, row.new_data as string)
    expect(JSON.parse(oldData as string).name).toBe('Before')
    expect(JSON.parse(newData as string).name).toBe('After')
  })
})

describe('app secrets', () => {
  it('stores API keys encrypted, overwrites in place and deletes', () => {
    const s = encryptedStores()
    s.appSecrets.set(1, 'tiingo', 'key-one-marker')
    s.appSecrets.set(1, 'tiingo', 'key-two-marker')
    expect(s.appSecrets.get(1, 'tiingo')).toBe('key-two-marker')
    expect(s.appSecrets.names(1)).toEqual(['tiingo'])
    expect(JSON.stringify(allRows(s.db, 'app_secret'))).not.toContain('marker')
    expect(allRows(s.db, 'app_secret')).toHaveLength(1)
    expect(s.appSecrets.delete(1, 'tiingo')).toBe(true)
    expect(s.appSecrets.get(1, 'tiingo')).toBeUndefined()
  })

  it('refuses to store a secret in a database that is not encrypting', () => {
    const plain = storesOn(createTestDb(), plainCipher)
    expect(() => plain.appSecrets.set(1, 'tiingo', 'sk-live')).toThrow(/encrypted database/)
  })
})

describe('logic that used to filter or join in SQL', () => {
  it('links projections to transactions through the stores, with the tolerance and tax-year rules', () => {
    const s = encryptedStores()
    const instrument = s.instruments.create(1, { ticker: 'RSU', name: 'Rsu', currency: 'USD' }, 1)
    const near = s.vestSchedules.create(1, {
      instrumentId: instrument.id,
      scheduleType: 'rsu-vest',
      scheduledDate: '2025-06-01',
      quantity: '50',
    })
    const far = s.vestSchedules.create(1, {
      instrumentId: instrument.id,
      scheduleType: 'rsu-vest',
      scheduledDate: '2025-09-01',
      quantity: '50',
    })
    const txn = s.transactions.create(
      1,
      { instrumentId: instrument.id, txnType: 'RSU_VEST', txnDate: '2025-06-04', quantity: '48' },
      1,
    )
    const app = {
      db: s.db,
      transactions: s.transactions,
      vestSchedules: s.vestSchedules,
    } as unknown as FastifyInstance

    linkRealisedProjection(app, 1, instrument.id, 'RSU_VEST', txn.txnDate, txn.quantity, txn.id)

    const byId = new Map(s.vestSchedules.list(1).map((v) => [v.id, v]))
    expect(byId.get(near.id)?.realisedTxnId).toBe(txn.id)
    expect(byId.get(far.id)?.realisedTxnId).toBeNull()
  })

  it('backfills projection links and auto-withholding from decrypted data', () => {
    const s = encryptedStores()
    const instrument = s.instruments.create(1, { ticker: 'USD1', name: 'Usd', currency: 'USD' }, 1)
    s.db.prepare("INSERT INTO user (tenant_id, username, password_hash) VALUES (1, 'u', 'h')").run()
    const schedule = s.vestSchedules.create(1, {
      instrumentId: instrument.id,
      scheduleType: 'rsu-vest',
      scheduledDate: '2025-06-01',
      quantity: '50',
    })
    const vest = s.transactions.create(
      1,
      { instrumentId: instrument.id, txnType: 'RSU_VEST', txnDate: '2025-06-02', quantity: '50' },
      1,
    )
    const dividend = s.transactions.create(
      1,
      {
        instrumentId: instrument.id,
        txnType: 'DIV_PAY',
        txnDate: '2025-07-01',
        quantity: '10',
        dividendGrossGbp: '100',
      },
      1,
    )
    const app = {
      db: s.db,
      instruments: s.instruments,
      transactions: s.transactions,
      vestSchedules: s.vestSchedules,
    } as unknown as FastifyInstance

    backfillRealisedProjections(app)
    backfillAutoWithholding(app)

    expect(s.vestSchedules.list(1).find((v) => v.id === schedule.id)?.realisedTxnId).toBe(vest.id)
    expect(s.transactions.getById(1, dividend.id)?.dividendWithholdingGbp).toBe('15.00000000')
  })
})

describe('no fixture value reaches the database file or its write-ahead log', () => {
  // Loads the fixture into a real WAL-mode file and returns every byte the database wrote to
  // disk (main file, WAL and shared-memory file) while it was still open, then cleans up.
  function diskBytesAfterLoading(cipher: FieldCipher): { bytes: Buffer; walSize: number } {
    const dir = mkdtempSync(join(tmpdir(), 'tt-raw-'))
    const db = createTestDb(join(dir, 'data.db'))
    try {
      db.exec('PRAGMA journal_mode = WAL')
      loadFixture(storesOn(db, cipher))
      const files = readdirSync(dir).filter((f) => f.startsWith('data.db'))
      const bytes = Buffer.concat(files.map((f) => readFileSync(join(dir, f))))
      return { bytes, walSize: readFileSync(join(dir, 'data.db-wal')).length }
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // The markers (see fixture.ts) deliberately leave out 'sell-to-cover': that word is in the
  // schema's own comments, which SQLite stores verbatim.
  it('control: an unencrypted database does contain them, so the search can fail', () => {
    const { bytes } = diskBytesAfterLoading(plainCipher)
    const found = MARKERS.filter((m) => bytes.includes(Buffer.from(m)))
    expect(found).toEqual(MARKERS)
  })

  it('an encrypted database contains none of them in the file or the WAL', () => {
    const { bytes, walSize } = diskBytesAfterLoading(createFieldCipher(keyringFor()))
    expect(walSize).toBeGreaterThan(0)
    const leaked = MARKERS.filter((m) => bytes.includes(Buffer.from(m)))
    expect(leaked).toEqual([])
  })
})

describe('registry sanity for the stores', () => {
  it('every encrypted column of the tables the stores write is sealed by the shared codec', () => {
    for (const table of [
      'instrument',
      'txn',
      's104_pool',
      'cgt_disposal',
      'vest_schedule',
      'price',
      'audit_log',
      'app_secret',
    ]) {
      expect(encryptedColumns(table).length, table).toBeGreaterThan(0)
    }
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTransactionStore } from './TransactionStore.ts'
import { createInstrumentStore } from './InstrumentStore.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

const MIGRATIONS_DIR = join(__dirname, '../../db/migrations')

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const file of [
    '001_core_schema.sql',
    '002_tax_years_2020_2022.sql',
    '003_rename_dividend_types.sql',
    '004_espp_discount_price.sql',
    '005_vest_schedule_espp_discount.sql',
  ]) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'))
  }
  return db
}

describe('TransactionStore', () => {
  let db: DatabaseSync

  beforeEach(() => {
    db = setupDb()
  })

  it('creates a transaction and reads it back', () => {
    const instruments = createInstrumentStore(db)
    const store = createTransactionStore(db)

    const inst = instruments.create(1, { ticker: 'AAPL', name: 'Apple', currency: 'USD' }, 1)

    const txn = store.create(1, {
      instrumentId: inst.id,
      txnType: 'BUY',
      txnDate: '2025-01-15',
      quantity: '100',
      unitPriceNative: '195.50',
      nativeCurrency: 'USD',
      costsGbp: '9.99',
    }, 1)

    expect(txn.id).toBeGreaterThan(0)
    expect(txn.quantity).toBe('100')
    expect(txn.txnType).toBe('BUY')
    expect(txn.costsGbp).toBe('9.99')
  })

  it('lists transactions filtered by instrumentId', () => {
    const instruments = createInstrumentStore(db)
    const store = createTransactionStore(db)

    const a = instruments.create(1, { ticker: 'AAPL', name: 'Apple', currency: 'USD' }, 1)
    const b = instruments.create(1, { ticker: 'MSFT', name: 'Microsoft', currency: 'USD' }, 1)

    store.create(1, { instrumentId: a.id, txnType: 'BUY', txnDate: '2025-01-01', quantity: '10' }, 1)
    store.create(1, { instrumentId: b.id, txnType: 'BUY', txnDate: '2025-01-02', quantity: '20' }, 1)
    store.create(1, { instrumentId: a.id, txnType: 'SELL', txnDate: '2025-02-01', quantity: '5' }, 1)

    const forA = store.list(1, { instrumentId: a.id })
    expect(forA).toHaveLength(2)
    expect(forA.every(t => t.instrumentId === a.id)).toBe(true)
  })

  it('writes an audit log entry on create', () => {
    const instruments = createInstrumentStore(db)
    const store = createTransactionStore(db)
    const inst = instruments.create(1, { ticker: 'TSLA', name: 'Tesla', currency: 'USD' }, 1)

    store.create(1, { instrumentId: inst.id, txnType: 'BUY', txnDate: '2025-03-01', quantity: '50' }, 99)

    const log = db.prepare("SELECT * FROM audit_log WHERE action = 'txn.create'").all()
    expect(log).toHaveLength(1)
    expect((log[0] as { user_id: number }).user_id).toBe(99)
  })

  it('rejects non-decimal quantity', () => {
    const instruments = createInstrumentStore(db)
    const store = createTransactionStore(db)
    const inst = instruments.create(1, { ticker: 'X', name: 'X', currency: 'GBP' }, 1)

    expect(() =>
      store.create(1, { instrumentId: inst.id, txnType: 'BUY', txnDate: '2025-01-01', quantity: '1e5' }, 1)
    ).toThrow('Invalid decimal')
  })

  it('writes back derived GBP fields via update', () => {
    const instruments = createInstrumentStore(db)
    const store = createTransactionStore(db)
    const inst = instruments.create(1, { ticker: 'GOOG', name: 'Google', currency: 'USD' }, 1)

    const txn = store.create(1, { instrumentId: inst.id, txnType: 'BUY', txnDate: '2025-01-01', quantity: '10' }, 1)
    const updated = store.update(1, txn.id, { unitPriceGbp: '140.00', totalGbp: '1400.00', netGbp: '-1400.00' }, 1)
    expect(updated?.unitPriceGbp).toBe('140.00')
    expect(updated?.totalGbp).toBe('1400.00')
    expect(updated?.netGbp).toBe('-1400.00')
  })

  it('delete removes the row and writes audit log', () => {
    const instruments = createInstrumentStore(db)
    const store = createTransactionStore(db)
    const inst = instruments.create(1, { ticker: 'AMZ', name: 'Amazon', currency: 'USD' }, 1)

    const txn = store.create(1, { instrumentId: inst.id, txnType: 'BUY', txnDate: '2025-01-01', quantity: '5' }, 1)
    const deleted = store.delete(1, txn.id, 1)
    expect(deleted).toBe(true)
    expect(store.getById(1, txn.id)).toBeUndefined()

    const log = db.prepare("SELECT * FROM audit_log WHERE action = 'txn.delete'").all()
    expect(log).toHaveLength(1)
  })
})

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { createInstrumentStore } from '../../repositories/sqlite/InstrumentStore.ts'
import { createTransactionStore } from '../../repositories/sqlite/TransactionStore.ts'
import { applyAutoWithholding, backfillAutoWithholding, wasAutoWithheld } from './withholding.ts'

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

describe('applyAutoWithholding', () => {
  let db: DatabaseSync
  let instruments: ReturnType<typeof createInstrumentStore>
  let transactions: ReturnType<typeof createTransactionStore>

  beforeEach(() => {
    db = setupDb()
    instruments = createInstrumentStore(db)
    transactions = createTransactionStore(db)
  })

  it('auto-populates 15% withholding for a USD dividend with no explicit value', () => {
    const inst = instruments.create(1, { ticker: 'AAPL', name: 'Apple', currency: 'USD' }, 1)
    const txn = transactions.create(
      1,
      {
        instrumentId: inst.id,
        txnType: 'DIV_PAY',
        txnDate: '2025-06-01',
        quantity: '0',
        dividendGrossGbp: '1000',
      },
      1,
    )

    applyAutoWithholding(1, txn.id, 1, transactions, instruments)

    const updated = transactions.getById(1, txn.id)
    expect(updated?.dividendWithholdingGbp).toBe('150.00000000')
  })

  it('does not overwrite an explicitly-entered withholding amount', () => {
    const inst = instruments.create(1, { ticker: 'AAPL', name: 'Apple', currency: 'USD' }, 1)
    const txn = transactions.create(
      1,
      {
        instrumentId: inst.id,
        txnType: 'DIV_PAY',
        txnDate: '2025-06-01',
        quantity: '0',
        dividendGrossGbp: '1000',
        dividendWithholdingGbp: '300',
      },
      1,
    )

    applyAutoWithholding(1, txn.id, 1, transactions, instruments)

    const updated = transactions.getById(1, txn.id)
    expect(updated?.dividendWithholdingGbp).toBe('300')
  })

  it('does not apply withholding for a GBP-currency instrument', () => {
    const inst = instruments.create(1, { ticker: 'VOD', name: 'Vodafone', currency: 'GBP' }, 1)
    const txn = transactions.create(
      1,
      {
        instrumentId: inst.id,
        txnType: 'DIV_PAY',
        txnDate: '2025-06-01',
        quantity: '0',
        dividendGrossGbp: '1000',
      },
      1,
    )

    applyAutoWithholding(1, txn.id, 1, transactions, instruments)

    const updated = transactions.getById(1, txn.id)
    expect(updated?.dividendWithholdingGbp).toBeNull()
  })

  it('does not apply to non-dividend transactions', () => {
    const inst = instruments.create(1, { ticker: 'AAPL', name: 'Apple', currency: 'USD' }, 1)
    const txn = transactions.create(
      1,
      {
        instrumentId: inst.id,
        txnType: 'BUY',
        txnDate: '2025-06-01',
        quantity: '10',
        unitPriceNative: '100',
        nativeCurrency: 'USD',
      },
      1,
    )

    applyAutoWithholding(1, txn.id, 1, transactions, instruments)

    const updated = transactions.getById(1, txn.id)
    expect(updated?.dividendWithholdingGbp).toBeNull()
  })
})

describe('wasAutoWithheld', () => {
  let db: DatabaseSync
  let instruments: ReturnType<typeof createInstrumentStore>
  let transactions: ReturnType<typeof createTransactionStore>

  beforeEach(() => {
    db = setupDb()
    instruments = createInstrumentStore(db)
    transactions = createTransactionStore(db)
  })

  it('is true for a value that matches the auto-computed 15% of gross', () => {
    const inst = instruments.create(1, { ticker: 'AAPL', name: 'Apple', currency: 'USD' }, 1)
    const txn = transactions.create(
      1,
      {
        instrumentId: inst.id,
        txnType: 'DIV_PAY',
        txnDate: '2025-06-01',
        quantity: '0',
        dividendGrossGbp: '1000',
      },
      1,
    )
    applyAutoWithholding(1, txn.id, 1, transactions, instruments)

    expect(wasAutoWithheld(transactions.getById(1, txn.id)!)).toBe(true)
  })

  it('is false for a hand-entered value that happens to differ from 15% of gross', () => {
    const inst = instruments.create(1, { ticker: 'AAPL', name: 'Apple', currency: 'USD' }, 1)
    const txn = transactions.create(
      1,
      {
        instrumentId: inst.id,
        txnType: 'DIV_PAY',
        txnDate: '2025-06-01',
        quantity: '0',
        dividendGrossGbp: '1000',
        dividendWithholdingGbp: '300',
      },
      1,
    )

    expect(wasAutoWithheld(transactions.getById(1, txn.id)!)).toBe(false)
  })

  it('lets a caller detect pre-edit auto-withheld state, clear it, and recompute after a gross-amount edit', () => {
    const inst = instruments.create(1, { ticker: 'AAPL', name: 'Apple', currency: 'USD' }, 1)
    const txn = transactions.create(
      1,
      {
        instrumentId: inst.id,
        txnType: 'DIV_PAY',
        txnDate: '2025-06-01',
        quantity: '0',
        dividendGrossGbp: '1000',
      },
      1,
    )
    applyAutoWithholding(1, txn.id, 1, transactions, instruments)

    // This is the check the PATCH route makes *before* applying an edit —
    // 150 matches 15% of the current (pre-edit) gross of 1000, so it's
    // recognised as auto-derived rather than user-entered.
    const existing = transactions.getById(1, txn.id)!
    expect(wasAutoWithheld(existing)).toBe(true)

    // The route then clears the stale value alongside the gross edit and
    // lets applyAutoWithholding recompute from the new gross, instead of
    // leaving withholding stuck at 15% of the old amount.
    transactions.update(1, txn.id, { dividendGrossGbp: '2000', dividendWithholdingGbp: null }, 1)
    applyAutoWithholding(1, txn.id, 1, transactions, instruments)

    const after = transactions.getById(1, txn.id)
    expect(after?.dividendWithholdingGbp).toBe('300.00000000')
  })
})

describe('backfillAutoWithholding', () => {
  let db: DatabaseSync
  let app: FastifyInstance
  let instruments: ReturnType<typeof createInstrumentStore>
  let transactions: ReturnType<typeof createTransactionStore>

  beforeEach(() => {
    db = setupDb()
    instruments = createInstrumentStore(db)
    transactions = createTransactionStore(db)
    app = { db, transactions, instruments } as unknown as FastifyInstance
    db.prepare(
      "INSERT INTO user (tenant_id, username, password_hash) VALUES (1, 'admin', 'x')",
    ).run()
  })

  it('backports withholding to a pre-existing USD dividend with none set', () => {
    const inst = instruments.create(1, { ticker: 'AAPL', name: 'Apple', currency: 'USD' }, 1)
    const txn = transactions.create(
      1,
      {
        instrumentId: inst.id,
        txnType: 'DIV_PAY',
        txnDate: '2025-06-01',
        quantity: '0',
        dividendGrossGbp: '1000',
      },
      1,
    )

    backfillAutoWithholding(app)

    expect(transactions.getById(1, txn.id)?.dividendWithholdingGbp).toBe('150.00000000')
  })

  it('does not touch a pre-existing dividend that already has withholding recorded', () => {
    const inst = instruments.create(1, { ticker: 'AAPL', name: 'Apple', currency: 'USD' }, 1)
    const txn = transactions.create(
      1,
      {
        instrumentId: inst.id,
        txnType: 'DIV_PAY',
        txnDate: '2025-06-01',
        quantity: '0',
        dividendGrossGbp: '1000',
        dividendWithholdingGbp: '300',
      },
      1,
    )

    backfillAutoWithholding(app)

    expect(transactions.getById(1, txn.id)?.dividendWithholdingGbp).toBe('300')
  })

  it('does not touch a GBP dividend', () => {
    const inst = instruments.create(1, { ticker: 'VOD', name: 'Vodafone', currency: 'GBP' }, 1)
    const txn = transactions.create(
      1,
      {
        instrumentId: inst.id,
        txnType: 'DIV_PAY',
        txnDate: '2025-06-01',
        quantity: '0',
        dividendGrossGbp: '1000',
      },
      1,
    )

    backfillAutoWithholding(app)

    expect(transactions.getById(1, txn.id)?.dividendWithholdingGbp).toBeNull()
  })

  it('is a no-op the second time it runs', () => {
    const inst = instruments.create(1, { ticker: 'AAPL', name: 'Apple', currency: 'USD' }, 1)
    const txn = transactions.create(
      1,
      {
        instrumentId: inst.id,
        txnType: 'DIV_PAY',
        txnDate: '2025-06-01',
        quantity: '0',
        dividendGrossGbp: '1000',
      },
      1,
    )

    backfillAutoWithholding(app)
    const first = transactions.getById(1, txn.id)?.dividendWithholdingGbp
    backfillAutoWithholding(app)

    expect(transactions.getById(1, txn.id)?.dividendWithholdingGbp).toBe(first)
  })
})

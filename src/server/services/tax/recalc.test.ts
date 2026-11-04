import type { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { plainCipher } from '../../crypto/fields.ts'
import { createTestDb } from '../../db/testdb.ts'
import { createInstrumentStore } from '../../repositories/sqlite/InstrumentStore.ts'
import { createTransactionStore } from '../../repositories/sqlite/TransactionStore.ts'
import { createVestScheduleStore } from '../../repositories/sqlite/VestScheduleStore.ts'
import { backfillRealisedProjections, linkRealisedProjection } from './recalc.ts'

const setupDb = createTestDb

function makeApp(db: DatabaseSync): FastifyInstance {
  return {
    db,
    transactions: createTransactionStore(db, plainCipher),
    vestSchedules: createVestScheduleStore(db, plainCipher),
  } as unknown as FastifyInstance
}

function insertProjection(
  db: DatabaseSync,
  instrumentId: number,
  scheduledDate: string,
  quantity: string,
): number {
  const result = db
    .prepare(
      `INSERT INTO vest_schedule (tenant_id, instrument_id, schedule_type, scheduled_date, quantity)
       VALUES (1, ?, 'rsu-vest', ?, ?)`,
    )
    .run(instrumentId, scheduledDate, quantity) as unknown as { lastInsertRowid: number }
  return Number(result.lastInsertRowid)
}

function getRealisedTxnId(db: DatabaseSync, projectionId: number): number | null {
  const row = db
    .prepare('SELECT realised_txn_id FROM vest_schedule WHERE id = ?')
    .get(projectionId) as { realised_txn_id: number | null }
  return row.realised_txn_id
}

describe('recalc — projection linking', () => {
  let db: DatabaseSync
  let app: FastifyInstance
  let instrumentId: number

  beforeEach(() => {
    db = setupDb()
    app = makeApp(db)
    const instruments = createInstrumentStore(db, plainCipher)
    instrumentId = instruments.create(1, { ticker: 'AAPL', name: 'Apple', currency: 'USD' }, 1).id
  })

  it('links a transaction dated a few days off from its projection under the tolerance window', () => {
    const projectionId = insertProjection(db, instrumentId, '2025-06-01', '50')
    const txns = createTransactionStore(db, plainCipher)
    const txn = txns.create(
      1,
      {
        instrumentId,
        txnType: 'RSU_VEST',
        txnDate: '2025-06-04',
        quantity: '48',
      },
      1,
    )

    linkRealisedProjection(app, 1, instrumentId, 'RSU_VEST', txn.txnDate, txn.quantity, txn.id)

    expect(getRealisedTxnId(db, projectionId)).toBe(txn.id)
  })

  it('does not link a transaction outside the tolerance window', () => {
    const projectionId = insertProjection(db, instrumentId, '2025-06-01', '50')
    const txns = createTransactionStore(db, plainCipher)
    const txn = txns.create(
      1,
      {
        instrumentId,
        txnType: 'RSU_VEST',
        txnDate: '2025-06-20',
        quantity: '50',
      },
      1,
    )

    linkRealisedProjection(app, 1, instrumentId, 'RSU_VEST', txn.txnDate, txn.quantity, txn.id)

    expect(getRealisedTxnId(db, projectionId)).toBeNull()
  })

  it('does not link across a UK tax-year boundary even within the tolerance window', () => {
    // Scheduled 3 Apr (TY 2024-25); a vest 5 days later on 8 Apr falls in
    // TY 2025-26. Within the ±7-day window, but must not cross tax years —
    // it would silently move projected income out of the wrong year.
    const projectionId = insertProjection(db, instrumentId, '2025-04-03', '50')
    const txns = createTransactionStore(db, plainCipher)
    const txn = txns.create(
      1,
      { instrumentId, txnType: 'RSU_VEST', txnDate: '2025-04-08', quantity: '50' },
      1,
    )

    linkRealisedProjection(app, 1, instrumentId, 'RSU_VEST', txn.txnDate, txn.quantity, txn.id)

    expect(getRealisedTxnId(db, projectionId)).toBeNull()
  })
})

describe('backfillRealisedProjections', () => {
  let db: DatabaseSync
  let app: FastifyInstance
  let instrumentId: number

  beforeEach(() => {
    db = setupDb()
    app = makeApp(db)
    const instruments = createInstrumentStore(db, plainCipher)
    instrumentId = instruments.create(1, { ticker: 'AAPL', name: 'Apple', currency: 'USD' }, 1).id
  })

  it('retroactively links an old projection to a pre-existing matching transaction', () => {
    const projectionId = insertProjection(db, instrumentId, '2025-06-01', '50')
    const txns = createTransactionStore(db, plainCipher)
    const txn = txns.create(
      1,
      { instrumentId, txnType: 'RSU_VEST', txnDate: '2025-06-01', quantity: '50' },
      1,
    )

    backfillRealisedProjections(app)

    expect(getRealisedTxnId(db, projectionId)).toBe(txn.id)
  })

  it('is a no-op the second time it runs', () => {
    const projectionId = insertProjection(db, instrumentId, '2025-06-01', '50')
    const txns = createTransactionStore(db, plainCipher)
    txns.create(1, { instrumentId, txnType: 'RSU_VEST', txnDate: '2025-06-01', quantity: '50' }, 1)

    backfillRealisedProjections(app)
    const linkedAfterFirstRun = getRealisedTxnId(db, projectionId)
    backfillRealisedProjections(app)

    expect(getRealisedTxnId(db, projectionId)).toBe(linkedAfterFirstRun)
  })

  it('leaves a projection unlinked when no matching transaction exists', () => {
    const projectionId = insertProjection(db, instrumentId, '2025-06-01', '50')

    backfillRealisedProjections(app)

    expect(getRealisedTxnId(db, projectionId)).toBeNull()
  })

  it('does not link across a UK tax-year boundary', () => {
    const projectionId = insertProjection(db, instrumentId, '2025-04-03', '50')
    const txns = createTransactionStore(db, plainCipher)
    txns.create(1, { instrumentId, txnType: 'RSU_VEST', txnDate: '2025-04-08', quantity: '50' }, 1)

    backfillRealisedProjections(app)

    expect(getRealisedTxnId(db, projectionId)).toBeNull()
  })

  it("does not let a transaction from one tenant satisfy another tenant's projection", () => {
    db.prepare("INSERT INTO tenant (id, name) VALUES (2, 'other')").run()
    const instruments = createInstrumentStore(db, plainCipher)
    const otherInstrumentId = instruments.create(
      2,
      { ticker: 'AAPL', name: 'Apple', currency: 'USD' },
      1,
    ).id
    const projectionId = insertProjection(db, otherInstrumentId, '2025-06-01', '50')
    db.prepare('UPDATE vest_schedule SET tenant_id = 2 WHERE id = ?').run(projectionId)

    const txns = createTransactionStore(db, plainCipher)
    txns.create(1, { instrumentId, txnType: 'RSU_VEST', txnDate: '2025-06-01', quantity: '50' }, 1)

    backfillRealisedProjections(app)

    expect(getRealisedTxnId(db, projectionId)).toBeNull()
  })
})

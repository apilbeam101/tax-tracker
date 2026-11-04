import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { plainCipher } from '../../crypto/fields.ts'
import { createTestDb } from '../../db/testdb.ts'
import { createInstrumentStore } from '../../repositories/sqlite/InstrumentStore.ts'
import { createTransactionStore } from '../../repositories/sqlite/TransactionStore.ts'
import { createVestScheduleStore } from '../../repositories/sqlite/VestScheduleStore.ts'
import { backfillRealisedProjections, linkRealisedProjection } from './recalc.ts'

// SQLite's date() returned NULL for an impossible date and simply matched nothing. The linking
// code must keep treating such a date as "no match" rather than throwing, or one bad row stops
// the server booting (backfill runs at startup) or fails a save (link runs after create).
describe('projection linking with an impossible date', () => {
  function setup() {
    const db = createTestDb()
    const instruments = createInstrumentStore(db, plainCipher)
    const transactions = createTransactionStore(db, plainCipher)
    const vestSchedules = createVestScheduleStore(db, plainCipher)
    const app = { db, instruments, transactions, vestSchedules } as unknown as FastifyInstance
    const instrument = instruments.create(1, { ticker: 'AAPL', name: 'Apple', currency: 'USD' }, 1)
    return { app, instrument, transactions, vestSchedules }
  }

  it.each(['2025-13-01', '2025-01-32', '2025-00-10'])(
    'the startup backfill skips a projection dated %s and still links the valid ones',
    (badDate) => {
      const { app, instrument, transactions, vestSchedules } = setup()
      vestSchedules.create(1, {
        instrumentId: instrument.id,
        scheduleType: 'rsu-vest',
        scheduledDate: badDate,
        quantity: '10',
      })
      const good = vestSchedules.create(1, {
        instrumentId: instrument.id,
        scheduleType: 'rsu-vest',
        scheduledDate: '2025-06-01',
        quantity: '50',
      })
      const txn = transactions.create(
        1,
        { instrumentId: instrument.id, txnType: 'RSU_VEST', txnDate: '2025-06-02', quantity: '50' },
        1,
      )

      expect(() => backfillRealisedProjections(app)).not.toThrow()

      expect(vestSchedules.list(1).find((v) => v.id === good.id)?.realisedTxnId).toBe(txn.id)
    },
  )

  it('linking a transaction with an impossible date links nothing and does not throw', () => {
    const { app, instrument, transactions, vestSchedules } = setup()
    const schedule = vestSchedules.create(1, {
      instrumentId: instrument.id,
      scheduleType: 'rsu-vest',
      scheduledDate: '2025-06-01',
      quantity: '50',
    })
    const txn = transactions.create(
      1,
      { instrumentId: instrument.id, txnType: 'RSU_VEST', txnDate: '2025-13-01', quantity: '50' },
      1,
    )

    expect(() =>
      linkRealisedProjection(app, 1, instrument.id, 'RSU_VEST', txn.txnDate, txn.quantity, txn.id),
    ).not.toThrow()
    expect(vestSchedules.list(1).find((v) => v.id === schedule.id)?.realisedTxnId).toBeNull()
  })
})

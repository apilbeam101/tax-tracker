import type { FastifyInstance } from 'fastify'
import { runTaxEngineForInstrument } from './engine.ts'

// Schedule types (vest_schedule) that a confirmed transaction can realise.
const SCHEDULE_TYPE_BY_TXN_TYPE: Record<string, string> = {
  RSU_VEST: 'rsu-vest',
  ESPP_PURCHASE: 'espp-purchase',
}

/**
 * Re-run CGT matching for the instrument so the S104 pool and disposal records
 * stay in sync with a transaction that was just created/edited/deleted.
 * Errors are logged, not thrown: a momentarily inconsistent history (e.g. a
 * SELL entered before its matching BUY) shouldn't block the save — "Run tax
 * engine" on the Tax Summary page remains available to surface and fix real
 * matching errors on demand.
 */
export function recalcInstrument(app: FastifyInstance, tenantId: number, instrumentId: number): void {
  try {
    runTaxEngineForInstrument(tenantId, instrumentId, app.transactions, app.cgtDisposals, app.s104Pools)
  } catch (err) {
    app.log.warn(
      { err, tenantId, instrumentId },
      'tax engine recalc failed — S104 pool and disposals left stale for this instrument until the next successful recalc or a manual "Run tax engine"',
    )
  }
}

/**
 * Link a newly-confirmed RSU vest / ESPP purchase to a pending Projections
 * entry scheduled for the same instrument and date, so it stops double-
 * counting as a projected estimate on the Tax Summary page once the real
 * transaction exists. Among candidates on the same date, prefers the one
 * whose quantity is closest to the actual transaction (RSU/ESPP quantities
 * commonly differ slightly from the projection, e.g. after tax withholding).
 */
export function linkRealisedProjection(
  app: FastifyInstance,
  tenantId: number,
  instrumentId: number,
  txnType: string,
  txnDate: string,
  quantity: string,
  txnId: number,
): void {
  const scheduleType = SCHEDULE_TYPE_BY_TXN_TYPE[txnType]
  if (!scheduleType) return

  app.db.prepare(`
    UPDATE vest_schedule SET realised_txn_id = ?
    WHERE id = (
      SELECT id FROM vest_schedule
      WHERE tenant_id = ? AND instrument_id = ? AND schedule_type = ?
        AND scheduled_date = ? AND realised_txn_id IS NULL
      ORDER BY ABS(CAST(quantity AS REAL) - CAST(? AS REAL)) ASC, id ASC
      LIMIT 1
    )
  `).run(txnId, tenantId, instrumentId, scheduleType, txnDate, quantity)
}

/** Unlink any Projections entry currently marked as realised by this transaction. */
export function unlinkRealisedProjection(app: FastifyInstance, tenantId: number, txnId: number): void {
  app.db.prepare(
    'UPDATE vest_schedule SET realised_txn_id = NULL WHERE tenant_id = ? AND realised_txn_id = ?',
  ).run(tenantId, txnId)
}

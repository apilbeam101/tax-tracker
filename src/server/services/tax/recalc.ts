import type { FastifyInstance } from 'fastify'
import { runTaxEngineForInstrument } from './engine.ts'
import { taxYearForDate } from './matching.ts'

// Schedule types (vest_schedule) that a confirmed transaction can realise.
const SCHEDULE_TYPE_BY_TXN_TYPE: Record<string, string> = {
  RSU_VEST: 'rsu-vest',
  ESPP_PURCHASE: 'espp-purchase',
}
const TXN_TYPE_BY_SCHEDULE_TYPE: Record<string, string> = {
  'rsu-vest': 'RSU_VEST',
  'espp-purchase': 'ESPP_PURCHASE',
}

// Real settlement dates commonly drift from the scheduled date (weekends,
// broker settlement lag, holidays) — widen the match instead of requiring
// exact equality.
const LINK_DATE_TOLERANCE_DAYS = 7

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000
}

interface LinkCandidate {
  id: number
  date: string
  quantity: string
}

// Picks the closest-date-then-closest-quantity candidate that falls in the
// same UK tax year as the anchor date. The ±N-day tolerance window can
// straddle 5/6 April; without this check a vest/purchase a few days into a
// new tax year could silently consume the previous year's projection (or
// vice versa), corrupting which year the projected income shows up in.
function pickBestCandidate<T extends LinkCandidate>(
  candidates: T[],
  anchorDate: string,
  anchorQuantity: string,
): T | undefined {
  const anchorTaxYear = taxYearForDate(anchorDate)
  const sameYear = candidates.filter((c) => taxYearForDate(c.date) === anchorTaxYear)
  if (sameYear.length === 0) return undefined

  const qty = parseFloat(anchorQuantity)
  sameYear.sort((a, b) => {
    const dateDiff = daysBetween(a.date, anchorDate) - daysBetween(b.date, anchorDate)
    if (dateDiff !== 0) return dateDiff
    return Math.abs(parseFloat(a.quantity) - qty) - Math.abs(parseFloat(b.quantity) - qty)
  })
  return sameYear[0]
}

/**
 * Re-run CGT matching for the instrument so the S104 pool and disposal records
 * stay in sync with a transaction that was just created/edited/deleted.
 * Errors are logged, not thrown: a momentarily inconsistent history (e.g. a
 * SELL entered before its matching BUY) shouldn't block the save — "Run tax
 * engine" on the Tax Summary page remains available to surface and fix real
 * matching errors on demand.
 */
export function recalcInstrument(
  app: FastifyInstance,
  tenantId: number,
  instrumentId: number,
): void {
  try {
    runTaxEngineForInstrument(
      tenantId,
      instrumentId,
      app.transactions,
      app.cgtDisposals,
      app.s104Pools,
    )
  } catch (err) {
    app.log.warn(
      { err, tenantId, instrumentId },
      'tax engine recalc failed — S104 pool and disposals left stale for this instrument until the next successful recalc or a manual "Run tax engine"',
    )
  }
}

/**
 * Link a newly-confirmed RSU vest / ESPP purchase to a pending Projections
 * entry scheduled for the same instrument within a tolerance window of the
 * transaction date, so it stops double-counting as a projected estimate on
 * the Tax Summary page once the real transaction exists. Among candidates,
 * prefers the closest scheduled date, then the closest quantity (RSU/ESPP
 * quantities commonly differ slightly from the projection, e.g. after tax
 * withholding).
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

  const candidates = app.db
    .prepare(`
      SELECT id, scheduled_date AS date, quantity
      FROM vest_schedule
      WHERE tenant_id = ? AND instrument_id = ? AND schedule_type = ?
        AND scheduled_date BETWEEN date(?, '-${LINK_DATE_TOLERANCE_DAYS} days') AND date(?, '+${LINK_DATE_TOLERANCE_DAYS} days')
        AND realised_txn_id IS NULL
    `)
    .all(tenantId, instrumentId, scheduleType, txnDate, txnDate) as unknown as LinkCandidate[]

  const best = pickBestCandidate(candidates, txnDate, quantity)
  if (!best) return

  app.db
    .prepare('UPDATE vest_schedule SET realised_txn_id = ? WHERE tenant_id = ? AND id = ?')
    .run(txnId, tenantId, best.id)
}

/**
 * One-off reconciliation pass over every pending (unlinked) Projections entry,
 * matching it against transactions that already existed before automatic
 * linking was introduced. Idempotent — safe to run on every server start; a
 * projection that's already linked, or has no matching transaction, is left
 * untouched.
 */
export function backfillRealisedProjections(app: FastifyInstance): void {
  const pending = app.db
    .prepare(`
      SELECT id, tenant_id, instrument_id, schedule_type, scheduled_date, quantity
      FROM vest_schedule WHERE realised_txn_id IS NULL
      ORDER BY scheduled_date ASC, id ASC
    `)
    .all() as {
    id: number
    tenant_id: number
    instrument_id: number
    schedule_type: string
    scheduled_date: string
    quantity: string
  }[]

  for (const row of pending) {
    const txnType = TXN_TYPE_BY_SCHEDULE_TYPE[row.schedule_type]
    if (!txnType) continue

    const candidates = app.db
      .prepare(`
        SELECT id, txn_date AS date, quantity
        FROM txn
        WHERE tenant_id = ? AND instrument_id = ? AND txn_type = ?
          AND txn_date BETWEEN date(?, '-${LINK_DATE_TOLERANCE_DAYS} days') AND date(?, '+${LINK_DATE_TOLERANCE_DAYS} days')
          AND id NOT IN (
            SELECT realised_txn_id FROM vest_schedule
            WHERE tenant_id = ? AND realised_txn_id IS NOT NULL
          )
      `)
      .all(
        row.tenant_id,
        row.instrument_id,
        txnType,
        row.scheduled_date,
        row.scheduled_date,
        row.tenant_id,
      ) as unknown as LinkCandidate[]

    const best = pickBestCandidate(candidates, row.scheduled_date, row.quantity)
    if (!best) continue

    app.db
      .prepare('UPDATE vest_schedule SET realised_txn_id = ? WHERE tenant_id = ? AND id = ?')
      .run(best.id, row.tenant_id, row.id)
  }
}

/** Unlink any Projections entry currently marked as realised by this transaction. */
export function unlinkRealisedProjection(
  app: FastifyInstance,
  tenantId: number,
  txnId: number,
): void {
  app.db
    .prepare(
      'UPDATE vest_schedule SET realised_txn_id = NULL WHERE tenant_id = ? AND realised_txn_id = ?',
    )
    .run(tenantId, txnId)
}

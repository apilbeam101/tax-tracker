import Big from 'big.js'
import type { FastifyInstance } from 'fastify'
import type { Transaction } from '../../../shared/types.ts'
import type { InstrumentStore, TransactionStore } from '../../repositories/index.ts'

/**
 * US-UK Double Taxation Convention, Article 10 — the treaty rate for
 * dividends paid to a UK-resident individual portfolio holder with a valid
 * W-8BEN on file. Without a W-8BEN, the US statutory default is 30%.
 * Reference: HMRC DT9552; IRS Pub. 515.
 */
export const US_TREATY_DIVIDEND_WITHHOLDING_RATE = '0.15'

function autoWithholdingFor(grossGbp: string): string {
  return new Big(grossGbp).times(US_TREATY_DIVIDEND_WITHHOLDING_RATE).toFixed(8)
}

/**
 * True when a transaction's stored withholding exactly matches what
 * auto-withholding would have computed from its current gross — i.e. it was
 * (most likely) auto-populated rather than typed in by hand. Used to decide
 * whether a later edit to the gross amount should trigger a recompute: an
 * edit shouldn't touch a value the user entered or corrected themselves, but
 * leaving a stale auto-computed figure in place after the gross changes would
 * silently understate the foreign tax credit.
 */
export function wasAutoWithheld(txn: Transaction): boolean {
  if (txn.txnType !== 'DIV_PAY' || !txn.dividendWithholdingGbp) return false
  const grossGbp = txn.dividendGrossGbp ?? txn.totalGbp
  if (!grossGbp) return false
  return new Big(txn.dividendWithholdingGbp).eq(autoWithholdingFor(grossGbp))
}

/**
 * Auto-populates dividend_withholding_gbp for a USD-currency dividend when
 * no withholding was explicitly supplied at entry/import time, so IRS
 * withholding is tracked without requiring manual entry. An explicitly
 * entered or later-edited value (e.g. reconciled against a real broker
 * statement) always takes precedence and is never overwritten — callers that
 * need to recompute after a gross-amount edit should clear the field first
 * (see `wasAutoWithheld`) rather than relying on this function to overwrite it.
 */
export function applyAutoWithholding(
  tenantId: number,
  txnId: number,
  userId: number,
  transactions: TransactionStore,
  instruments: InstrumentStore,
): void {
  const txn = transactions.getById(tenantId, txnId)
  if (txn?.txnType !== 'DIV_PAY' || txn.dividendWithholdingGbp) return

  const instrument = instruments.getById(tenantId, txn.instrumentId)
  if (instrument?.currency !== 'USD') return

  const grossGbp = txn.dividendGrossGbp ?? txn.totalGbp
  if (!grossGbp) return

  transactions.update(
    tenantId,
    txnId,
    { dividendWithholdingGbp: autoWithholdingFor(grossGbp) },
    userId,
  )
}

/**
 * One-off reconciliation pass, run once at server startup, that applies
 * auto-withholding to USD-currency `DIV_PAY` transactions that already
 * existed before this feature shipped (so restarting the server backports it
 * to existing data instead of only new transactions going forward).
 * Idempotent — `applyAutoWithholding` is a no-op once a transaction already
 * has a withholding value, auto-derived or explicit.
 */
export function backfillAutoWithholding(app: FastifyInstance): void {
  const candidates = app.db
    .prepare(`
      SELECT t.id AS txn_id, t.tenant_id AS tenant_id
      FROM txn t
      JOIN instrument i ON i.id = t.instrument_id
      WHERE t.txn_type = 'DIV_PAY'
        AND i.currency = 'USD'
        AND (t.dividend_withholding_gbp IS NULL OR t.dividend_withholding_gbp = '')
    `)
    .all() as unknown as { txn_id: number; tenant_id: number }[]

  if (candidates.length === 0) return

  // Attribute the backfill's audit-log entries to the tenant's own user
  // rather than a fabricated system id, so the trail reads the same as if
  // the user had triggered the recompute themselves.
  const userIdByTenant = new Map<number, number>()

  for (const row of candidates) {
    let userId = userIdByTenant.get(row.tenant_id)
    if (userId === undefined) {
      const user = app.db
        .prepare('SELECT id FROM user WHERE tenant_id = ? ORDER BY id ASC LIMIT 1')
        .get(row.tenant_id) as { id: number } | undefined
      if (!user) continue
      userId = user.id
      userIdByTenant.set(row.tenant_id, userId)
    }
    applyAutoWithholding(row.tenant_id, row.txn_id, userId, app.transactions, app.instruments)
  }
}

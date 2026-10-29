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
  // The withholding amount and the instrument's currency are not queryable in SQL (the amount
  // is encrypted), so the filter runs over the decrypted domain objects.
  const tenantIds = (
    app.db.prepare('SELECT DISTINCT tenant_id FROM instrument').all() as unknown as {
      tenant_id: number
    }[]
  ).map((r) => r.tenant_id)

  for (const tenantId of tenantIds) {
    const usdInstrumentIds = new Set(
      app.instruments
        .list(tenantId)
        .filter((i) => i.currency === 'USD')
        .map((i) => i.id),
    )
    const candidates = app.transactions
      .list(tenantId)
      .filter(
        (t) =>
          t.txnType === 'DIV_PAY' &&
          usdInstrumentIds.has(t.instrumentId) &&
          !t.dividendWithholdingGbp,
      )
    if (candidates.length === 0) continue

    // Attribute the backfill's audit-log entries to the tenant's own user
    // rather than a fabricated system id, so the trail reads the same as if
    // the user had triggered the recompute themselves.
    const user = app.db
      .prepare('SELECT id FROM user WHERE tenant_id = ? ORDER BY id ASC LIMIT 1')
      .get(tenantId) as { id: number } | undefined
    if (!user) continue

    for (const txn of candidates) {
      applyAutoWithholding(tenantId, txn.id, user.id, app.transactions, app.instruments)
    }
  }
}

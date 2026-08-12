/**
 * Tax engine entry point.
 *
 * Runs CGT share matching for all instruments of a tenant, persists the
 * resulting disposal records and updated S104 pool states, and returns
 * per-tax-year summaries.
 *
 * The engine is designed to be idempotent: running it again replaces the
 * previously persisted disposal records and pool states for each instrument.
 *
 * Inputs must have unitPriceGbp populated on all price-carrying transactions.
 * Run scripts/backfill-fx.ts first if importing from Ghostfolio or other
 * sources that don't include GBP values.
 */

import type { TaxYearConfig } from '../../../shared/types.ts'
import type { TransactionStore } from '../../repositories/index.ts'
import type { CgtDisposalStore } from '../../repositories/sqlite/CgtDisposalStore.ts'
import type { S104PoolStore } from '../../repositories/sqlite/S104PoolStore.ts'
import { buildCgtSummary } from './cgt_summary.ts'
import { matchDisposals } from './matching.ts'

export interface TaxEngineResult {
  instrumentsProcessed: number
  disposalsRecorded: number
  summaries: Record<string, ReturnType<typeof buildCgtSummary>>
}

/**
 * Run the full tax engine for a tenant.
 *
 * @param tenantId
 * @param transactions     TransactionStore — the engine reads all transactions.
 * @param disposalStore    CgtDisposalStore — persistence for disposal records.
 * @param poolStore        S104PoolStore — persistence for pool states.
 * @param taxYearConfigs   All TaxYearConfig rows (used for CGT summaries).
 * @param incomeByYear     Optional: estimated total employment income per tax year
 *                         (used for rate band apportionment).  Keyed by taxYear string.
 */
export function runTaxEngine(
  tenantId: number,
  transactions: TransactionStore,
  disposalStore: CgtDisposalStore,
  poolStore: S104PoolStore,
  taxYearConfigs: TaxYearConfig[],
  incomeByYear: Record<string, string> = {},
): TaxEngineResult {
  const configByYear = new Map(taxYearConfigs.map((c) => [c.taxYear, c]))

  // Get all transactions for this tenant, sorted by date
  const allTxns = transactions.list(tenantId)

  // Group by instrument
  const byInstrument = new Map<number, typeof allTxns>()
  for (const txn of allTxns) {
    const list = byInstrument.get(txn.instrumentId) ?? []
    list.push(txn)
    byInstrument.set(txn.instrumentId, list)
  }

  const allDisposals: ReturnType<typeof matchDisposals>['disposals'] = []
  let instrumentsProcessed = 0

  for (const [instrumentId, txns] of byInstrument) {
    const { disposals, pool } = matchDisposals(txns)

    // Atomically replace this instrument's disposal records: a txn that was
    // deleted or edited since the last run may no longer appear in the freshly
    // computed `disposals` array, so the old delete-then-upsert approach could
    // leave stale rows behind (if keyed only on the new array's txn IDs) or
    // wipe all disposals with nothing to show for it (if the insert half
    // failed after the delete had already committed). replaceForInstrument
    // does both in one transaction, rolling back on failure.
    disposalStore.replaceForInstrument(tenantId, instrumentId, disposals)

    // Persist updated pool state
    poolStore.save(tenantId, instrumentId, pool)

    allDisposals.push(...disposals)
    instrumentsProcessed++
  }

  // Build per-tax-year summaries across all instruments
  const disposalsByYear = new Map<string, typeof allDisposals>()
  for (const d of allDisposals) {
    const list = disposalsByYear.get(d.taxYear) ?? []
    list.push(d)
    disposalsByYear.set(d.taxYear, list)
  }

  const summaries: TaxEngineResult['summaries'] = {}
  for (const [year, disposals] of disposalsByYear) {
    const config = configByYear.get(year)
    if (!config) continue // no config for this year — skip
    summaries[year] = buildCgtSummary(disposals, config, incomeByYear[year] ?? '0')
  }

  return {
    instrumentsProcessed,
    disposalsRecorded: allDisposals.length,
    summaries,
  }
}

/**
 * Re-run matching for a single instrument only (faster path for incremental updates).
 */
export function runTaxEngineForInstrument(
  tenantId: number,
  instrumentId: number,
  transactions: TransactionStore,
  disposalStore: CgtDisposalStore,
  poolStore: S104PoolStore,
): {
  disposals: ReturnType<typeof matchDisposals>['disposals']
  pool: ReturnType<typeof matchDisposals>['pool']
} {
  const txns = transactions.list(tenantId, { instrumentId })
  const { disposals, pool } = matchDisposals(txns)

  disposalStore.replaceForInstrument(tenantId, instrumentId, disposals)
  poolStore.save(tenantId, instrumentId, pool)

  return { disposals, pool }
}

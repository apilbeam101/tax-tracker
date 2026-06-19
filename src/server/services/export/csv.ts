/**
 * Generic CSV exporter for transactions or disposals.
 *
 * Uses csv-stringify. Columns are configurable; defaults export every
 * non-null field present on the Transaction type.
 */

import { stringify } from 'csv-stringify/sync'
import type { Transaction, Instrument } from '../../../shared/types.ts'
import type { CgtDisposalRecord } from '../tax/matching.ts'

// ── Transaction CSV ──────────────────────────────────────────────────────────

const TXN_COLUMNS: (keyof Transaction)[] = [
  'id', 'txnType', 'txnDate', 'quantity',
  'unitPriceNative', 'nativeCurrency', 'fxRate', 'fxRateType', 'fxRateSource',
  'unitPriceGbp', 'totalGbp', 'costsGbp', 'netGbp', 'incomeAmountGbp',
  'esppDiscountPriceNative', 'esppDiscountPriceGbp',
  'rsuGrossSharesVested', 'rsuSharesWithheld', 'rsuWithholdingRate', 'rsuWithholdingMethod',
  'dividendGrossGbp', 'dividendWithholdingGbp', 'dividendNetGbp',
  'splitRatio', 'capreturnsPerShareGbp',
  'notes', 'importSource', 'createdAt',
]

export function transactionsToCsv(
  txns: Transaction[],
  instrumentsById: Map<number, Instrument>,
  columns: (keyof Transaction)[] = TXN_COLUMNS,
): string {
  const header = ['ticker', ...columns]
  const rows = txns.map(txn => {
    const instrument = instrumentsById.get(txn.instrumentId)
    return [instrument?.ticker ?? '', ...columns.map(col => txn[col] ?? '')]
  })
  return stringify([header, ...rows])
}

// ── Disposal CSV ─────────────────────────────────────────────────────────────

const DISPOSAL_COLUMNS: (keyof CgtDisposalRecord)[] = [
  'taxYear', 'disposalDate', 'matchType',
  'quantity', 'proceedsGbp', 'allowableCostGbp', 'sellingCostsGbp', 'gainGbp',
]

export function disposalsToCsv(
  disposals: CgtDisposalRecord[],
  instrumentsById: Map<number, Instrument>,
  columns: (keyof CgtDisposalRecord)[] = DISPOSAL_COLUMNS,
): string {
  const header = ['ticker', ...columns]
  const rows = disposals.map(d => {
    const instrument = instrumentsById.get(d.instrumentId)
    return [instrument?.ticker ?? '', ...columns.map(col => d[col] ?? '')]
  })
  return stringify([header, ...rows])
}

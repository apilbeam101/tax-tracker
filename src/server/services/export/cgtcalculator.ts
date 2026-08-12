/**
 * Exporter for cgtcalculator.com import format.
 *
 * Format (tab-separated per the site spec):
 *   B/S  DATE        COMPANY  SHARES  PRICE   CHARGES  [TAX]  [STOCK_TYPE]
 *
 * Rules (from cgtcalculator.com/instructions.htm):
 *   - Delimiter: tab (or spaces)
 *   - DATE: DD/MM/YYYY
 *   - PRICE: GBP (pounds, not pence)
 *   - CHARGES: GBP
 *   - TAX (stamp duty): optional; if omitted the site defaults to 0.5% on buys,
 *     0 on sells. We emit 0 explicitly for non-UK stocks to avoid that default.
 *   - STOCK_TYPE: 'U' for AIM/OFEX/unquoted; blank otherwise. We always omit it
 *     (blank) since we can't reliably determine AIM status.
 *   - Only price-bearing acquisition and disposal types are exported; events like
 *     SPLIT that have no GBP price are silently skipped.
 */

import type { Instrument, Transaction } from '../../../shared/types.ts'

export interface CgtCalculatorRow {
  action: 'B' | 'S'
  date: string // DD/MM/YYYY
  company: string
  shares: string
  price: string // GBP pounds
  charges: string // GBP pounds
  stampDuty: string // GBP pounds (0 for non-UK stocks)
}

const ACQUISITION_TYPES = new Set([
  'BUY',
  'RSU_VEST',
  'ESPP_PURCHASE',
  'TRANSFER_IN',
  'RIGHTS_ISSUE',
  'DRIP',
])
const DISPOSAL_TYPES = new Set(['SELL', 'TRANSFER_OUT'])

function toDdMmYyyy(isoDate: string): string {
  const [y, m, d] = isoDate.split('-')
  return `${d}/${m}/${y}`
}

export function toCgtCalculatorRows(
  txns: Transaction[],
  instrumentsById: Map<number, Instrument>,
): CgtCalculatorRow[] {
  const rows: CgtCalculatorRow[] = []

  for (const txn of txns) {
    if (!ACQUISITION_TYPES.has(txn.txnType) && !DISPOSAL_TYPES.has(txn.txnType)) continue
    if (!txn.unitPriceGbp) continue

    const instrument = instrumentsById.get(txn.instrumentId)
    const company = instrument?.ticker ?? String(txn.instrumentId)

    rows.push({
      action: ACQUISITION_TYPES.has(txn.txnType) ? 'B' : 'S',
      date: toDdMmYyyy(txn.txnDate),
      company,
      shares: txn.quantity,
      price: txn.unitPriceGbp,
      charges: txn.costsGbp ?? '0',
      stampDuty: '0',
    })
  }

  return rows
}

export function formatCgtCalculator(rows: CgtCalculatorRow[]): string {
  return rows
    .map((r) => [r.action, r.date, r.company, r.shares, r.price, r.charges, r.stampDuty].join('\t'))
    .join('\n')
}

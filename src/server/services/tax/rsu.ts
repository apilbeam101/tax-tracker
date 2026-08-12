/**
 * RSU vest employment income calculation.
 *
 * The employment income charge arises on the GROSS shares vested (all shares ×
 * vest price), regardless of withholding method.  PAYE is deducted by the
 * employer; the resulting income_amount_gbp is the figure to report on a
 * Self Assessment return under "employment income from share schemes".
 *
 * Pool treatment:
 *   net-settlement  — only net shares (quantity on the txn) enter the S104 pool;
 *                     withheld shares are never in the user's ownership.
 *   sell-to-cover   — all gross shares briefly enter the pool; a companion SELL
 *                     txn is expected in the transaction list to cover the tax.
 *   cash            — all gross shares enter the pool (user paid from other funds).
 *
 * Base cost = vest_price_gbp × net (or gross) shares that enter the pool.
 * CGT is on post-vest appreciation only because the employment income has
 * already set the cost basis at vest price.
 */
import Big from 'big.js'
import type { Transaction } from '../../../shared/types.ts'

export interface RsuVestIncome {
  txnId: number
  taxYear: string
  grossSharesVested: string
  vestPriceGbp: string
  incomeAmountGbp: string
  sharesWithheld: string
  netSharesDelivered: string
  withholdingMethod: string
}

/**
 * Compute the employment income from an RSU_VEST transaction.
 * taxYear must be supplied by the caller (use taxYearForDate from matching.ts).
 */
export function computeRsuVestIncome(txn: Transaction, taxYear: string): RsuVestIncome {
  const vestPriceGbp = txn.unitPriceGbp ?? '0'
  const grossShares = txn.rsuGrossSharesVested ?? txn.quantity
  const withheld = txn.rsuSharesWithheld ?? '0'
  const netShares = txn.quantity

  // Employment income = gross shares × vest price
  const incomeAmountGbp = new Big(grossShares).times(vestPriceGbp).toFixed(8)

  return {
    txnId: txn.id,
    taxYear,
    grossSharesVested: grossShares,
    vestPriceGbp,
    incomeAmountGbp,
    sharesWithheld: withheld,
    netSharesDelivered: netShares,
    withholdingMethod: txn.rsuWithholdingMethod ?? 'net-settlement',
  }
}

/**
 * The cost that enters the S104 pool for an RSU vest.
 * Returns { quantity, costGbp } — the values to addToPool().
 */
export function rsuPoolEntry(txn: Transaction): { quantity: string; costGbp: string } {
  const vestPriceGbp = txn.unitPriceGbp ?? '0'
  const method = txn.rsuWithholdingMethod ?? 'net-settlement'

  // For sell-to-cover and cash the gross shares enter the pool.
  // For net-settlement only the net delivered shares (txn.quantity) enter.
  const quantity =
    method === 'net-settlement' ? txn.quantity : (txn.rsuGrossSharesVested ?? txn.quantity)

  const costGbp = new Big(quantity).times(vestPriceGbp).toFixed(8)
  return { quantity, costGbp }
}

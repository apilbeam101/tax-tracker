/**
 * ESPP (Employee Share Purchase Plan) income and cost-basis calculation.
 *
 * HMRC treats the discount (MV at purchase − price paid) as employment income
 * under Chapter 9 ITEPA 2003.  The allowable cost for CGT purposes is the
 * full market value at purchase (not the discounted price paid), because the
 * discount has already been charged to income tax.
 *
 * income_amount_gbp = (mv_at_purchase − price_paid) × qty
 * pool cost basis   = mv_at_purchase × qty
 */
import Big from 'big.js'
import type { Transaction } from '../../../shared/types.ts'

export interface EsppPurchaseIncome {
  txnId: number
  taxYear: string
  quantity: string
  mvAtPurchaseGbp: string
  pricePaidGbp: string
  discountGbp: string
  incomeAmountGbp: string
  poolCostGbp: string
}

/**
 * Compute the employment income from an ESPP_PURCHASE transaction.
 *
 * @param txn             The ESPP_PURCHASE transaction (must have unitPriceGbp = MV at purchase).
 * @param pricePaidGbp    The actual discounted price paid per share (GBP).
 * @param taxYear         Tax year string, e.g. "2025-26".
 */
export function computeEsppPurchaseIncome(
  txn: Transaction,
  pricePaidGbp: string,
  taxYear: string,
): EsppPurchaseIncome {
  const mvPerShare = new Big(txn.unitPriceGbp ?? '0')
  const paidPerShare = new Big(pricePaidGbp)
  const qty = new Big(txn.quantity)

  const discountPerShare = mvPerShare.minus(paidPerShare)
  const incomeAmountGbp = discountPerShare.times(qty).toFixed(8)
  const poolCostGbp = mvPerShare.times(qty).toFixed(8)

  return {
    txnId: txn.id,
    taxYear,
    quantity: txn.quantity,
    mvAtPurchaseGbp: mvPerShare.toFixed(8),
    pricePaidGbp: paidPerShare.toFixed(8),
    discountGbp: discountPerShare.times(qty).toFixed(8),
    incomeAmountGbp,
    poolCostGbp,
  }
}

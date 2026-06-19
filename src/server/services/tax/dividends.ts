/**
 * Dividend tax and Foreign Tax Credit Relief (FTCR) calculator.
 *
 * Operates on DIV_PAY transactions (cash dividend payments).
 * DRIP transactions are acquisitions and do not produce dividend income.
 *
 * UK dividends from foreign stocks are received gross (or with foreign
 * withholding tax already deducted).  FTCR allows relief for the lower of:
 *   a) the foreign withholding tax actually suffered
 *   b) the treaty rate × gross dividend (e.g. 15% for US stocks per UK-US treaty)
 *   c) the UK tax on the dividend (basic/higher/additional rate less the allowance)
 *
 * Gross GBP is taken from dividendGrossGbp when populated (manually entered), or
 * falls back to total_gbp (quantity × unit_price_gbp, computed by the FX backfill).
 *
 * Reference: HMRC DT9552 (UK-US treaty), ITTOIA 2005 Part 4 Ch 4.
 */
import Big from 'big.js'

function bigMin(a: Big, b: Big): Big { return a.lt(b) ? a : b }
function bigMax(a: Big, b: Big): Big { return a.gt(b) ? a : b }
import type { Transaction, TaxYearConfig } from '../../../shared/types.ts'

export interface DividendTaxResult {
  txnId: number
  taxYear: string
  grossGbp: string
  withholdingGbp: string
  /** Foreign withholding capped to treaty rate (e.g. 15% of gross). */
  treatyCappedWithholdingGbp: string
  ukTaxBeforeCredit: string
  ftcr: string
  ukTaxAfterCredit: string
  /** Which rate band applied: 'basic' | 'higher' | 'additional' | 'nil'. */
  rateBand: 'nil' | 'basic' | 'higher' | 'additional'
}

/**
 * Compute dividend tax and FTCR for a single DIV_PAY transaction.
 *
 * @param txn           The DIV_PAY txn.  Gross GBP sourced from dividendGrossGbp
 *                      if set, otherwise total_gbp (qty × unit_price_gbp from backfill).
 * @param config        TaxYearConfig for the year the dividend was received.
 * @param taxYear       Tax year string (e.g. "2025-26").
 * @param incomeAboveBasicRate  True when the taxpayer's total income (excluding
 *                              this dividend) exceeds the basic rate limit.
 *                              Set to false (default) when uncertain.
 * @param treatyRateMax The maximum foreign withholding rate under the applicable
 *                      treaty (e.g. 0.15 for US-UK).  Defaults to 0.15.
 */
export function computeDividendTax(
  txn: Transaction,
  config: TaxYearConfig,
  taxYear: string,
  incomeAboveBasicRate = false,
  treatyRateMax = '0.15',
): DividendTaxResult {
  // Prefer explicitly-set dividendGrossGbp; fall back to total_gbp (backfill-computed).
  const grossGbp = new Big(txn.dividendGrossGbp ?? txn.totalGbp ?? '0')
  const withholdingGbp = new Big(txn.dividendWithholdingGbp ?? '0')
  const allowance = new Big(config.dividendAllowance)

  // Foreign withholding capped at the treaty rate
  const treatyCap = grossGbp.times(treatyRateMax)
  const treatyCapped = bigMin(withholdingGbp, treatyCap)

  // Apply dividend allowance: only the amount above the allowance is taxable.
  // (In practice the allowance is applied across all dividends in the year;
  //  for a per-txn calculation we apply it here and it gets re-aggregated in
  //  the annual summary.)
  const taxableGross = bigMax(grossGbp.minus(allowance), new Big(0))

  let rateBand: DividendTaxResult['rateBand']
  let ukRate: Big

  if (taxableGross.eq(0)) {
    rateBand = 'nil'
    ukRate = new Big(0)
  } else if (!incomeAboveBasicRate) {
    rateBand = 'basic'
    ukRate = new Big(config.dividendBasicRate)
  } else {
    rateBand = 'higher'
    ukRate = new Big(config.dividendHigherRate)
  }

  const ukTaxBeforeCredit = taxableGross.times(ukRate).toFixed(8)
  const ukTaxBig = new Big(ukTaxBeforeCredit)

  // FTCR = min(treatyCapped, ukTaxBig) — can't exceed UK liability
  const ftcr = bigMin(treatyCapped, ukTaxBig).toFixed(8)
  const ukTaxAfterCredit = ukTaxBig.minus(ftcr).toFixed(8)

  return {
    txnId: txn.id,
    taxYear,
    grossGbp: grossGbp.toFixed(8),
    withholdingGbp: withholdingGbp.toFixed(8),
    treatyCappedWithholdingGbp: treatyCapped.toFixed(8),
    ukTaxBeforeCredit,
    ftcr,
    ukTaxAfterCredit,
    rateBand,
  }
}

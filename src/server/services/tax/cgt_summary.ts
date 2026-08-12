/**
 * Per-tax-year CGT summary.
 *
 * Aggregates disposals → applies annual exempt amount → computes liability
 * using the configured rates.  Handles the special 2024-25 case where two
 * CGT rate regimes apply within the same tax year (pre/post 30 Oct 2024).
 *
 * For the rate band split:
 *   The taxpayer's income occupies the basic rate band first.
 *   Gains are stacked on top.  The fraction of the basic rate band "used up"
 *   by income determines how much of the gain qualifies for the basic rate;
 *   the remainder is taxed at the higher rate.
 *
 * We receive a single `incomeInTaxYear` figure (total employment + dividend
 * income) to allow band apportionment, defaulting to 0.
 */
import Big from 'big.js'

function bigMin(a: Big, b: Big): Big {
  return a.lt(b) ? a : b
}
function bigMax(a: Big, b: Big): Big {
  return a.gt(b) ? a : b
}

import type { TaxYearConfig } from '../../../shared/types.ts'
import type { CgtDisposalRecord } from './matching.ts'

export interface CgtSummary {
  taxYear: string
  totalProceeds: string
  totalAllowableCost: string
  totalSellingCosts: string
  grossGain: string
  grossLoss: string
  netGain: string
  annualExempt: string
  taxableGain: string
  /** Tax estimated assuming all gains at basic rate */
  taxAtBasicRate: string
  /** Tax estimated assuming all gains at higher rate */
  taxAtHigherRate: string
  /** Best-estimate liability given incomeInTaxYear (pro-rated across bands) */
  estimatedTax: string
  /** Count of disposal records used */
  disposalCount: number
  /** Total proceeds for the HMRC reporting threshold check */
  proceedsForThreshold: string
  /** Whether proceeds exceed the reporting threshold */
  mustReport: boolean
}

/**
 * Build a CGT summary for one tax year.
 *
 * @param disposals           All CgtDisposalRecords for this tax year.
 * @param config              TaxYearConfig for the year.
 * @param incomeInTaxYear     Total non-dividend employment income in the year (GBP string).
 *                            Used to apportion the basic rate band.  Defaults to '0'.
 */
export function buildCgtSummary(
  disposals: CgtDisposalRecord[],
  config: TaxYearConfig,
  incomeInTaxYear = '0',
): CgtSummary {
  if (disposals.length === 0) {
    return emptySummary(config)
  }

  // Split disposals by the rate-change date if present (2024-25 budget)
  const splitDate = config.cgtRateChangeDate
  const pre: CgtDisposalRecord[] = []
  const post: CgtDisposalRecord[] = []
  for (const d of disposals) {
    if (splitDate && d.disposalDate < splitDate) {
      pre.push(d)
    } else {
      post.push(d)
    }
  }

  const totalProceeds = sumField(disposals, 'proceedsGbp')
  const totalAllowableCost = sumField(disposals, 'allowableCostGbp')
  const totalSellingCosts = sumField(disposals, 'sellingCostsGbp')

  const totalGains = disposals.reduce((acc, d) => {
    const g = new Big(d.gainGbp)
    return g.gt(0) ? acc.plus(g) : acc
  }, new Big(0))

  const totalLosses = disposals.reduce((acc, d) => {
    const g = new Big(d.gainGbp)
    return g.lt(0) ? acc.plus(g.abs()) : acc
  }, new Big(0))

  const netGain = totalGains.minus(totalLosses)
  const aea = new Big(config.cgtAnnualExempt)
  const taxableGain = bigMax(netGain.minus(aea), new Big(0))

  // Band apportionment: how much of the basic rate band is left for gains?
  const basicLimit = new Big(config.incomeBasicRateLimit)
  const income = new Big(incomeInTaxYear)
  const bandRemaining = bigMax(basicLimit.minus(income), new Big(0))
  const gainInBasicBand = bigMin(taxableGain, bandRemaining)
  const gainInHigherBand = taxableGain.minus(gainInBasicBand)

  // For split year: apply pre-change and post-change rates proportionally.
  // Simple approach: apportion gains pro-rata to disposals count in each half.
  // (A more precise approach would apportion by net gain in each half, but
  //  this requires loss allocation across halves which is complex and HMRC
  //  doesn't specify; pro-rata is a reasonable approximation.)
  const estimatedTax = computeEstimatedTax(
    gainInBasicBand,
    gainInHigherBand,
    config,
    pre,
    post,
    splitDate,
    disposals.length,
  )

  const basicRate = new Big(config.cgtBasicRate)
  const higherRate = new Big(config.cgtHigherRate)

  const proceedsStr = totalProceeds.toFixed(8)
  const threshold = new Big(config.cgtProceedsThreshold)

  return {
    taxYear: config.taxYear,
    totalProceeds: proceedsStr,
    totalAllowableCost: totalAllowableCost.toFixed(8),
    totalSellingCosts: totalSellingCosts.toFixed(8),
    grossGain: totalGains.toFixed(8),
    grossLoss: totalLosses.toFixed(8),
    netGain: netGain.toFixed(8),
    annualExempt: aea.toFixed(8),
    taxableGain: taxableGain.toFixed(8),
    taxAtBasicRate: taxableGain.times(basicRate).toFixed(8),
    taxAtHigherRate: taxableGain.times(higherRate).toFixed(8),
    estimatedTax: estimatedTax.toFixed(8),
    disposalCount: disposals.length,
    proceedsForThreshold: proceedsStr,
    mustReport: new Big(proceedsStr).gte(threshold),
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptySummary(config: TaxYearConfig): CgtSummary {
  const zero = new Big(0).toFixed(8)
  return {
    taxYear: config.taxYear,
    totalProceeds: zero,
    totalAllowableCost: zero,
    totalSellingCosts: zero,
    grossGain: zero,
    grossLoss: zero,
    netGain: zero,
    annualExempt: config.cgtAnnualExempt,
    taxableGain: zero,
    taxAtBasicRate: zero,
    taxAtHigherRate: zero,
    estimatedTax: zero,
    disposalCount: 0,
    proceedsForThreshold: zero,
    mustReport: false,
  }
}

function sumField(records: CgtDisposalRecord[], field: keyof CgtDisposalRecord): Big {
  return records.reduce((acc, r) => acc.plus(new Big(r[field] as string)), new Big(0))
}

function computeEstimatedTax(
  gainInBasicBand: Big,
  gainInHigherBand: Big,
  config: TaxYearConfig,
  pre: CgtDisposalRecord[],
  post: CgtDisposalRecord[],
  splitDate: string | null,
  totalCount: number,
): Big {
  if (!splitDate || config.cgtBasicRatePre === null) {
    // No split: use post-change (or only) rates
    return gainInBasicBand
      .times(config.cgtBasicRate)
      .plus(gainInHigherBand.times(config.cgtHigherRate))
  }

  // 2024-25 split year:  pro-rate gains across pre/post halves by disposal count
  const preWeight = totalCount > 0 ? new Big(pre.length).div(totalCount) : new Big(0)
  const postWeight = totalCount > 0 ? new Big(post.length).div(totalCount) : new Big(0)

  const preBasicGain = gainInBasicBand.times(preWeight)
  const postBasicGain = gainInBasicBand.times(postWeight)
  const preHigherGain = gainInHigherBand.times(preWeight)
  const postHigherGain = gainInHigherBand.times(postWeight)

  const preTax = preBasicGain
    .times(config.cgtBasicRatePre!)
    .plus(preHigherGain.times(config.cgtHigherRatePre!))
  const postTax = postBasicGain
    .times(config.cgtBasicRate)
    .plus(postHigherGain.times(config.cgtHigherRate))

  return preTax.plus(postTax)
}

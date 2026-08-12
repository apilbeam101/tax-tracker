import Big from 'big.js'
import { describe, expect, it } from 'vitest'
import type { TaxYearConfig } from '../../../shared/types.ts'
import { buildCgtSummary } from './cgt_summary.ts'
import type { CgtDisposalRecord } from './matching.ts'

function makeConfig(overrides: Partial<TaxYearConfig> = {}): TaxYearConfig {
  return {
    taxYear: '2025-26',
    startDate: '2025-04-06',
    endDate: '2026-04-05',
    cgtAnnualExempt: '3000',
    cgtBasicRate: '0.18',
    cgtHigherRate: '0.24',
    cgtBasicRatePre: null,
    cgtHigherRatePre: null,
    cgtRateChangeDate: null,
    dividendAllowance: '500',
    dividendBasicRate: '0.0875',
    dividendHigherRate: '0.3375',
    dividendAddlRate: '0.3935',
    cgtProceedsThreshold: '50000',
    incomeBasicRateLimit: '50270',
    ...overrides,
  }
}

function disposal(overrides: Partial<CgtDisposalRecord> = {}): CgtDisposalRecord {
  return {
    txnId: 1,
    instrumentId: 1,
    disposalDate: '2025-10-01',
    taxYear: '2025-26',
    matchType: 's104-pool',
    acquisitionTxnId: null,
    quantity: '100',
    proceedsGbp: '5000.00000000',
    allowableCostGbp: '3000.00000000',
    sellingCostsGbp: '0.00000000',
    gainGbp: '2000.00000000',
    ...overrides,
  }
}

describe('buildCgtSummary — empty disposals', () => {
  it('returns zero summary', () => {
    const summary = buildCgtSummary([], makeConfig())
    expect(summary.netGain).toBe(new Big(0).toFixed(8))
    expect(summary.estimatedTax).toBe(new Big(0).toFixed(8))
    expect(summary.mustReport).toBe(false)
  })
})

describe('buildCgtSummary — basic case', () => {
  it('gain of £2000 below AEA (£3000) → zero tax', () => {
    const summary = buildCgtSummary([disposal()], makeConfig())
    expect(new Big(summary.netGain).toFixed(2)).toBe('2000.00')
    expect(new Big(summary.taxableGain).toFixed(2)).toBe('0.00')
    expect(new Big(summary.estimatedTax).toFixed(2)).toBe('0.00')
  })

  it('gain of £10000 above AEA → taxable gain £7000', () => {
    const d = disposal({ proceedsGbp: '13000', allowableCostGbp: '3000', gainGbp: '10000' })
    const summary = buildCgtSummary([d], makeConfig())
    expect(new Big(summary.taxableGain).toFixed(2)).toBe('7000.00')
  })
})

describe('buildCgtSummary — losses offset gains', () => {
  it('loss reduces net gain before AEA is applied', () => {
    const gain1 = disposal({ gainGbp: '8000' })
    const loss1 = disposal({ gainGbp: '-2000' })
    const summary = buildCgtSummary([gain1, loss1], makeConfig())
    // net gain = 6000; AEA = 3000; taxable = 3000
    expect(new Big(summary.netGain).toFixed(2)).toBe('6000.00')
    expect(new Big(summary.taxableGain).toFixed(2)).toBe('3000.00')
  })
})

describe('buildCgtSummary — band apportionment', () => {
  it('income £40000 leaves £10270 in basic band; gain split across bands', () => {
    // Taxable gain = £20000
    const d = disposal({ proceedsGbp: '23000', allowableCostGbp: '0', gainGbp: '23000' })
    const summary = buildCgtSummary([d], makeConfig(), '40000')
    // Band remaining = 50270 − 40000 = £10270
    // gainInBasicBand = min(20000, 10270) = 10270 @ 18%
    // gainInHigherBand = 20000 − 10270 = 9730 @ 24%
    const expectedTax = new Big('10270').times('0.18').plus(new Big('9730').times('0.24'))
    expect(new Big(summary.estimatedTax).toFixed(2)).toBe(expectedTax.toFixed(2))
  })

  it('income above basic rate limit: all taxable gain at higher rate', () => {
    const d = disposal({ gainGbp: '10000' })
    const summary = buildCgtSummary([d], makeConfig(), '60000')
    // AEA 3000; taxable = 7000 all at 24%
    expect(new Big(summary.estimatedTax).toFixed(2)).toBe(new Big('7000').times('0.24').toFixed(2))
  })
})

describe('buildCgtSummary — 2024-25 mid-year rate split', () => {
  const config2425 = makeConfig({
    taxYear: '2024-25',
    startDate: '2024-04-06',
    endDate: '2025-04-05',
    cgtBasicRate: '0.18',
    cgtHigherRate: '0.24',
    cgtBasicRatePre: '0.10',
    cgtHigherRatePre: '0.20',
    cgtRateChangeDate: '2024-10-30',
    cgtAnnualExempt: '3000',
  })

  it('disposal on 20 Oct 2024 uses pre-change rates (10%/20%)', () => {
    // Single disposal before the change date: all gain should use pre rates
    const d = disposal({
      disposalDate: '2024-10-20',
      taxYear: '2024-25',
      gainGbp: '10000',
      proceedsGbp: '13000',
      allowableCostGbp: '3000',
    })
    const summary = buildCgtSummary([d], config2425, '0')
    // taxable gain = 10000 - 3000 = 7000
    // Only pre-change disposal, so all at pre rates
    // 7000 all in basic band (income = 0) → 7000 × 10% = £700
    expect(new Big(summary.taxableGain).toFixed(2)).toBe('7000.00')
    // The full gain is in basic band (income=0, band=50270, gain=7000)
    // All disposals are pre-change, weight=1.0 pre, 0.0 post
    const expectedTax = new Big('7000').times('0.10')
    expect(new Big(summary.estimatedTax).toFixed(2)).toBe(expectedTax.toFixed(2))
  })

  it('disposal on 5 Nov 2024 uses post-change rates (18%/24%)', () => {
    const d = disposal({
      disposalDate: '2024-11-05',
      taxYear: '2024-25',
      gainGbp: '10000',
      proceedsGbp: '13000',
      allowableCostGbp: '3000',
    })
    const summary = buildCgtSummary([d], config2425, '0')
    // All post-change; 7000 in basic band → 7000 × 18% = £1260
    expect(new Big(summary.estimatedTax).toFixed(2)).toBe(new Big('7000').times('0.18').toFixed(2))
  })
})

describe('buildCgtSummary — HMRC reporting threshold', () => {
  it('proceeds £60000 triggers mustReport', () => {
    const d = disposal({ proceedsGbp: '60000', gainGbp: '0' })
    const summary = buildCgtSummary([d], makeConfig())
    expect(summary.mustReport).toBe(true)
  })

  it('proceeds £40000 does not trigger mustReport', () => {
    const d = disposal({ proceedsGbp: '40000', gainGbp: '0' })
    const summary = buildCgtSummary([d], makeConfig())
    expect(summary.mustReport).toBe(false)
  })
})

import Big from 'big.js'
import { describe, expect, it } from 'vitest'
import type { TaxYearConfig, Transaction } from '../../../shared/types.ts'
import { computeDividendTax } from './dividends.ts'

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

function makeDividendTxn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 1,
    tenantId: 1,
    instrumentId: 1,
    txnType: 'DIV_PAY',
    txnDate: '2025-10-15',
    quantity: '100',
    unitPriceNative: null,
    nativeCurrency: null,
    fxRate: null,
    fxRateType: null,
    fxRateSource: null,
    unitPriceGbp: null,
    totalGbp: null,
    costsGbp: '0',
    netGbp: null,
    incomeAmountGbp: null,
    esppDiscountPriceNative: null,
    esppDiscountPriceGbp: null,
    rsuGrossSharesVested: null,
    rsuSharesWithheld: null,
    rsuWithholdingRate: null,
    rsuWithholdingMethod: null,
    dividendGrossGbp: '1000',
    dividendWithholdingGbp: '150',
    dividendNetGbp: '850',
    splitRatio: null,
    capreturnsPerShareGbp: null,
    notes: null,
    importSource: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('computeDividendTax — basic rate taxpayer', () => {
  it('gross £1000, 15% WHT, basic-rate taxpayer: FTCR = min(150, 150, uk_tax)', () => {
    const txn = makeDividendTxn()
    const config = makeConfig()
    const result = computeDividendTax(txn, config, '2025-26', false, '0.15')

    // Gross £1000 − £500 allowance = £500 taxable at 8.75% = £43.75
    expect(new Big(result.ukTaxBeforeCredit).toFixed(2)).toBe('43.75')
    // FTCR = min(150, 43.75) = 43.75 (UK tax is the binding constraint)
    expect(new Big(result.ftcr).toFixed(2)).toBe('43.75')
    expect(new Big(result.ukTaxAfterCredit).toFixed(2)).toBe('0.00')
    expect(result.rateBand).toBe('basic')
  })
})

describe('computeDividendTax — higher rate taxpayer', () => {
  it('gross £1000, 15% WHT, higher-rate taxpayer: FTCR = min(150, 150, uk_tax)', () => {
    const txn = makeDividendTxn()
    const config = makeConfig()
    const result = computeDividendTax(txn, config, '2025-26', true, '0.15')

    // Taxable = £500; higher rate = 33.75% → UK tax = £168.75
    expect(new Big(result.ukTaxBeforeCredit).toFixed(2)).toBe('168.75')
    // Treaty capped withholding = min(150, 1000×15%) = min(150, 150) = 150
    // FTCR = min(150, 168.75) = 150
    expect(new Big(result.ftcr).toFixed(2)).toBe('150.00')
    expect(new Big(result.ukTaxAfterCredit).toFixed(2)).toBe('18.75')
    expect(result.rateBand).toBe('higher')
  })
})

describe('computeDividendTax — within dividend allowance', () => {
  it('gross £300 (under £500 allowance): no UK tax, no FTCR', () => {
    const txn = makeDividendTxn({ dividendGrossGbp: '300', dividendWithholdingGbp: '45' })
    const config = makeConfig()
    const result = computeDividendTax(txn, config, '2025-26', false, '0.15')

    expect(new Big(result.ukTaxBeforeCredit).toFixed(2)).toBe('0.00')
    expect(new Big(result.ftcr).toFixed(2)).toBe('0.00')
    expect(result.rateBand).toBe('nil')
  })
})

describe('computeDividendTax — WHT exceeds treaty cap', () => {
  it('30% WHT is capped at the 15% treaty rate for FTCR purposes', () => {
    // Some countries withhold more than the treaty rate
    const txn = makeDividendTxn({ dividendWithholdingGbp: '300' }) // 30%
    const config = makeConfig()
    const result = computeDividendTax(txn, config, '2025-26', true, '0.15')

    // Treaty cap = 1000 × 15% = 150 (not the actual 300)
    expect(new Big(result.treatyCappedWithholdingGbp).toFixed(2)).toBe('150.00')
  })
})

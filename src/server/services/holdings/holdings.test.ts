import { describe, it, expect, vi } from 'vitest'
import { computeHoldings } from './valuation.ts'
import type { Instrument, Price } from '../../../shared/types.ts'
import type { S104PoolStore } from '../../repositories/sqlite/S104PoolStore.ts'
import type { PriceService } from '../prices/cache.ts'
import type { FxService } from '../fx/index.ts'

function makeInstrument(overrides: Partial<Instrument> = {}): Instrument {
  return {
    id: 1,
    tenantId: 1,
    ticker: 'CSCO',
    isin: null,
    name: 'Cisco Systems',
    currency: 'USD',
    exchange: 'NASDAQ',
    instrumentType: 'equity',
    isEmployerStock: false,
    rsuWithholdingMethod: 'net-settlement',
    notes: null,
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeS104Store(qty: string, cost: string): S104PoolStore {
  return {
    get: vi.fn(() => ({ quantity: qty, costGbp: cost })),
    save: vi.fn(),
  }
}

function makePriceService(price: Price | null): PriceService {
  return {
    getPrice: vi.fn(async () => price),
    fetchRange: vi.fn(async () => []),
    getLatestCached: vi.fn(() => undefined),
  }
}

function makeFxService(rate: string): FxService {
  return {
    getRate: vi.fn(async () => ({ id: 0, fromCurrency: 'USD', toCurrency: 'GBP', rateDate: '2025-06-01', rate, rateType: 'hmrc-monthly' as const, source: 'trade-tariff.service.gov.uk', fetchedAt: '' })),
    convert: vi.fn(async (amount) => ({ gbp: (parseFloat(amount) * parseFloat(rate)).toFixed(8), rate: { id: 0, rate } as never })),
  }
}

describe('HoldingsValuation', () => {
  it('computes unrealised gain with FX conversion', async () => {
    const inst = makeInstrument()
    // Pool: 100 shares, cost £4 000
    const s104 = makeS104Store('100', '4000')
    // Latest price: $55.12, FX 0.79
    const price: Price = { id: 1, instrumentId: 1, priceDate: '2025-06-01', closePrice: '55.12', source: 'tiingo', fetchedAt: '' }
    const priceSvc = makePriceService(price)
    const fx = makeFxService('0.79')

    const results = await computeHoldings(1, [inst], s104, priceSvc, fx, '2025-06-01')

    expect(results).toHaveLength(1)
    const h = results[0]!
    expect(h.quantity).toBe('100')
    expect(h.costGbp).toBe('4000')
    // avgCostGbp = 4000 / 100 = 40.00000000
    expect(parseFloat(h.avgCostGbp!)).toBeCloseTo(40, 6)
    // currentValueGbp = 100 × (55.12 × 0.79) = 100 × 43.5448 = 4354.48
    expect(parseFloat(h.currentValueGbp!)).toBeCloseTo(4354.48, 1)
    // unrealisedGainGbp = 4354.48 - 4000 = 354.48
    expect(parseFloat(h.unrealisedGainGbp!)).toBeCloseTo(354.48, 1)
    // unrealisedGainPct = 354.48 / 4000 × 100 ≈ 8.86%
    expect(parseFloat(h.unrealisedGainPct!)).toBeCloseTo(8.862, 1)
  })

  it('skips instruments with zero pool quantity', async () => {
    const inst = makeInstrument()
    const s104 = makeS104Store('0', '0')
    const priceSvc = makePriceService(null)
    const fx = makeFxService('0.79')

    const results = await computeHoldings(1, [inst], s104, priceSvc, fx, '2025-06-01')
    expect(results).toHaveLength(0)
  })

  it('returns null value fields when no price is available', async () => {
    const inst = makeInstrument()
    const s104 = makeS104Store('100', '4000')
    const priceSvc = makePriceService(null)
    const fx = makeFxService('0.79')

    const results = await computeHoldings(1, [inst], s104, priceSvc, fx, '2025-06-01')
    expect(results).toHaveLength(1)
    const h = results[0]!
    expect(h.latestPriceNative).toBeNull()
    expect(h.currentValueGbp).toBeNull()
    expect(h.unrealisedGainGbp).toBeNull()
  })

  it('handles GBP-denominated instruments without FX conversion', async () => {
    const inst = makeInstrument({ currency: 'GBP', ticker: 'LLOY' })
    const s104 = makeS104Store('10000', '500')
    const price: Price = { id: 2, instrumentId: 1, priceDate: '2025-06-01', closePrice: '0.065', source: 'yahoo', fetchedAt: '' }
    const priceSvc = makePriceService(price)
    // FX for GBP→GBP is identity rate=1
    const fx = makeFxService('1')

    const results = await computeHoldings(1, [inst], s104, priceSvc, fx, '2025-06-01')
    expect(results).toHaveLength(1)
    const h = results[0]!
    // currentValueGbp = 10000 × 0.065 = 650
    expect(parseFloat(h.currentValueGbp!)).toBeCloseTo(650, 2)
    // unrealisedGainGbp = 650 - 500 = 150
    expect(parseFloat(h.unrealisedGainGbp!)).toBeCloseTo(150, 2)
  })
})

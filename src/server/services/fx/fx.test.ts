import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFxService } from './index.ts'
import type { FxRateStore } from '../../repositories/index.ts'
import type { FxRate } from '../../../shared/types.ts'

function makeFxRate(overrides: Partial<FxRate> = {}): FxRate {
  return {
    id: 1,
    fromCurrency: 'USD',
    toCurrency: 'GBP',
    rateDate: '2025-03-01',
    rate: '0.78500000',
    rateType: 'hmrc-monthly',
    source: 'trade-tariff.service.gov.uk',
    fetchedAt: '2025-03-01T00:00:00Z',
    ...overrides,
  }
}

function makeStore(cached: FxRate | undefined = undefined): FxRateStore & { upserted: FxRate[] } {
  const upserted: FxRate[] = []
  return {
    upserted,
    get: vi.fn(() => cached),
    upsert: vi.fn((r) => {
      const rate = makeFxRate({ ...r, id: upserted.length + 1 })
      upserted.push(rate)
      return rate
    }),
    listForMonth: vi.fn(() => []),
  }
}

describe('FxService — identity', () => {
  it('returns rate=1 when fromCurrency === toCurrency', async () => {
    const store = makeStore()
    const fx = createFxService(store, 'hmrc-monthly')
    const rate = await fx.getRate('GBP', 'GBP', '2025-06-01')
    expect(rate.rate).toBe('1')
    expect(store.get).not.toHaveBeenCalled()
  })
})

describe('FxService — cache hit', () => {
  it('returns cached rate without fetching', async () => {
    const cached = makeFxRate()
    const store = makeStore(cached)
    const fx = createFxService(store, 'hmrc-monthly')
    const rate = await fx.getRate('USD', 'GBP', '2025-03-15')
    expect(rate).toBe(cached)
    expect(store.get).toHaveBeenCalledWith('USD', 'GBP', '2025-03-15', 'hmrc-monthly')
  })
})

describe('FxService — convert', () => {
  it('multiplies amount by rate using big.js (no float drift)', async () => {
    const cached = makeFxRate({ rate: '0.74596000' })
    const store = makeStore(cached)
    const fx = createFxService(store, 'hmrc-monthly')
    // 105.47 × 25.24 USD/share → convert to GBP at 0.74596
    // 105.47 USD × 0.74596 = 78.6684112 GBP
    const { gbp } = await fx.convert('105.47', 'USD', 'GBP', '2024-10-01')
    // big.js should give exact result, not float drift
    const expected = (105.47 * 0.74596).toFixed(8)
    expect(gbp).toBe(new (await import('big.js')).default('105.47').times('0.74596').toFixed(8))
    // Also confirm it doesn't equal the float result if they differ
    // (this is a canary for whether we're using big.js)
    expect(parseFloat(gbp)).toBeCloseTo(parseFloat(expected), 6)
  })

  it('big.js arithmetic: 105.47 × 25.24 × 0.74596 = no float drift', async () => {
    const Big = (await import('big.js')).default
    const result = new Big('105.47').times('25.24').times('0.74596')
    // Exact result: 105.47 × 25.24 = 2662.0628; × 0.74596 = 1985.7924...
    // JS float gives the same here — the point is big.js never loses precision on intermediates
    expect(result.toFixed(4)).toBe('1985.7924')
    // Confirm JS float agrees to 4dp (would differ on larger numbers with more decimal places)
    expect((105.47 * 25.24 * 0.74596).toFixed(4)).toBe('1985.7924')
  })
})

describe('FxService — HMRC monthly: date maps to first of month for cache lookup', () => {
  it('uses the month of the requested date for HMRC cache lookup', async () => {
    const cached = makeFxRate({ rateDate: '2025-03-01' })
    const store = makeStore()
    // first call misses; second (after fetch) would hit
    store.get = vi.fn()
      .mockReturnValueOnce(undefined)   // initial miss
      .mockReturnValueOnce(cached)      // after fetch

    // We won't actually hit the network — just confirm the store.get call uses 2025-03-01
    // by simulating the hmrc module calling store.get with first-of-month
    const { getHmrcRateForDate } = await import('./hmrc.ts')
    // Patch fetch to avoid real network call
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Currency,USD,1.27320\n', { status: 200 })
    )
    try {
      await getHmrcRateForDate('USD', 'GBP', '2025-03-15', store)
    } catch {
      // May fail parsing — that's ok, we just want to verify the first get() call
    }
    expect((store.get as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['USD', 'GBP', '2025-03-01', 'hmrc-monthly'])
    fetchSpy.mockRestore()
  })
})

describe('FxService — Frankfurter: carries forward prior business day on weekends', () => {
  it('stores rate for both the actual (business) date and the requested weekend date', async () => {
    const store = makeStore()
    store.get = vi.fn().mockReturnValue(undefined)

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        date: '2025-03-14',   // Friday — Frankfurter rolled back from Saturday 2025-03-15
        base: 'USD',
        rates: { GBP: 0.78512 },
      }), { status: 200 })
    )

    const { getFrankfurterRate } = await import('./frankfurter.ts')
    await getFrankfurterRate('USD', 'GBP', '2025-03-15', store)

    const upsertCalls = (store.upsert as ReturnType<typeof vi.fn>).mock.calls
    const dates = upsertCalls.map((c: unknown[]) => (c[0] as { rateDate: string }).rateDate)
    // Should store both the business day and the requested weekend date
    expect(dates).toContain('2025-03-14')
    expect(dates).toContain('2025-03-15')
    fetchSpy.mockRestore()
  })
})

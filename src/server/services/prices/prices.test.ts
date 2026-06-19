import { describe, it, expect, vi } from 'vitest'
import { createPriceService } from './cache.ts'
import type { PriceStore } from '../../repositories/index.ts'
import type { PriceProvider } from './provider.ts'
import type { Price } from '../../../shared/types.ts'

function makePrice(overrides: Partial<Price> = {}): Price {
  return {
    id: 1,
    instrumentId: 42,
    priceDate: '2025-06-01',
    closePrice: '55.12',
    source: 'tiingo',
    fetchedAt: '2025-06-01T18:00:00Z',
    ...overrides,
  }
}

function makeStore(cached?: Price): PriceStore & { upserted: Price[] } {
  const upserted: Price[] = []
  return {
    upserted,
    get: vi.fn((_, __) => cached),
    getLatest: vi.fn((id) => upserted.filter(p => p.instrumentId === id).at(-1) ?? cached),
    upsert: vi.fn((p) => {
      const price = makePrice({ ...p })
      upserted.push(price)
      return price
    }),
  }
}

function makeProvider(result: Omit<Price, 'id' | 'fetchedAt' | 'instrumentId'> | null, name = 'mock'): PriceProvider {
  return {
    name,
    getPrice: vi.fn(async () => result),
    getHistoricalPrices: vi.fn(async () => result ? [result] : []),
  }
}

// ── Cache hit ──────────────────────────────────────────────────────────────────

describe('PriceService — cache hit', () => {
  it('returns the cached price without calling the provider', async () => {
    const cached = makePrice()
    const store = makeStore(cached)
    const provider = makeProvider({ priceDate: '2025-06-01', closePrice: '55.12', source: 'tiingo' })
    const svc = createPriceService(store, [provider])

    const result = await svc.getPrice(42, 'CSCO', 'USD', '2025-06-01')
    expect(result).toBe(cached)
    expect(provider.getPrice).not.toHaveBeenCalled()
  })
})

// ── Cache miss → provider fetch ────────────────────────────────────────────────

describe('PriceService — cache miss', () => {
  it('fetches from the provider and stores the result', async () => {
    const store = makeStore(undefined)
    const providerResult = { priceDate: '2025-06-01', closePrice: '55.12', source: 'tiingo' }
    const provider = makeProvider(providerResult)
    const svc = createPriceService(store, [provider])

    const result = await svc.getPrice(42, 'CSCO', 'USD', '2025-06-01')
    expect(provider.getPrice).toHaveBeenCalledWith('CSCO', 'USD', '2025-06-01')
    expect(store.upsert).toHaveBeenCalledWith({ instrumentId: 42, ...providerResult })
    expect(result?.closePrice).toBe('55.12')
  })

  it('falls back to the second provider when the first throws', async () => {
    const store = makeStore(undefined)
    const failing = makeProvider(null, 'tiingo')
    ;(failing.getPrice as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('HTTP 500'))
    const fallback = makeProvider({ priceDate: '2025-06-01', closePrice: '55.00', source: 'yahoo' }, 'yahoo')
    const svc = createPriceService(store, [failing, fallback])

    const result = await svc.getPrice(42, 'CSCO', 'USD', '2025-06-01')
    expect(result?.source).toBe('yahoo')
  })

  it('returns null when all providers fail to return data', async () => {
    const store = makeStore(undefined)
    const svc = createPriceService(store, [makeProvider(null)])
    const result = await svc.getPrice(42, 'CSCO', 'USD', '2025-06-01')
    expect(result).toBeNull()
    expect(store.upsert).not.toHaveBeenCalled()
  })
})

// ── fetchRange ─────────────────────────────────────────────────────────────────

describe('PriceService — fetchRange', () => {
  it('stores all returned rows and returns them', async () => {
    const store = makeStore(undefined)
    const rows = [
      { priceDate: '2025-06-01', closePrice: '55.12', source: 'tiingo' },
      { priceDate: '2025-06-02', closePrice: '55.50', source: 'tiingo' },
    ]
    const provider: PriceProvider = {
      name: 'tiingo',
      getPrice: vi.fn(async () => null),
      getHistoricalPrices: vi.fn(async () => rows),
    }
    const svc = createPriceService(store, [provider])

    const result = await svc.fetchRange(42, 'CSCO', 'USD', '2025-06-01', '2025-06-02')
    expect(result).toHaveLength(2)
    expect(store.upsert).toHaveBeenCalledTimes(2)
  })
})

// ── Yahoo Finance JSON parser ──────────────────────────────────────────────────

import { createYahooProvider } from './yahoo.ts'

function makeYahooResponse(timestamps: number[], closes: (number | null)[], adjcloses?: (number | null)[]) {
  return {
    chart: {
      result: [{
        meta: { currency: 'USD' },
        timestamp: timestamps,
        indicators: {
          quote: [{ close: closes }],
          adjclose: [{ adjclose: adjcloses ?? closes }],
        },
      }],
      error: null,
    },
  }
}

describe('Yahoo Finance provider — response parsing', () => {
  it('parses a valid JSON response with two trading days', async () => {
    const data = makeYahooResponse(
      [1748736000, 1748822400],  // 2025-06-01, 2025-06-02
      [55.12, 55.50],
    )
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => data })) as unknown as typeof fetch

    const provider = createYahooProvider()
    const results = await provider.getHistoricalPrices('CSCO', 'USD', '2025-06-01', '2025-06-02')
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ priceDate: '2025-06-01', closePrice: '55.12', source: 'yahoo' })
    expect(results[1]).toEqual({ priceDate: '2025-06-02', closePrice: '55.5', source: 'yahoo' })
  })

  it('uses adjclose when available', async () => {
    const data = makeYahooResponse([1748736000], [55.12], [54.80])
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => data })) as unknown as typeof fetch

    const provider = createYahooProvider()
    const results = await provider.getHistoricalPrices('CSCO', 'USD', '2025-06-01', '2025-06-01')
    expect(results[0]?.closePrice).toBe('54.8')
  })

  it('skips null price rows', async () => {
    const data = makeYahooResponse([1748736000, 1748822400], [55.12, null])
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => data })) as unknown as typeof fetch

    const provider = createYahooProvider()
    const results = await provider.getHistoricalPrices('CSCO', 'USD', '2025-06-01', '2025-06-02')
    expect(results).toHaveLength(1)
  })

  it('returns empty array when chart result is null', async () => {
    const data = { chart: { result: null, error: { code: 'Not Found', description: 'No fundamentals data found' } } }
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => data })) as unknown as typeof fetch

    const provider = createYahooProvider()
    const results = await provider.getHistoricalPrices('INVALID', 'USD', '2025-06-01', '2025-06-02')
    expect(results).toHaveLength(0)
  })

  it('appends .L suffix for GBX (LSE pence) tickers', async () => {
    const data = makeYahooResponse([1748736000], [6103])
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => data })) as unknown as typeof fetch

    const provider = createYahooProvider()
    await provider.getHistoricalPrices('SGLN', 'GBX', '2025-06-01', '2025-06-01')
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain('SGLN.L')
  })

  it('divides by 100 when Yahoo returns GBp but caller expects GBP (pounds)', async () => {
    // Yahoo always returns LSE prices in GBp (pence). If the instrument currency is
    // stored as GBP, the provider must normalise to pounds so callers don't see 100x values.
    const data = {
      chart: {
        result: [{
          meta: { currency: 'GBp' },
          timestamp: [1748736000],
          indicators: {
            quote: [{ close: [6089.0] }],
            adjclose: [{ adjclose: [6089.0] }],
          },
        }],
        error: null,
      },
    }
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => data })) as unknown as typeof fetch

    const provider = createYahooProvider()
    const results = await provider.getHistoricalPrices('SGLN', 'GBP', '2025-06-01', '2025-06-01')
    expect(results[0]?.closePrice).toBe('60.89')
  })
})

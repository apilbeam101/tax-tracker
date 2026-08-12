import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { FxRate } from '../../../shared/types.ts'
import type { FxRateStore } from '../../repositories/index.ts'
import { fetchHmrcMonthlyRates } from './hmrc.ts'

const FIXTURES = join(import.meta.dirname, '__fixtures__')

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8')
}

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

function makeStore(): FxRateStore & { upserted: FxRate[] } {
  const upserted: FxRate[] = []
  return {
    upserted,
    get: vi.fn(() => undefined),
    upsert: vi.fn((r) => {
      const rate = makeFxRate({ ...r, id: upserted.length + 1 })
      upserted.push(rate)
      return rate
    }),
    listForMonth: vi.fn(() => []),
  }
}

describe('HMRC monthly CSV parsing (real column layout, sanitized/synthetic values)', () => {
  it('stores both directions for every valid currency row, skipping malformed/non-numeric/zero rows', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(loadFixture('hmrc-monthly.csv'), { status: 200 }),
    )
    const store = makeStore()

    await fetchHmrcMonthlyRates(2025, 3, store)

    const pairs = store.upserted.map((r) => `${r.fromCurrency}->${r.toCurrency}`)
    expect(pairs).toContain('AUD->GBP')
    expect(pairs).toContain('GBP->AUD')
    expect(pairs).toContain('CAD->GBP')
    expect(pairs).toContain('GBP->CAD')
    expect(pairs).toContain('USD->GBP')
    expect(pairs).toContain('GBP->USD')
    // 3 valid currencies x 2 directions. The malformed/non-numeric rows are
    // dropped by parseHmrcCsv (never reach here); TST's zero rate parses fine
    // and is dropped one layer up, by fetchHmrcMonthlyRates's `!rateToGbp`
    // check -- this assertion can't distinguish which layer excluded which
    // row, only that all four bad rows are gone by the time upsert is called.
    expect(store.upserted).toHaveLength(6)
    expect(pairs).not.toContain('JPY->GBP')
    expect(pairs).not.toContain('TST->GBP')

    vi.restoreAllMocks()
  })

  it('inverts the HMRC units-per-GBP rate for the foreign->GBP direction', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(loadFixture('hmrc-monthly.csv'), { status: 200 }),
    )
    const store = makeStore()

    await fetchHmrcMonthlyRates(2025, 3, store)

    const usdToGbp = store.upserted.find((r) => r.fromCurrency === 'USD' && r.toCurrency === 'GBP')
    const gbpToUsd = store.upserted.find((r) => r.fromCurrency === 'GBP' && r.toCurrency === 'USD')
    // HMRC row: USD 1.27320 units per GBP -> USD->GBP is 1/1.27320
    expect(usdToGbp?.rate).toBe((1 / 1.2732).toFixed(8))
    expect(gbpToUsd?.rate).toBe('1.27320')

    vi.restoreAllMocks()
  })

  it('propagates a non-ok HTTP response as a thrown error (no partial/garbage parse)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    )
    const store = makeStore()

    await expect(fetchHmrcMonthlyRates(2025, 3, store)).rejects.toThrow('HMRC FX fetch failed')

    vi.restoreAllMocks()
  })
})

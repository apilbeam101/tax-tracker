import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { FxRate } from '../../../shared/types.ts'
import type { FxRateStore } from '../../repositories/index.ts'
import { getFrankfurterRate } from './frankfurter.ts'

const FIXTURES = join(import.meta.dirname, '__fixtures__')

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8')
}

// Defaults are deliberately NOT the values the fixture should produce ('UNSET'
// sentinels) -- if the real code stopped passing `rate`/`rateDate` to store.upsert
// (e.g. a renamed field), the spread below wouldn't override these defaults and
// the assertions would keep passing against a value nobody actually derived.
function makeFxRate(overrides: Partial<FxRate> = {}): FxRate {
  return {
    id: 1,
    fromCurrency: 'USD',
    toCurrency: 'GBP',
    rateDate: 'UNSET-DATE',
    rate: 'UNSET-RATE',
    rateType: 'daily-spot',
    source: 'frankfurter.dev',
    fetchedAt: '2025-03-14T00:00:00Z',
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

describe('Frankfurter response parsing (real response shape)', () => {
  it('extracts and stores the requested currency rate', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(loadFixture('frankfurter-response.json'), { status: 200 }),
    )
    const store = makeStore()

    const rate = await getFrankfurterRate('USD', 'GBP', '2025-03-14', store)

    expect(rate.rate).toBe('0.78512000')
    expect(rate.rateDate).toBe('2025-03-14')
    vi.restoreAllMocks()
  })

  it('throws when the response has no rate for the requested currency', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(loadFixture('frankfurter-missing-rate.json'), { status: 200 }),
    )
    const store = makeStore()

    await expect(getFrankfurterRate('USD', 'GBP', '2025-03-14', store)).rejects.toThrow(
      'Frankfurter returned no rate for GBP',
    )
    vi.restoreAllMocks()
  })

  it('propagates a non-ok HTTP response as a thrown error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    )
    const store = makeStore()

    await expect(getFrankfurterRate('USD', 'GBP', '2025-03-14', store)).rejects.toThrow(
      'Frankfurter fetch failed',
    )
    vi.restoreAllMocks()
  })
})

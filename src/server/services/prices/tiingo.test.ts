import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTiingoProvider } from './tiingo.ts'

const FIXTURES = join(import.meta.dirname, '__fixtures__')

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8'))
}

function mockFetchJson(status: number, body: unknown): void {
  global.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch
}

describe('Tiingo provider — response parsing (real captured shape, sanitized)', () => {
  it('prefers adjClose over close, applying the split-adjusted price', async () => {
    mockFetchJson(200, loadFixture('tiingo-daily.json'))
    const provider = createTiingoProvider('test-key')

    const result = await provider.getPrice('CSCO', 'USD', '2025-06-02')
    expect(result).toEqual({ priceDate: '2025-06-02', closePrice: '27.75', source: 'tiingo' })
  })

  it('filters out the near-zero sentinel Tiingo uses for missing data', async () => {
    mockFetchJson(200, loadFixture('tiingo-daily.json'))
    const provider = createTiingoProvider('test-key')

    const rows = await provider.getHistoricalPrices('CSCO', 'USD', '2025-06-02', '2025-06-04')
    const dates = rows.map((r) => r.priceDate)
    expect(dates).not.toContain('2025-06-03')
    expect(dates).toEqual(['2025-06-02', '2025-06-04'])
  })

  it('falls back to close when adjClose is absent from the row', async () => {
    // The mock returns the whole fixture regardless of URL — real Tiingo would
    // apply startDate/endDate server-side, so we just check this row's value,
    // not that the array is filtered to a single row.
    mockFetchJson(200, loadFixture('tiingo-daily.json'))
    const provider = createTiingoProvider('test-key')

    const rows = await provider.getHistoricalPrices('CSCO', 'USD', '2025-06-04', '2025-06-04')
    const row = rows.find((r) => r.priceDate === '2025-06-04')
    expect(row).toEqual({ priceDate: '2025-06-04', closePrice: '56.1', source: 'tiingo' })
  })

  it('does not fall back to close when adjClose is present but zero', async () => {
    // Distinguishes `adjClose ?? close` (correct) from `adjClose || close` (wrong):
    // a present-but-zero adjClose is real signal (e.g. a halted security), not an
    // absent field -- falling back to the unadjusted close would silently feed a
    // wrong price into the S104 pool. `??` only defers to close when adjClose is
    // null/undefined, so this row must be filtered out entirely, not "fixed up".
    mockFetchJson(200, loadFixture('tiingo-daily.json'))
    const provider = createTiingoProvider('test-key')

    const rows = await provider.getHistoricalPrices('CSCO', 'USD', '2025-06-05', '2025-06-05')
    expect(rows.find((r) => r.priceDate === '2025-06-05')).toBeUndefined()
  })

  it('returns null/empty for an empty-array response (no data for the range)', async () => {
    mockFetchJson(200, loadFixture('tiingo-empty.json'))
    const provider = createTiingoProvider('test-key')

    expect(await provider.getPrice('CSCO', 'USD', '2025-06-02')).toBeNull()
    expect(await provider.getHistoricalPrices('CSCO', 'USD', '2025-06-01', '2025-06-05')).toEqual(
      [],
    )
  })

  it('returns null on a 404 (unknown ticker) rather than throwing', async () => {
    mockFetchJson(404, null)
    const provider = createTiingoProvider('test-key')

    expect(await provider.getPrice('NOPE', 'USD', '2025-06-02')).toBeNull()
  })

  it('throws on a non-404 HTTP error', async () => {
    mockFetchJson(500, {})
    const provider = createTiingoProvider('test-key')

    await expect(provider.getPrice('CSCO', 'USD', '2025-06-02')).rejects.toThrow('Tiingo HTTP 500')
  })

  it('requires an API key at construction time', () => {
    expect(() => createTiingoProvider('')).toThrow('Tiingo API key is required')
  })
})

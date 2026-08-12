import type { PriceProvider } from './provider.ts'

// Tiingo EOD API — free tier: 500 unique symbols, 50 req/hr, 1 000 req/day
// Docs: https://www.tiingo.com/documentation/end-of-day
// Note: Tiingo uses the ticker without exchange suffix (AAPL, not AAPL.US)

const BASE = 'https://api.tiingo.com/tiingo/daily'

interface TiingoDayResponse {
  date: string // ISO 8601 with time, e.g. "2024-01-15T00:00:00+00:00"
  close: number
  adjClose: number
}

function toDateStr(isoWithTime: string): string {
  return isoWithTime.slice(0, 10)
}

export function createTiingoProvider(apiKey: string): PriceProvider {
  if (!apiKey) throw new Error('Tiingo API key is required')

  async function fetchJson(url: string): Promise<unknown> {
    const res = await fetch(url, {
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Tiingo HTTP ${res.status} for ${url}`)
    return res.json()
  }

  return {
    name: 'tiingo',

    async getPrice(ticker, _currency, date) {
      const url = `${BASE}/${encodeURIComponent(ticker)}/prices?startDate=${date}&endDate=${date}&token=${apiKey}`
      const rows = (await fetchJson(url)) as TiingoDayResponse[] | null
      if (!rows || rows.length === 0) return null
      const row = rows[0]!
      const price = row.adjClose ?? row.close
      // Tiingo returns 0.000001 as a sentinel when it has no data for the ticker
      if (!price || price < 0.01) return null
      return {
        priceDate: toDateStr(row.date),
        closePrice: String(price),
        source: 'tiingo',
      }
    },

    async getHistoricalPrices(ticker, _currency, from, to) {
      const url = `${BASE}/${encodeURIComponent(ticker)}/prices?startDate=${from}&endDate=${to}&token=${apiKey}`
      const rows = (await fetchJson(url)) as TiingoDayResponse[] | null
      if (!rows) return []
      return rows.flatMap((row) => {
        const price = row.adjClose ?? row.close
        if (!price || price < 0.01) return []
        return [
          { priceDate: toDateStr(row.date), closePrice: String(price), source: 'tiingo' as const },
        ]
      })
    },
  }
}

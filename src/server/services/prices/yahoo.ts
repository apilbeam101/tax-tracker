import type { PriceProvider } from './provider.ts'

// Yahoo Finance v8 chart API — no API key required.
// Requires a browser-like User-Agent; server-side fetch with the default Node agent is blocked.
// UK/LSE tickers: append ".L" (SGLN → SGLN.L). Yahoo returns prices in GBp (pence) for LSE,
// same unit as Stooq did — the existing GBX ÷ 100 paths in the codebase are unchanged.
// EUR tickers: ".DE" (Frankfurt). US tickers: no suffix.
// Free tier limits are undocumented; for personal use (tens of requests/day) it is reliable.

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart'
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; personal-tax-tracker/1.0)' }

function toYahooSymbol(ticker: string, currency: string): string {
  if (currency === 'GBP' || currency === 'GBX') return `${ticker}.L`
  if (currency === 'EUR') return `${ticker}.DE`
  return ticker
}

function toUnixTs(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000)
}

function toDateStr(unixTs: number): string {
  return new Date(unixTs * 1000).toISOString().slice(0, 10)
}

interface YahooChartResult {
  meta: { currency: string }
  timestamp: number[]
  indicators: {
    quote: Array<{ close: (number | null)[] }>
    adjclose?: Array<{ adjclose: (number | null)[] }>
  }
}

interface YahooChartResponse {
  chart: {
    result: YahooChartResult[] | null
    error: { code: string; description: string } | null
  }
}

function parseYahooChart(
  data: YahooChartResponse,
  requestedCurrency: string,
): { date: string; close: number }[] {
  if (data.chart.error || !data.chart.result?.length) return []
  const result = data.chart.result[0]!
  const timestamps = result.timestamp ?? []
  const adjCloses = result.indicators.adjclose?.[0]?.adjclose ?? []
  const closes = result.indicators.quote[0]?.close ?? []

  // Yahoo returns LSE prices in GBp (pence) regardless of how the instrument is stored.
  // If the caller expects GBP (pounds), divide by 100. If GBX (pence) is expected,
  // Yahoo's pence values are correct as-is.
  const yahooCurrency = result.meta.currency // e.g. "GBp", "USD", "EUR"
  const divisor = yahooCurrency === 'GBp' && requestedCurrency === 'GBP' ? 100 : 1

  const out: { date: string; close: number }[] = []
  for (let i = 0; i < timestamps.length; i++) {
    const raw = adjCloses[i] ?? closes[i]
    if (raw == null || raw <= 0) continue
    out.push({ date: toDateStr(timestamps[i]!), close: raw / divisor })
  }
  return out
}

export function createYahooProvider(): PriceProvider {
  return {
    name: 'yahoo',

    async getPrice(ticker, currency, date) {
      const sym = toYahooSymbol(ticker, currency)
      const period1 = toUnixTs(date)
      const period2 = period1 + 86400
      const url = `${BASE}/${encodeURIComponent(sym)}?interval=1d&period1=${period1}&period2=${period2}`

      const res = await fetch(url, { headers: HEADERS })
      if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`)
      const data = (await res.json()) as YahooChartResponse

      const prices = parseYahooChart(data, currency)
      const match = prices.find((p) => p.date === date)
      if (!match) return null

      return { priceDate: match.date, closePrice: String(match.close), source: 'yahoo' }
    },

    async getHistoricalPrices(ticker, currency, from, to) {
      const sym = toYahooSymbol(ticker, currency)
      const period1 = toUnixTs(from)
      const period2 = toUnixTs(to) + 86400
      const url = `${BASE}/${encodeURIComponent(sym)}?interval=1d&period1=${period1}&period2=${period2}`

      const res = await fetch(url, { headers: HEADERS })
      if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`)
      const data = (await res.json()) as YahooChartResponse

      return parseYahooChart(data, currency)
        .filter((p) => p.date >= from && p.date <= to)
        .map((p) => ({ priceDate: p.date, closePrice: String(p.close), source: 'yahoo' }))
    },
  }
}

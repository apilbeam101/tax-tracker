import type { PriceStore } from '../../repositories/index.ts'
import type { PriceProvider } from './provider.ts'
import type { Price } from '../../../shared/types.ts'

export interface PriceService {
  /**
   * Return the closing price for a given instrument on a specific date.
   * Checks the local cache first; falls back to the configured provider chain.
   * Returns null if no price can be obtained (e.g. market closed, ticker unknown).
   */
  getPrice(instrumentId: number, ticker: string, currency: string, date: string): Promise<Price | null>

  /**
   * Fetch and cache a range of historical prices for an instrument.
   * Useful for bulk backfill — calls the first provider that returns data.
   */
  fetchRange(instrumentId: number, ticker: string, currency: string, from: string, to: string): Promise<Price[]>

  /**
   * Return the most recent cached price for an instrument (latest date in the price table).
   * Does NOT trigger a live fetch.
   */
  getLatestCached(instrumentId: number): Price | undefined
}

function subtractDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

export function createPriceService(store: PriceStore, providers: PriceProvider[]): PriceService {
  return {
    async getPrice(instrumentId, ticker, currency, date) {
      const cached = store.get(instrumentId, date)
      if (cached) return cached

      // Try the requested date first, then walk back up to 5 days to handle
      // intraday requests (today's close not yet published) and weekends/holidays.
      for (let offset = 0; offset <= 5; offset++) {
        const d = offset === 0 ? date : subtractDays(date, offset)
        const cacheFallback = offset > 0 ? store.get(instrumentId, d) : null
        if (cacheFallback) return cacheFallback

        for (const provider of providers) {
          try {
            const result = await provider.getPrice(ticker, currency, d)
            if (result && parseFloat(result.closePrice) > 0) {
              return store.upsert({ instrumentId, ...result })
            }
          } catch {
            // Provider failed; try the next one
          }
        }
      }
      return null
    },

    async fetchRange(instrumentId, ticker, currency, from, to) {
      for (const provider of providers) {
        try {
          const results = await provider.getHistoricalPrices(ticker, currency, from, to)
          if (results.length > 0) {
            return results.map(r => store.upsert({ instrumentId, ...r }))
          }
        } catch {
          // Provider failed; try the next one
        }
      }
      return []
    },

    getLatestCached(instrumentId) {
      return store.getLatest(instrumentId)
    },
  }
}

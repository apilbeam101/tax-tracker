import type { Price } from '../../../shared/types.ts'

export interface PriceProvider {
  readonly name: string
  /**
   * Fetch the closing price for a single date.
   * Returns null if no data is available for that date (e.g. market closed).
   */
  getPrice(
    ticker: string,
    currency: string,
    date: string,
  ): Promise<Omit<Price, 'id' | 'fetchedAt' | 'instrumentId'> | null>
  /**
   * Fetch a range of closing prices (inclusive on both ends).
   */
  getHistoricalPrices(
    ticker: string,
    currency: string,
    from: string,
    to: string,
  ): Promise<Omit<Price, 'id' | 'fetchedAt' | 'instrumentId'>[]>
}

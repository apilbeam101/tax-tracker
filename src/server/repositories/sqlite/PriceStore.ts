import type { Price } from '../../../shared/types.ts'
import type { Db } from '../../db/database.ts'
import type { PriceStore } from '../index.ts'

interface PriceRow {
  id: number
  instrument_id: number
  price_date: string
  close_price: string
  source: string
  fetched_at: string
}

function toPrice(row: PriceRow): Price {
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    priceDate: row.price_date,
    closePrice: row.close_price,
    source: row.source,
    fetchedAt: row.fetched_at,
  }
}

export function createPriceStore(db: Db): PriceStore {
  return {
    get(instrumentId, priceDate) {
      const row = db
        .prepare('SELECT * FROM price WHERE instrument_id = ? AND price_date = ?')
        .get(instrumentId, priceDate) as PriceRow | undefined
      return row ? toPrice(row) : undefined
    },

    getLatest(instrumentId) {
      const row = db
        .prepare('SELECT * FROM price WHERE instrument_id = ? ORDER BY price_date DESC LIMIT 1')
        .get(instrumentId) as PriceRow | undefined
      return row ? toPrice(row) : undefined
    },

    upsert(price) {
      db.prepare(`
        INSERT INTO price (instrument_id, price_date, close_price, source)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (instrument_id, price_date)
        DO UPDATE SET close_price = excluded.close_price, source = excluded.source, fetched_at = datetime('now')
      `).run(price.instrumentId, price.priceDate, price.closePrice, price.source)
      return this.get(price.instrumentId, price.priceDate)!
    },
  }
}

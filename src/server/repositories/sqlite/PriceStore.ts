import type { Price } from '../../../shared/types.ts'
import type { FieldCipher } from '../../crypto/fields.ts'
import type { Db } from '../../db/database.ts'
import type { PriceStore } from '../index.ts'
import { createRowCodec, insertRow, updateRow } from './rowcodec.ts'

const TABLE = 'price'

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

export function createPriceStore(db: Db, cipher: FieldCipher): PriceStore {
  const codec = createRowCodec(cipher, TABLE)
  const read = (row: PriceRow) => toPrice(codec.open(row))

  return {
    get(instrumentId, priceDate) {
      const row = db
        .prepare('SELECT * FROM price WHERE instrument_id = ? AND price_date = ?')
        .get(instrumentId, priceDate) as PriceRow | undefined
      return row ? read(row) : undefined
    },

    getLatest(instrumentId) {
      const row = db
        .prepare('SELECT * FROM price WHERE instrument_id = ? ORDER BY price_date DESC LIMIT 1')
        .get(instrumentId) as PriceRow | undefined
      return row ? read(row) : undefined
    },

    earliestDate(instrumentId) {
      const row = db
        .prepare('SELECT MIN(price_date) AS d FROM price WHERE instrument_id = ?')
        .get(instrumentId) as { d: string | null }
      return row.d
    },

    listRange(instrumentId, from, to) {
      return (
        db
          .prepare(
            `SELECT * FROM price
             WHERE instrument_id = ? AND price_date >= ? AND price_date <= ?
             ORDER BY price_date ASC`,
          )
          .all(instrumentId, from, to) as unknown as PriceRow[]
      ).map(read)
    },

    upsert(price) {
      const existing = db
        .prepare('SELECT id FROM price WHERE instrument_id = ? AND price_date = ?')
        .get(price.instrumentId, price.priceDate) as { id: number } | undefined
      if (existing) {
        updateRow(
          db,
          codec,
          TABLE,
          existing.id,
          { close_price: price.closePrice, source: price.source },
          { extraSet: "fetched_at = datetime('now')" },
        )
      } else {
        insertRow(db, codec, TABLE, {
          instrument_id: price.instrumentId,
          price_date: price.priceDate,
          close_price: price.closePrice,
          source: price.source,
        })
      }
      return this.get(price.instrumentId, price.priceDate)!
    },
  }
}

import type { FxRate, FxRateType } from '../../../shared/types.ts'
import type { Db } from '../../db/database.ts'
import type { FxRateStore } from '../index.ts'

interface FxRateRow {
  id: number
  from_currency: string
  to_currency: string
  rate_date: string
  rate: string
  rate_type: string
  source: string
  fetched_at: string
}

function toFxRate(row: FxRateRow): FxRate {
  return {
    id: row.id,
    fromCurrency: row.from_currency,
    toCurrency: row.to_currency,
    rateDate: row.rate_date,
    rate: row.rate,
    rateType: row.rate_type as FxRateType,
    source: row.source,
    fetchedAt: row.fetched_at,
  }
}

export function createFxRateStore(db: Db): FxRateStore {
  return {
    get(fromCurrency, toCurrency, rateDate, rateType) {
      const row = db
        .prepare(
          'SELECT * FROM fx_rate WHERE from_currency = ? AND to_currency = ? AND rate_date = ? AND rate_type = ?',
        )
        .get(fromCurrency, toCurrency, rateDate, rateType) as FxRateRow | undefined
      return row ? toFxRate(row) : undefined
    },

    upsert(rate) {
      db.prepare(`
        INSERT INTO fx_rate (from_currency, to_currency, rate_date, rate, rate_type, source)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (from_currency, to_currency, rate_date, rate_type)
        DO UPDATE SET rate = excluded.rate, source = excluded.source, fetched_at = datetime('now')
      `).run(
        rate.fromCurrency,
        rate.toCurrency,
        rate.rateDate,
        rate.rate,
        rate.rateType,
        rate.source,
      )
      return this.get(rate.fromCurrency, rate.toCurrency, rate.rateDate, rate.rateType)!
    },

    listForMonth(fromCurrency, toCurrency, year, month) {
      const prefix = `${String(year)}-${String(month).padStart(2, '0')}`
      return (
        db
          .prepare(
            'SELECT * FROM fx_rate WHERE from_currency = ? AND to_currency = ? AND rate_date LIKE ? ORDER BY rate_date',
          )
          .all(fromCurrency, toCurrency, `${prefix}%`) as unknown as FxRateRow[]
      ).map(toFxRate)
    },
  }
}

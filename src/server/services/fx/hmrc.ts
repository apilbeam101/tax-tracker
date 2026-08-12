import type { FxRate } from '../../../shared/types.ts'
import type { FxRateStore } from '../../repositories/index.ts'
import { getFrankfurterRate } from './frankfurter.ts'

const BASE_URL = 'https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files'
const SOURCE = 'trade-tariff.service.gov.uk'

// HMRC publishes one CSV per month. The file URL pattern is:
// /monthly_csv_<YYYY-MM>.csv
// Real header (verified against a live file): "Country/Territories,Currency,
// Currency Code,Currency Units per £1,Start date,End date" — 6 columns; only
// currencyCode (index 2) and the rate (index 3) are read. The real file also
// repeats a currency code once per territory that uses it (e.g. XOF appears
// ~8 times with an identical rate each time) — fetchHmrcMonthlyRates upserts
// each repeat, which is harmless (same rateDate+currency, same rate, last
// write wins) but not something to assume is deduped by this parser.
// The rate is units-of-foreign-currency per 1 GBP (i.e. 1 GBP = N USD),
// so to convert USD → GBP we compute 1 / rate.
// HMRC data is only available from January 2021 onwards via this API.

interface HmrcRow {
  currencyCode: string
  rateToGbp: string // foreign units per 1 GBP
}

function parseHmrcCsv(csv: string): HmrcRow[] {
  const rows: HmrcRow[] = []
  for (const line of csv.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(',')
    // A row with fewer than 4 fields already fails the !rateStr check below
    // (parts[3] is out-of-bounds -> undefined) -- this length check can never
    // actually fire on its own; kept as an explicit, readable guard rather
    // than relying on that out-of-bounds behavior.
    if (parts.length < 4) continue
    const currencyCode = parts[2]?.trim()
    const rateStr = parts[3]?.trim()
    // Skip header row and rows with non-numeric rates
    if (
      !currencyCode ||
      !rateStr ||
      Number.isNaN(Number(rateStr)) ||
      currencyCode === 'Currency Code'
    )
      continue
    rows.push({ currencyCode, rateToGbp: rateStr })
  }
  return rows
}

// Returns the first day of the month as the canonical rate_date for HMRC monthly rates.
function firstOfMonth(year: number, month: number): string {
  return `${String(year)}-${String(month).padStart(2, '0')}-01`
}

export async function fetchHmrcMonthlyRates(
  year: number,
  month: number,
  store: FxRateStore,
): Promise<FxRate[]> {
  const monthStr = `${String(year)}-${String(month).padStart(2, '0')}`
  const url = `${BASE_URL}/monthly_csv_${monthStr}.csv`

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`HMRC FX fetch failed: ${res.status} ${res.statusText} (${url})`)
  }
  const csv = await res.text()
  const rows = parseHmrcCsv(csv)

  const rateDate = firstOfMonth(year, month)
  const results: FxRate[] = []

  for (const row of rows) {
    const rateToGbp = Number(row.rateToGbp)
    if (!rateToGbp || rateToGbp <= 0) continue

    // Store both directions: foreign→GBP (1/rateToGbp) and GBP→foreign (rateToGbp)
    const fxToGbp = (1 / rateToGbp).toFixed(8)
    results.push(
      store.upsert({
        fromCurrency: row.currencyCode,
        toCurrency: 'GBP',
        rateDate,
        rate: fxToGbp,
        rateType: 'hmrc-monthly',
        source: SOURCE,
      }),
    )
    store.upsert({
      fromCurrency: 'GBP',
      toCurrency: row.currencyCode,
      rateDate,
      rate: row.rateToGbp,
      rateType: 'hmrc-monthly',
      source: SOURCE,
    })
  }

  return results
}

// Returns the HMRC monthly rate for a given date (uses the month the date falls in).
// Falls back to Frankfurter daily-spot if HMRC doesn't have data for that month
// (e.g. pre-2021 dates, or currencies not covered by HMRC).
export async function getHmrcRateForDate(
  fromCurrency: string,
  toCurrency: string,
  date: string,
  store: FxRateStore,
): Promise<FxRate> {
  const [yearStr, monthStr] = date.split('-')
  const year = parseInt(yearStr ?? '0', 10)
  const month = parseInt(monthStr ?? '0', 10)
  const rateDate = firstOfMonth(year, month)

  // Check cache first (hmrc-monthly)
  const cached = store.get(fromCurrency, toCurrency, rateDate, 'hmrc-monthly')
  if (cached) return cached

  // Try fetching the whole month from HMRC; fall back to Frankfurter on failure
  try {
    await fetchHmrcMonthlyRates(year, month, store)
    const fetched = store.get(fromCurrency, toCurrency, rateDate, 'hmrc-monthly')
    if (fetched) return fetched
  } catch {
    // HMRC returned 404 or parse error — fall through to Frankfurter
  }

  // Frankfurter fallback: fetch a daily spot rate for the transaction date.
  // This covers pre-2021 dates and currencies not in the HMRC file.
  return getFrankfurterRate(fromCurrency, toCurrency, date, store)
}

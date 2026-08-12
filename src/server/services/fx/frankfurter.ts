import type { FxRate } from '../../../shared/types.ts'
import type { FxRateStore } from '../../repositories/index.ts'

const BASE_URL = 'https://api.frankfurter.dev/v1'
const SOURCE = 'frankfurter.dev'

interface FrankfurterResponse {
  date: string // actual date used (may differ from requested — weekends roll back)
  base: string
  rates: Record<string, number>
}

// Frankfurter returns no data for weekends — it returns the prior business day's rates.
// We store with the actual date returned (the business day), not the requested date.
export async function getFrankfurterRate(
  fromCurrency: string,
  toCurrency: string,
  date: string, // YYYY-MM-DD (weekends will roll back to Friday)
  store: FxRateStore,
): Promise<FxRate> {
  // Check cache for the requested date first (may already have it from a prior fetch)
  const cached = store.get(fromCurrency, toCurrency, date, 'daily-spot')
  if (cached) return cached

  const url = `${BASE_URL}/${date}?base=${fromCurrency}&symbols=${toCurrency}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Frankfurter fetch failed: ${res.status} ${res.statusText} (${url})`)
  }
  const data = (await res.json()) as FrankfurterResponse

  const rate = data.rates[toCurrency]
  if (rate === undefined) {
    throw new Error(`Frankfurter returned no rate for ${toCurrency} on ${data.date}`)
  }

  const stored = store.upsert({
    fromCurrency,
    toCurrency,
    rateDate: data.date, // use the actual business date returned
    rate: rate.toFixed(8),
    rateType: 'daily-spot',
    source: SOURCE,
  })

  // If Frankfurter rolled back to a prior business day, also cache for the requested date
  // so future lookups for that weekend date return immediately without another fetch.
  if (data.date !== date) {
    store.upsert({
      fromCurrency,
      toCurrency,
      rateDate: date,
      rate: rate.toFixed(8),
      rateType: 'daily-spot',
      source: SOURCE,
    })
  }

  return stored
}

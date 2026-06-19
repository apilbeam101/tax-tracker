import type { FastifyPluginAsync } from 'fastify'
import Big from 'big.js'

/** Subtract N calendar days from an ISO date string */
function subtractDays(date: string, n: number): string {
  const parts = date.split('-')
  const ms = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) - n * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

/** Add N calendar days to an ISO date string */
function addDays(date: string, n: number): string {
  const parts = date.split('-')
  const ms = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) + n * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Return the start date for a given period string, relative to `today`.
 * Returns [from, to].
 */
function periodBounds(period: string, today: string): [string, string] {
  const parts = today.split('-')
  const y = Number(parts[0])
  const m = Number(parts[1])

  switch (period) {
    case 'mtd': {
      return [`${today.slice(0, 7)}-01`, today]
    }
    case 'qtd': {
      const quarterStart = Math.floor((m - 1) / 3) * 3 + 1
      const qs = `${y}-${String(quarterStart).padStart(2, '0')}-01`
      return [qs, today]
    }
    case 'ytd': {
      return [`${y}-01-01`, today]
    }
    case '1m':  return [subtractDays(today, 30), today]
    case '3m':  return [subtractDays(today, 90), today]
    case '6m':  return [subtractDays(today, 182), today]
    case '1y':  return [subtractDays(today, 365), today]
    case '2y':  return [subtractDays(today, 730), today]
    case '3y':  return [subtractDays(today, 1095), today]
    case '5y':  return [subtractDays(today, 1825), today]
    case '7y':  return [subtractDays(today, 2555), today]
    case '10y': return [subtractDays(today, 3650), today]
    case '15y': return [subtractDays(today, 5475), today]
    default:    return [subtractDays(today, 365), today] // fallback: 1y
  }
}

interface ChartPoint { date: string; value: string }

interface TxnRow {
  txn_date: string
  txn_type: string
  quantity: string
  split_ratio: string | null
}

/**
 * Compute the actual number of shares held at each price date by replaying
 * transactions in chronological order alongside the price series.
 *
 * Walks both lists in a single O(N+M) pass: advances the transaction pointer
 * whenever the next transaction date ≤ the current price date.
 */
function buildQtyTimeline(
  txns: TxnRow[],   // must be sorted by txn_date asc
  priceDates: string[],  // must be sorted asc
): Map<string, Big> {
  const result = new Map<string, Big>()
  let qty = new Big(0)
  let ti = 0

  for (const date of priceDates) {
    // Apply all transactions up to and including this price date
    while (ti < txns.length) {
      const txn = txns[ti]
      if (!txn || txn.txn_date > date) break
      const q = new Big(txn.quantity)
      switch (txn.txn_type) {
        case 'BUY':
        case 'RSU_VEST':
        case 'ESPP_PURCHASE':
        case 'TRANSFER_IN':
        case 'DRIP':
          qty = qty.plus(q)
          break
        case 'SELL':
        case 'TRANSFER_OUT':
          qty = qty.minus(q)
          if (qty.lt(0)) qty = new Big(0)
          break
        case 'SPLIT':
          if (txn.split_ratio) {
            const parts = txn.split_ratio.split('/')
            const n = Number(parts[0]), d = Number(parts[1])
            if (n && d) qty = qty.times(n).div(d)
          }
          break
        case 'UNSPLIT':
          if (txn.split_ratio) {
            const parts = txn.split_ratio.split('/')
            const n = Number(parts[0]), d = Number(parts[1])
            if (n && d) qty = qty.times(d).div(n)
          }
          break
      }
      ti++
    }
    result.set(date, qty)
  }
  return result
}

export const chartRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/charts/portfolio-value?period=1y ──────────────────────────────
  // Returns the actual market value of the portfolio on each trading day within
  // the requested period, using the quantity held at that specific date (not the
  // current pool quantity) multiplied by the closing price.
  app.get<{ Querystring: { period?: string } }>(
    '/portfolio-value',
    async (req) => {
      const user = req.session.user!
      const today = new Date().toISOString().slice(0, 10)
      const period = req.query.period ?? '1y'
      const [from] = periodBounds(period, today)

      const instruments = app.instruments.list(user.tenantId)
      const valueByDate = new Map<string, Big>()

      for (const inst of instruments) {
        // Skip instruments with no transactions at all
        const txnRows = app.db.prepare(
          `SELECT txn_date, txn_type, quantity, split_ratio
           FROM txn
           WHERE instrument_id = ? AND tenant_id = ?
           ORDER BY txn_date ASC, id ASC`
        ).all(inst.id, user.tenantId) as unknown as TxnRow[]
        if (txnRows.length === 0) continue

        // Only include instruments that had a non-zero holding at some point in the range.
        // Quick check: first acquisition must be on or before `today`.
        const firstAcq = txnRows.find(t =>
          ['BUY','RSU_VEST','ESPP_PURCHASE','TRANSFER_IN','DRIP'].includes(t.txn_type)
        )
        if (!firstAcq || firstAcq.txn_date > today) continue

        // Ensure we have price history covering the range.
        // If our earliest cached price is more than 7 days after `from`, fetch history.
        const earliest = app.db.prepare(
          `SELECT MIN(price_date) as d FROM price WHERE instrument_id = ?`
        ).get(inst.id) as { d: string | null }

        const needsFetch = !earliest.d || earliest.d > addDays(from, 7)
        if (needsFetch) {
          // Fetch from the later of: `from` or the first acquisition date
          const fetchFrom = firstAcq.txn_date > from ? firstAcq.txn_date : from
          await app.priceService.fetchRange(inst.id, inst.ticker, inst.currency, fetchFrom, today)
        }

        // Load all cached prices for the range
        const priceRows = app.db.prepare(
          `SELECT price_date, close_price FROM price
           WHERE instrument_id = ? AND price_date >= ? AND price_date <= ?
           ORDER BY price_date ASC`
        ).all(inst.id, from, today) as { price_date: string; close_price: string }[]

        if (priceRows.length === 0) continue

        const priceDates = priceRows.map(r => r.price_date)
        const priceMap = new Map(priceRows.map(r => [r.price_date, r.close_price]))

        // Compute actual quantity held on each price date by replaying all txns
        const qtyByDate = buildQtyTimeline(txnRows, priceDates)

        for (const [date, qty] of qtyByDate) {
          if (qty.lte(0)) continue  // nothing held on this date
          const closePrice = priceMap.get(date)
          if (!closePrice) continue

          let priceGbp: Big | null
          if (inst.currency === 'GBP') {
            priceGbp = new Big(closePrice)
          } else if (inst.currency === 'GBX') {
            priceGbp = new Big(closePrice).div(100)
          } else {
            try {
              const fx = await app.fx.getRate(inst.currency, 'GBP', date)
              priceGbp = new Big(closePrice).times(fx.rate)
            } catch {
              priceGbp = null
            }
          }

          if (!priceGbp) continue

          const dayValue = qty.times(priceGbp)
          const existing = valueByDate.get(date) ?? new Big(0)
          valueByDate.set(date, existing.plus(dayValue))
        }
      }

      const points: ChartPoint[] = Array.from(valueByDate.entries())
        .sort(([a], [b]) => a < b ? -1 : 1)
        .map(([date, value]) => ({ date, value: value.toFixed(2) }))

      return { period, from, to: today, points }
    },
  )

  // ── GET /api/charts/realised-gains?taxYear=2025-26 ───────────────────────
  // Returns monthly realised gains for a specific tax year as a bar chart series.
  // Accepts taxYear (e.g. "2025-26") which maps to the configured start/end dates.
  app.get<{ Querystring: { taxYear?: string } }>(
    '/realised-gains',
    async (req) => {
      const user = req.session.user!
      const today = new Date().toISOString().slice(0, 10)

      // Resolve the tax year date range from config
      let from: string
      let to: string
      const taxYear = req.query.taxYear

      if (taxYear) {
        const configRow = app.db.prepare(
          'SELECT start_date, end_date FROM tax_year_config WHERE tax_year = ?'
        ).get(taxYear) as { start_date: string; end_date: string } | undefined
        if (configRow) {
          from = configRow.start_date
          to = configRow.end_date <= today ? configRow.end_date : today
        } else {
          // Unknown tax year — return empty
          return { taxYear, points: [] }
        }
      } else {
        // No year specified: default to last 12 months
        from = subtractDays(today, 365)
        to = today
      }

      const rows = app.db.prepare(
        `SELECT disposal_date, gain_gbp FROM cgt_disposal
         WHERE tenant_id = ? AND disposal_date >= ? AND disposal_date <= ?
         ORDER BY disposal_date ASC`
      ).all(user.tenantId, from, to) as { disposal_date: string; gain_gbp: string }[]

      const gainByMonth = new Map<string, Big>()
      for (const row of rows) {
        const month = row.disposal_date.slice(0, 7)
        const existing = gainByMonth.get(month) ?? new Big(0)
        gainByMonth.set(month, existing.plus(row.gain_gbp))
      }

      const points: ChartPoint[] = Array.from(gainByMonth.entries())
        .sort(([a], [b]) => a < b ? -1 : 1)
        .map(([date, value]) => ({ date, value: value.toFixed(2) }))

      return { taxYear: taxYear ?? 'custom', from, to, points }
    },
  )

  // ── GET /api/charts/dividend-income?taxYear=2025-26 ──────────────────────
  // Returns monthly dividend income (net GBP) for a specific tax year.
  app.get<{ Querystring: { taxYear?: string } }>(
    '/dividend-income',
    async (req) => {
      const user = req.session.user!
      const today = new Date().toISOString().slice(0, 10)
      const taxYear = req.query.taxYear

      let from: string
      let to: string

      if (taxYear) {
        const configRow = app.db.prepare(
          'SELECT start_date, end_date FROM tax_year_config WHERE tax_year = ?'
        ).get(taxYear) as { start_date: string; end_date: string } | undefined
        if (configRow) {
          from = configRow.start_date
          to = configRow.end_date <= today ? configRow.end_date : today
        } else {
          return { taxYear, points: [] }
        }
      } else {
        from = subtractDays(today, 365)
        to = today
      }

      const txns = app.transactions.list(user.tenantId, { from, to })
      const dividends = txns.filter(t => t.txnType === 'DIV_PAY')

      const incomeByMonth = new Map<string, Big>()
      for (const d of dividends) {
        const month = d.txnDate.slice(0, 7)
        const amount = d.dividendNetGbp ?? d.netGbp ?? d.totalGbp ?? '0'
        const existing = incomeByMonth.get(month) ?? new Big(0)
        incomeByMonth.set(month, existing.plus(amount))
      }

      const points: ChartPoint[] = Array.from(incomeByMonth.entries())
        .sort(([a], [b]) => a < b ? -1 : 1)
        .map(([date, value]) => ({ date, value: value.toFixed(2) }))

      return { taxYear: taxYear ?? 'custom', from, to, points }
    },
  )

  // ── GET /api/charts/cost-vs-value ─────────────────────────────────────────
  // Returns per-instrument cost basis vs current market value for a bar chart.
  app.get('/cost-vs-value', async (req) => {
    const user = req.session.user!
    const today = new Date().toISOString().slice(0, 10)
    const instruments = app.instruments.list(user.tenantId)

    const result: {
      ticker: string
      costGbp: string
      valueGbp: string | null
      priceDate: string | null
    }[] = []

    for (const inst of instruments) {
      const pool = app.s104Pools.get(user.tenantId, inst.id)
      if (new Big(pool.quantity).lte(0)) continue

      const costGbp = pool.costGbp

      // Use cached latest price
      const latest = app.priceService.getLatestCached(inst.id)
      let valueGbp: string | null = null
      let priceDate: string | null = null

      if (latest) {
        priceDate = latest.priceDate
        try {
          if (inst.currency === 'GBP') {
            valueGbp = new Big(pool.quantity).times(latest.closePrice).toFixed(2)
          } else if (inst.currency === 'GBX') {
            valueGbp = new Big(pool.quantity).times(new Big(latest.closePrice).div(100)).toFixed(2)
          } else {
            const fx = await app.fx.getRate(inst.currency, 'GBP', latest.priceDate)
            valueGbp = new Big(pool.quantity).times(latest.closePrice).times(fx.rate).toFixed(2)
          }
        } catch {
          // FX unavailable
        }
      }

      result.push({ ticker: inst.ticker, costGbp, valueGbp, priceDate })
    }

    return result
  })
}

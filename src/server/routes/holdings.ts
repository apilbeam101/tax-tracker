import type { FastifyPluginAsync } from 'fastify'
import { computeHoldings } from '../services/holdings/valuation.ts'

// GET /api/holdings
// Returns current portfolio holdings: pool quantity, cost basis, latest price, unrealised gain.
// Optionally triggers a live price fetch if no cached price exists for today.
// Query: ?date=YYYY-MM-DD (defaults to today in UTC)
export const holdingRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { date?: string } }>('/', async (req) => {
    const user = req.session.user!
    const today = req.query.date ?? new Date().toISOString().slice(0, 10)

    const instruments = app.instruments.list(user.tenantId)
    const holdings = await computeHoldings(
      user.tenantId,
      instruments,
      app.s104Pools,
      app.priceService,
      app.fx,
      today,
    )
    return holdings
  })

  // POST /api/holdings/refresh-prices
  // Fetches the latest price for every held instrument from the configured provider.
  // Useful to call before loading the holdings page to ensure prices are current.
  app.post<{ Body: { date?: string } }>(
    '/refresh-prices',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
        },
      },
    },
    async (req) => {
      const user = req.session.user!
      const today = req.body.date ?? new Date().toISOString().slice(0, 10)
      const instruments = app.instruments.list(user.tenantId)

      const results: { ticker: string; priceDate: string | null; closePrice: string | null; error: string | null }[] = []

      for (const inst of instruments) {
        try {
          const price = await app.priceService.getPrice(inst.id, inst.ticker, inst.currency, today)
          results.push({
            ticker: inst.ticker,
            priceDate: price?.priceDate ?? null,
            closePrice: price?.closePrice ?? null,
            error: price ? null : 'no price available',
          })
        } catch (err) {
          results.push({
            ticker: inst.ticker,
            priceDate: null,
            closePrice: null,
            error: (err as Error).message,
          })
        }
      }

      return results
    },
  )

  // POST /api/holdings/fetch-history
  // Bulk-fetches historical prices for an instrument over a date range.
  // Useful to populate the price cache for chart and cost-basis computation.
  app.post<{ Body: { instrumentId: number; from: string; to: string } }>(
    '/fetch-history',
    {
      schema: {
        body: {
          type: 'object',
          required: ['instrumentId', 'from', 'to'],
          properties: {
            instrumentId: { type: 'integer', minimum: 1 },
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.session.user!
      const { instrumentId, from, to } = req.body
      const inst = app.instruments.getById(user.tenantId, instrumentId)
      if (!inst) return reply.status(404).send({ error: 'Instrument not found' })

      const prices = await app.priceService.fetchRange(inst.id, inst.ticker, inst.currency, from, to)
      return { fetched: prices.length, from, to }
    },
  )
}

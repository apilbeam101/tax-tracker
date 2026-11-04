import Big from 'big.js'
import type { FastifyPluginAsync } from 'fastify'

interface ProjectedEvent {
  id: number
  instrumentId: number
  ticker: string
  currency: string
  scheduleType: string
  scheduledDate: string
  quantity: string
  expectedDiscountPriceNative: string | null
  // Projected values (null if no price available)
  latestPriceNative: string | null
  latestPriceDate: string | null
  projectedValueGbp: string | null
  // For RSU: estimated employment income; for ESPP: estimated income from discount
  estimatedIncomeGbp: string | null
  // For ESPP: estimated discount income (MV - discount price) × qty
  estimatedEsppDiscountGbp: string | null
  notes: string | null
}

export const projectionRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /api/projections — upcoming vest/purchase events ─────────────────
  app.get<{ Querystring: { instrumentId?: string; from?: string; to?: string } }>(
    '/',
    async (req) => {
      const user = req.session.user!
      const today = new Date().toISOString().slice(0, 10)
      const from = req.query.from ?? today
      // Default: show events in the next 2 years
      const to = req.query.to ?? `${parseInt(today.slice(0, 4), 10) + 2}-${today.slice(5)}`

      const instruments = new Map(app.instruments.list(user.tenantId).map((i) => [i.id, i]))
      const rows = app.vestSchedules
        .list(user.tenantId, {
          from,
          to,
          unrealisedOnly: true,
          ...(req.query.instrumentId ? { instrumentId: parseInt(req.query.instrumentId, 10) } : {}),
        })
        .flatMap((schedule) => {
          const instrument = instruments.get(schedule.instrumentId)
          return instrument
            ? [{ ...schedule, ticker: instrument.ticker, currency: instrument.currency }]
            : []
        })

      const results: ProjectedEvent[] = []

      for (const row of rows) {
        const latest = app.priceService.getLatestCached(row.instrumentId)
        let latestPriceNative: string | null = null
        let latestPriceDate: string | null = null
        let projectedValueGbp: string | null = null
        let estimatedIncomeGbp: string | null = null
        let estimatedEsppDiscountGbp: string | null = null

        if (latest) {
          latestPriceNative = latest.closePrice
          latestPriceDate = latest.priceDate
          try {
            let priceGbp: Big
            if (row.currency === 'GBP') {
              priceGbp = new Big(latest.closePrice)
            } else if (row.currency === 'GBX') {
              priceGbp = new Big(latest.closePrice).div(100)
            } else {
              const fx = await app.fx.getRate(row.currency, 'GBP', latest.priceDate)
              priceGbp = new Big(latest.closePrice).times(fx.rate)
            }
            const qty = new Big(row.quantity)
            projectedValueGbp = qty.times(priceGbp).toFixed(2)

            if (row.scheduleType === 'rsu-vest') {
              // Employment income = gross value at vest (use projected value as estimate)
              estimatedIncomeGbp = projectedValueGbp
            } else if (row.scheduleType === 'espp-purchase' && row.expectedDiscountPriceNative) {
              // For ESPP, income = (MV at purchase - discounted price) × qty.
              // MV is estimated from the latest price; discounted price stored as native.
              const discountPriceGbp =
                row.currency === 'GBP'
                  ? new Big(row.expectedDiscountPriceNative)
                  : row.currency === 'GBX'
                    ? new Big(row.expectedDiscountPriceNative).div(100)
                    : new Big(row.expectedDiscountPriceNative)
                        .times(priceGbp)
                        .div(new Big(latest.closePrice))
              const discountPerShare = priceGbp.minus(discountPriceGbp)
              if (discountPerShare.gt(0)) {
                estimatedEsppDiscountGbp = discountPerShare.times(qty).toFixed(2)
                estimatedIncomeGbp = estimatedEsppDiscountGbp
              }
            }
          } catch {
            // FX unavailable
          }
        }

        results.push({
          id: row.id,
          instrumentId: row.instrumentId,
          ticker: row.ticker,
          currency: row.currency,
          scheduleType: row.scheduleType,
          scheduledDate: row.scheduledDate,
          quantity: row.quantity,
          expectedDiscountPriceNative: row.expectedDiscountPriceNative,
          latestPriceNative,
          latestPriceDate,
          projectedValueGbp,
          estimatedIncomeGbp,
          estimatedEsppDiscountGbp,
          notes: row.notes,
        })
      }

      return results
    },
  )

  // ── POST /api/projections — create a vest/purchase schedule entry ─────────
  app.post<{
    Body: {
      instrumentId: number
      scheduleType: string
      scheduledDate: string
      quantity: string
      expectedPriceUsd?: string
      expectedDiscountPriceNative?: string
      notes?: string
    }
  }>(
    '/',
    {
      schema: {
        body: {
          type: 'object',
          required: ['instrumentId', 'scheduleType', 'scheduledDate', 'quantity'],
          properties: {
            instrumentId: { type: 'integer', minimum: 1 },
            scheduleType: { type: 'string', enum: ['rsu-vest', 'espp-purchase', 'option-expiry'] },
            scheduledDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            quantity: { type: 'string', pattern: '^\\d+(\\.\\d+)?$' },
            expectedPriceUsd: { type: 'string', pattern: '^\\d+(\\.\\d+)?$' },
            expectedDiscountPriceNative: { type: 'string', pattern: '^\\d+(\\.\\d+)?$' },
            notes: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.session.user!
      const inst = app.instruments.getById(user.tenantId, req.body.instrumentId)
      if (!inst) return reply.status(404).send({ error: 'Instrument not found' })

      const created = app.vestSchedules.create(user.tenantId, {
        instrumentId: req.body.instrumentId,
        scheduleType: req.body.scheduleType,
        scheduledDate: req.body.scheduledDate,
        quantity: req.body.quantity,
        expectedPriceUsd: req.body.expectedPriceUsd ?? null,
        expectedDiscountPriceNative: req.body.expectedDiscountPriceNative ?? null,
        notes: req.body.notes ?? null,
      })

      return reply.status(201).send({ id: created.id })
    },
  )

  // ── DELETE /api/projections/:id ───────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const user = req.session.user!
    if (!app.vestSchedules.delete(user.tenantId, Number(req.params.id))) {
      return reply.status(404).send({ error: 'Not found' })
    }
    return reply.status(204).send()
  })
}

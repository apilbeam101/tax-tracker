import type { FastifyPluginAsync } from 'fastify'
import Big from 'big.js'

interface VestScheduleRow {
  id: number
  instrument_id: number
  schedule_type: string
  scheduled_date: string
  quantity: string
  expected_price_usd: string | null
  expected_discount_price_native: string | null
  notes: string | null
  realised_txn_id: number | null
}

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
      const to = req.query.to ?? `${parseInt(today.slice(0, 4)) + 2}-${today.slice(5)}`

      let query = `
        SELECT vs.*, i.ticker, i.currency
        FROM vest_schedule vs
        JOIN instrument i ON i.id = vs.instrument_id
        WHERE vs.tenant_id = ?
          AND vs.scheduled_date >= ?
          AND vs.scheduled_date <= ?
          AND vs.realised_txn_id IS NULL
      `
      const params: (string | number)[] = [user.tenantId, from, to]

      if (req.query.instrumentId) {
        query += ' AND vs.instrument_id = ?'
        params.push(parseInt(req.query.instrumentId, 10))
      }

      query += ' ORDER BY vs.scheduled_date ASC'

      const rows = app.db.prepare(query).all(...params) as unknown as (VestScheduleRow & { ticker: string; currency: string })[]

      const results: ProjectedEvent[] = []

      for (const row of rows) {
        const latest = app.priceService.getLatestCached(row.instrument_id)
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

            if (row.schedule_type === 'rsu-vest') {
              // Employment income = gross value at vest (use projected value as estimate)
              estimatedIncomeGbp = projectedValueGbp
            } else if (row.schedule_type === 'espp-purchase' && row.expected_discount_price_native) {
              // For ESPP, income = (MV at purchase - discounted price) × qty.
              // MV is estimated from the latest price; discounted price stored as native.
              const discountPriceGbp = row.currency === 'GBP'
                ? new Big(row.expected_discount_price_native)
                : row.currency === 'GBX'
                  ? new Big(row.expected_discount_price_native).div(100)
                  : new Big(row.expected_discount_price_native).times(priceGbp).div(new Big(latest.closePrice))
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
          instrumentId: row.instrument_id,
          ticker: row.ticker,
          currency: row.currency,
          scheduleType: row.schedule_type,
          scheduledDate: row.scheduled_date,
          quantity: row.quantity,
          expectedDiscountPriceNative: row.expected_discount_price_native,
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
            instrumentId:                 { type: 'integer', minimum: 1 },
            scheduleType:                 { type: 'string', enum: ['rsu-vest', 'espp-purchase', 'option-expiry'] },
            scheduledDate:                { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            quantity:                     { type: 'string', pattern: '^\\d+(\\.\\d+)?$' },
            expectedPriceUsd:             { type: 'string', pattern: '^\\d+(\\.\\d+)?$' },
            expectedDiscountPriceNative:  { type: 'string', pattern: '^\\d+(\\.\\d+)?$' },
            notes:                        { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.session.user!
      const inst = app.instruments.getById(user.tenantId, req.body.instrumentId)
      if (!inst) return reply.status(404).send({ error: 'Instrument not found' })

      const result = app.db.prepare(`
        INSERT INTO vest_schedule
          (tenant_id, instrument_id, schedule_type, scheduled_date, quantity, expected_price_usd, expected_discount_price_native, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.tenantId,
        req.body.instrumentId,
        req.body.scheduleType,
        req.body.scheduledDate,
        req.body.quantity,
        req.body.expectedPriceUsd ?? null,
        req.body.expectedDiscountPriceNative ?? null,
        req.body.notes ?? null,
      )

      return reply.status(201).send({ id: result.lastInsertRowid })
    },
  )

  // ── DELETE /api/projections/:id ───────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/:id',
    async (req, reply) => {
      const user = req.session.user!
      const row = app.db.prepare(
        'SELECT id FROM vest_schedule WHERE id = ? AND tenant_id = ?'
      ).get(req.params.id, user.tenantId)
      if (!row) return reply.status(404).send({ error: 'Not found' })

      app.db.prepare('DELETE FROM vest_schedule WHERE id = ?').run(req.params.id)
      return reply.status(204).send()
    },
  )
}

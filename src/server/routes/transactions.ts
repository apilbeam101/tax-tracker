import Big from 'big.js'
import type { FastifyPluginAsync } from 'fastify'
import type { CreateTransactionBody, UpdateTransactionBody } from '../../shared/types.ts'
import { config } from '../config/env.ts'
import type { InstrumentStore, TransactionStore } from '../repositories/index.ts'
import type { FxService } from '../services/fx/index.ts'
import {
  linkRealisedProjection,
  recalcInstrument,
  unlinkRealisedProjection,
} from '../services/tax/recalc.ts'

const TXN_TYPES = [
  'BUY',
  'SELL',
  'DIV_PAY',
  'DRIP',
  'RSU_VEST',
  'ESPP_PURCHASE',
  'SPLIT',
  'UNSPLIT',
  'CAPRETURN',
  'RIGHTS_ISSUE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
]

// Transaction types that exchange shares at a price — unitPriceNative is mandatory for these.
const PRICE_REQUIRED_TYPES = new Set([
  'BUY',
  'SELL',
  'DIV_PAY',
  'DRIP',
  'RSU_VEST',
  'ESPP_PURCHASE',
  'RIGHTS_ISSUE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
])
const FX_RATE_TYPES = ['hmrc-monthly', 'daily-spot', 'manual']
const RSU_METHODS = ['net-settlement', 'sell-to-cover', 'cash']
const DECIMAL_PATTERN = '^\\d+(\\.\\d+)?$'

// Compute derived GBP fields using big.js and write them back to the txn row.
async function computeAndPersistGbpFields(
  tenantId: number,
  txnId: number,
  userId: number,
  body: CreateTransactionBody,
  fx: FxService,
  store: TransactionStore,
  instruments: InstrumentStore,
): Promise<void> {
  if (!body.unitPriceNative || !body.quantity) return

  const instrument = instruments.getById(tenantId, body.instrumentId)
  const currency = body.nativeCurrency ?? instrument?.currency ?? 'GBP'

  let unitPriceGbp: string
  let fxRateRecord: { rate: string; rateType: string } | null = null

  if (currency === 'GBP') {
    unitPriceGbp = body.unitPriceNative
  } else {
    const fxResult = await fx.convert(body.unitPriceNative, currency, 'GBP', body.txnDate)
    unitPriceGbp = fxResult.gbp
    fxRateRecord = fxResult.rate
  }

  const qty = new Big(body.quantity)
  const unitGbp = new Big(unitPriceGbp)
  const totalGbp = qty.times(unitGbp)
  const costsGbp = new Big(body.costsGbp ?? '0')

  const update: UpdateTransactionBody = {
    unitPriceGbp: unitGbp.toFixed(8),
    totalGbp: totalGbp.toFixed(8),
  }

  if (fxRateRecord) {
    update.fxRate = fxRateRecord.rate
    update.fxRateType = fxRateRecord.rateType as import('../../shared/types.ts').FxRateType
  }

  // ESPP: derive discount price in GBP, income amount, and net GBP (actual cash paid)
  if (body.txnType === 'ESPP_PURCHASE' && body.esppDiscountPriceNative) {
    // Apply the same FX rate already derived for unitPriceGbp
    const fxRatio = new Big(unitPriceGbp).div(new Big(body.unitPriceNative))
    const discountPriceGbp = new Big(body.esppDiscountPriceNative).times(fxRatio)
    const incomeAmountGbp = unitGbp.minus(discountPriceGbp).times(qty)
    // net_gbp reflects actual cash outflow: discounted price × qty + costs
    const netGbp = discountPriceGbp.times(qty).plus(costsGbp).neg()
    update.esppDiscountPriceGbp = discountPriceGbp.toFixed(8)
    update.incomeAmountGbp = incomeAmountGbp.toFixed(8)
    update.netGbp = netGbp.toFixed(8)
  } else {
    // net_gbp: for BUY/RSU_VEST/ESPP_PURCHASE costs are added to basis (negative sign for outflow)
    // for SELL/DIVIDEND costs reduce proceeds
    const isBuy = ['BUY', 'RSU_VEST', 'ESPP_PURCHASE', 'TRANSFER_IN', 'RIGHTS_ISSUE'].includes(
      body.txnType,
    )
    update.netGbp = isBuy
      ? totalGbp.plus(costsGbp).neg().toFixed(8)
      : totalGbp.minus(costsGbp).toFixed(8)
  }

  store.update(tenantId, txnId, update, userId)
}

export const transactionRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { instrumentId?: string; from?: string; to?: string } }>(
    '/',
    async (req) => {
      const user = req.session.user!
      const opts: { instrumentId?: number; from?: string; to?: string } = {}
      if (req.query.instrumentId) opts.instrumentId = parseInt(req.query.instrumentId, 10)
      if (req.query.from) opts.from = req.query.from
      if (req.query.to) opts.to = req.query.to
      return app.transactions.list(user.tenantId, opts)
    },
  )

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const user = req.session.user!
    const txn = app.transactions.getById(user.tenantId, parseInt(req.params.id, 10))
    if (!txn) return reply.status(404).send({ error: 'Not found' })
    return txn
  })

  app.post<{ Body: CreateTransactionBody }>(
    '/',
    {
      schema: {
        body: {
          type: 'object',
          required: ['instrumentId', 'txnType', 'txnDate', 'quantity'],
          properties: {
            instrumentId: { type: 'integer', minimum: 1 },
            txnType: { type: 'string', enum: TXN_TYPES },
            txnDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            quantity: { type: 'string', pattern: DECIMAL_PATTERN },
            unitPriceNative: { type: 'string', pattern: DECIMAL_PATTERN },
            nativeCurrency: { type: 'string', minLength: 3, maxLength: 3 },
            fxRate: { type: 'string', pattern: DECIMAL_PATTERN },
            fxRateType: { type: 'string', enum: FX_RATE_TYPES },
            costsGbp: { type: 'string', pattern: DECIMAL_PATTERN },
            incomeAmountGbp: { type: 'string', pattern: DECIMAL_PATTERN },
            esppDiscountPriceNative: { type: 'string', pattern: DECIMAL_PATTERN },
            rsuGrossSharesVested: { type: 'string', pattern: DECIMAL_PATTERN },
            rsuSharesWithheld: { type: 'string', pattern: DECIMAL_PATTERN },
            rsuWithholdingRate: { type: 'string', pattern: DECIMAL_PATTERN },
            rsuWithholdingMethod: { type: 'string', enum: RSU_METHODS },
            dividendGrossGbp: { type: 'string', pattern: DECIMAL_PATTERN },
            dividendWithholdingGbp: { type: 'string', pattern: DECIMAL_PATTERN },
            dividendNetGbp: { type: 'string', pattern: DECIMAL_PATTERN },
            splitRatio: { type: 'string', pattern: '^\\d+/\\d+$' },
            capreturnsPerShareGbp: { type: 'string', pattern: DECIMAL_PATTERN },
            notes: { type: 'string', maxLength: 2048 },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.session.user!
      if (PRICE_REQUIRED_TYPES.has(req.body.txnType) && !req.body.unitPriceNative) {
        return reply
          .status(400)
          .send({ error: `unitPriceNative is required for ${req.body.txnType} transactions` })
      }
      const txn = app.transactions.create(user.tenantId, req.body, user.id)
      await computeAndPersistGbpFields(
        user.tenantId,
        txn.id,
        user.id,
        req.body,
        app.fx,
        app.transactions,
        app.instruments,
      )
      linkRealisedProjection(
        app,
        user.tenantId,
        txn.instrumentId,
        txn.txnType,
        txn.txnDate,
        txn.quantity,
        txn.id,
      )
      recalcInstrument(app, user.tenantId, txn.instrumentId)
      return reply.status(201).send(app.transactions.getById(user.tenantId, txn.id))
    },
  )

  app.patch<{ Params: { id: string }; Body: UpdateTransactionBody }>(
    '/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            txnType: { type: 'string', enum: TXN_TYPES },
            txnDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            quantity: { type: 'string', pattern: DECIMAL_PATTERN },
            unitPriceNative: { type: 'string', pattern: DECIMAL_PATTERN },
            nativeCurrency: { type: 'string', minLength: 3, maxLength: 3 },
            costsGbp: { type: 'string', pattern: DECIMAL_PATTERN },
            incomeAmountGbp: { type: 'string', pattern: DECIMAL_PATTERN },
            esppDiscountPriceNative: { type: 'string', pattern: DECIMAL_PATTERN },
            rsuGrossSharesVested: { type: 'string', pattern: DECIMAL_PATTERN },
            rsuSharesWithheld: { type: 'string', pattern: DECIMAL_PATTERN },
            rsuWithholdingRate: { type: 'string', pattern: DECIMAL_PATTERN },
            rsuWithholdingMethod: { type: 'string', enum: RSU_METHODS },
            dividendGrossGbp: { type: 'string', pattern: DECIMAL_PATTERN },
            dividendWithholdingGbp: { type: 'string', pattern: DECIMAL_PATTERN },
            dividendNetGbp: { type: 'string', pattern: DECIMAL_PATTERN },
            splitRatio: { type: 'string', pattern: '^\\d+/\\d+$' },
            capreturnsPerShareGbp: { type: 'string', pattern: DECIMAL_PATTERN },
            notes: { type: 'string', maxLength: 2048 },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.session.user!
      const id = parseInt(req.params.id, 10)
      const existing = app.transactions.getById(user.tenantId, id)
      if (!existing) return reply.status(404).send({ error: 'Not found' })

      const updated = app.transactions.update(user.tenantId, id, req.body, user.id)
      if (!updated) return reply.status(404).send({ error: 'Not found' })

      // Re-derive GBP fields if price/date/currency changed
      const merged: CreateTransactionBody = {
        instrumentId: updated.instrumentId,
        txnType: updated.txnType,
        txnDate: updated.txnDate,
        quantity: updated.quantity,
        costsGbp: updated.costsGbp,
        ...(updated.unitPriceNative ? { unitPriceNative: updated.unitPriceNative } : {}),
        ...(updated.nativeCurrency ? { nativeCurrency: updated.nativeCurrency } : {}),
        ...(updated.esppDiscountPriceNative
          ? { esppDiscountPriceNative: updated.esppDiscountPriceNative }
          : {}),
      }
      await computeAndPersistGbpFields(
        user.tenantId,
        id,
        user.id,
        merged,
        app.fx,
        app.transactions,
        app.instruments,
      )

      // Re-evaluate the Projections link: a txn that moves off the date/type
      // that matched its projection should stop hiding it, and one that now
      // matches a different pending projection should link to that instead.
      unlinkRealisedProjection(app, user.tenantId, id)
      linkRealisedProjection(
        app,
        user.tenantId,
        updated.instrumentId,
        updated.txnType,
        updated.txnDate,
        updated.quantity,
        id,
      )

      recalcInstrument(app, user.tenantId, updated.instrumentId)
      return app.transactions.getById(user.tenantId, id)
    },
  )

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const user = req.session.user!
    const id = parseInt(req.params.id, 10)
    const existing = app.transactions.getById(user.tenantId, id)
    if (!existing) return reply.status(404).send({ error: 'Not found' })

    // cgt_disposal and vest_schedule rows FK-reference this txn (foreign_keys
    // is ON) — clear them before deleting, since they've already been created
    // by the recalc that ran after this txn's own create/update. The recalc
    // below rebuilds cgt_disposal for the instrument from scratch anyway.
    app.db
      .prepare(
        'DELETE FROM cgt_disposal WHERE tenant_id = ? AND (txn_id = ? OR acquisition_txn_id = ?)',
      )
      .run(user.tenantId, id, id)
    unlinkRealisedProjection(app, user.tenantId, id)

    const deleted = app.transactions.delete(user.tenantId, id, user.id)
    if (!deleted) return reply.status(404).send({ error: 'Not found' })
    recalcInstrument(app, user.tenantId, existing.instrumentId)
    return reply.status(204).send()
  })

  // ── POST /api/transactions/import-dividends ───────────────────────────────
  // Preview or commit dividend history from Alpha Vantage for one instrument.
  // Body: { instrumentId, commit?: boolean }
  // Returns: { rows: ProposedDividendRow[], inserted: number }
  app.post<{ Body: { instrumentId: number; commit?: boolean } }>(
    '/import-dividends',
    {
      schema: {
        body: {
          type: 'object',
          required: ['instrumentId'],
          properties: {
            instrumentId: { type: 'integer', minimum: 1 },
            commit: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      if (!config.alphaVantageApiKey) {
        return reply
          .status(503)
          .send({ error: 'ALPHA_VANTAGE_API_KEY is not configured on the server.' })
      }

      const user = req.session.user!
      const { instrumentId, commit = false } = req.body

      const instrument = app.instruments.getById(user.tenantId, instrumentId)
      if (!instrument) return reply.status(404).send({ error: 'Instrument not found' })

      // Fetch from Alpha Vantage
      const url = `https://www.alphavantage.co/query?function=DIVIDENDS&symbol=${encodeURIComponent(instrument.ticker)}&apikey=${config.alphaVantageApiKey}`
      let avData: { ex_dividend_date: string; payment_date: string; amount: string }[]
      try {
        const resp = await fetch(url)
        if (!resp.ok)
          return reply.status(502).send({ error: `Alpha Vantage returned HTTP ${resp.status}` })
        const payload = (await resp.json()) as { data?: typeof avData; Information?: string }
        if (payload.Information) return reply.status(502).send({ error: payload.Information })
        avData = payload.data ?? []
      } catch (err) {
        return reply
          .status(502)
          .send({ error: `Alpha Vantage fetch failed: ${(err as Error).message}` })
      }

      // Load existing transactions to compute pool quantity at ex-date
      const allTxns = app.transactions.list(user.tenantId, { instrumentId })
      const sorted = [...allTxns].sort((a, b) =>
        a.txnDate < b.txnDate ? -1 : a.txnDate > b.txnDate ? 1 : a.id - b.id,
      )

      const ACQUISITION_TYPES = new Set([
        'BUY',
        'RSU_VEST',
        'ESPP_PURCHASE',
        'TRANSFER_IN',
        'RIGHTS_ISSUE',
        'DRIP',
      ])
      const DISPOSAL_TYPES = new Set(['SELL', 'TRANSFER_OUT'])

      function poolQtyAt(beforeDate: string): string {
        let qty = new Big(0)
        for (const t of sorted) {
          if (t.txnDate >= beforeDate) break
          if (ACQUISITION_TYPES.has(t.txnType)) qty = qty.plus(t.quantity)
          else if (DISPOSAL_TYPES.has(t.txnType)) qty = qty.minus(t.quantity)
          else if (t.txnType === 'SPLIT' && t.splitRatio) {
            const [num, den] = t.splitRatio.split('/')
            if (num && den) qty = qty.times(num).div(den)
          }
        }
        return qty.gt(0) ? qty.toFixed(6).replace(/\.?0+$/, '') || '0' : '0'
      }

      // Existing DIV_PAY dates for dedup (±3 days)
      const existingDates = sorted.filter((t) => t.txnType === 'DIV_PAY').map((t) => t.txnDate)
      function isDuplicate(date: string): boolean {
        return existingDates.some(
          (d) => Math.abs(new Date(date).getTime() - new Date(d).getTime()) / 86_400_000 <= 3,
        )
      }

      function resolvePaymentDate(rec: { ex_dividend_date: string; payment_date: string }): {
        date: string
        estimated: boolean
      } {
        if (rec.payment_date && rec.payment_date !== 'None')
          return { date: rec.payment_date, estimated: false }
        const d = new Date(rec.ex_dividend_date)
        d.setUTCDate(d.getUTCDate() + 30)
        return { date: d.toISOString().slice(0, 10), estimated: true }
      }

      // Build proposed rows
      const rows: {
        exDate: string
        paymentDate: string
        paymentDateEstimated: boolean
        amountPerShare: string
        quantity: string
        skipReason: string | null
      }[] = []
      for (const rec of avData) {
        if (!rec.amount || rec.amount === '0') continue
        const { date: paymentDate, estimated } = resolvePaymentDate(rec)
        const quantity = poolQtyAt(rec.ex_dividend_date)
        const skipReason = isDuplicate(paymentDate)
          ? 'duplicate'
          : quantity === '0'
            ? 'no shares held'
            : null
        rows.push({
          exDate: rec.ex_dividend_date,
          paymentDate,
          paymentDateEstimated: estimated,
          amountPerShare: rec.amount,
          quantity,
          skipReason,
        })
      }

      const toInsert = rows.filter((r) => r.skipReason === null)

      if (!commit) return { rows, inserted: 0 }

      // Insert
      let inserted = 0
      for (const r of toInsert) {
        const notes = [
          `ex_dividend_date: ${r.exDate}`,
          r.paymentDateEstimated ? 'payment_date estimated (ex+30d)' : null,
          'source: alpha-vantage',
        ]
          .filter(Boolean)
          .join(' | ')

        const body: CreateTransactionBody = {
          instrumentId,
          txnType: 'DIV_PAY',
          txnDate: r.paymentDate,
          quantity: r.quantity,
          unitPriceNative: r.amountPerShare,
          nativeCurrency: instrument.currency,
          costsGbp: '0',
          notes,
        }
        const txn = app.transactions.create(user.tenantId, body, user.id)
        await computeAndPersistGbpFields(
          user.tenantId,
          txn.id,
          user.id,
          body,
          app.fx,
          app.transactions,
          app.instruments,
        )
        inserted++
      }

      return { rows, inserted }
    },
  )
}

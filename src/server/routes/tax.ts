import type { FastifyPluginAsync } from 'fastify'
import type { TaxYearConfig } from '../../shared/types.ts'
import { runTaxEngine, runTaxEngineForInstrument } from '../services/tax/engine.ts'
import { buildCgtSummary } from '../services/tax/cgt_summary.ts'
import { computeDividendTax } from '../services/tax/dividends.ts'
import { computeEsppPurchaseIncome } from '../services/tax/espp.ts'
import { taxYearForDate } from '../services/tax/matching.ts'

interface TaxYearConfigRow {
  tax_year: string
  start_date: string
  end_date: string
  cgt_annual_exempt: string
  cgt_basic_rate: string
  cgt_higher_rate: string
  cgt_basic_rate_pre: string | null
  cgt_higher_rate_pre: string | null
  cgt_rate_change_date: string | null
  dividend_allowance: string
  dividend_basic_rate: string
  dividend_higher_rate: string
  dividend_addl_rate: string
  cgt_proceeds_threshold: string
  income_basic_rate_limit: string
}

function toTaxYearConfig(row: TaxYearConfigRow): TaxYearConfig {
  return {
    taxYear: row.tax_year,
    startDate: row.start_date,
    endDate: row.end_date,
    cgtAnnualExempt: row.cgt_annual_exempt,
    cgtBasicRate: row.cgt_basic_rate,
    cgtHigherRate: row.cgt_higher_rate,
    cgtBasicRatePre: row.cgt_basic_rate_pre,
    cgtHigherRatePre: row.cgt_higher_rate_pre,
    cgtRateChangeDate: row.cgt_rate_change_date,
    dividendAllowance: row.dividend_allowance,
    dividendBasicRate: row.dividend_basic_rate,
    dividendHigherRate: row.dividend_higher_rate,
    dividendAddlRate: row.dividend_addl_rate,
    cgtProceedsThreshold: row.cgt_proceeds_threshold,
    incomeBasicRateLimit: row.income_basic_rate_limit,
  }
}

export const taxRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /api/tax/years — list available tax year configs ──────────────────
  app.get('/years', async (req) => {
    const rows = app.db.prepare('SELECT * FROM tax_year_config ORDER BY tax_year').all() as unknown as TaxYearConfigRow[]
    return rows.map(toTaxYearConfig)
  })

  // ── POST /api/tax/run — re-run the tax engine for the tenant ──────────────
  // Optional body: { instrumentId?: number, incomeByYear?: Record<string, string> }
  app.post<{
    Body: { instrumentId?: number; incomeByYear?: Record<string, string> }
  }>(
    '/run',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            instrumentId: { type: 'integer', minimum: 1 },
            incomeByYear:  { type: 'object', additionalProperties: { type: 'string' } },
          },
        },
      },
    },
    async (req) => {
      const user = req.session.user!
      const configs = (
        app.db.prepare('SELECT * FROM tax_year_config ORDER BY tax_year').all() as unknown as TaxYearConfigRow[]
      ).map(toTaxYearConfig)

      if (req.body.instrumentId) {
        const result = runTaxEngineForInstrument(
          user.tenantId,
          req.body.instrumentId,
          app.transactions,
          app.cgtDisposals,
          app.s104Pools,
          configs,
        )
        return { disposalsRecorded: result.disposals.length, instrumentsProcessed: 1 }
      }

      const result = runTaxEngine(
        user.tenantId,
        app.transactions,
        app.cgtDisposals,
        app.s104Pools,
        configs,
        req.body.incomeByYear ?? {},
      )
      return result
    },
  )

  // ── GET /api/tax/summary?taxYear=2025-26 — CGT summary for a year ─────────
  app.get<{ Querystring: { taxYear?: string; income?: string } }>(
    '/summary',
    async (req, reply) => {
      const user = req.session.user!
      const taxYear = req.query.taxYear ?? taxYearForDate(new Date().toISOString().slice(0, 10))
      const income = req.query.income ?? '0'

      const configRow = app.db.prepare('SELECT * FROM tax_year_config WHERE tax_year = ?').get(taxYear) as TaxYearConfigRow | undefined
      if (!configRow) return reply.status(404).send({ error: `No tax year config for ${taxYear}` })

      const config = toTaxYearConfig(configRow)
      const disposals = app.cgtDisposals.list(user.tenantId, { taxYear })
      return buildCgtSummary(disposals, config, income)
    },
  )

  // ── GET /api/tax/disposals?taxYear=2025-26&instrumentId=1 ─────────────────
  app.get<{ Querystring: { taxYear?: string; instrumentId?: string } }>(
    '/disposals',
    async (req) => {
      const user = req.session.user!
      const opts: { taxYear?: string; instrumentId?: number } = {}
      if (req.query.taxYear) opts.taxYear = req.query.taxYear
      if (req.query.instrumentId) opts.instrumentId = parseInt(req.query.instrumentId, 10)
      return app.cgtDisposals.list(user.tenantId, opts)
    },
  )

  // ── GET /api/tax/dividends?taxYear=2025-26 ────────────────────────────────
  // Returns per-transaction dividend details plus an annual summary.
  app.get<{ Querystring: { taxYear?: string; income?: string } }>(
    '/dividends',
    async (req) => {
      const user = req.session.user!
      const taxYear = req.query.taxYear ?? taxYearForDate(new Date().toISOString().slice(0, 10))
      const incomeStr = req.query.income ?? '0'
      const incomeAboveBasicRate = parseInt(incomeStr, 10) > 50270

      const configRow = app.db.prepare('SELECT * FROM tax_year_config WHERE tax_year = ?').get(taxYear) as TaxYearConfigRow | undefined
      if (!configRow) return { items: [], summary: null }

      const config = toTaxYearConfig(configRow)

      const [startDate, endDate] = [configRow.start_date, configRow.end_date]
      const txns = app.transactions.list(user.tenantId, { from: startDate, to: endDate })
      const dividendTxns = txns.filter(t => t.txnType === 'DIV_PAY')

      const items = dividendTxns.map(txn => computeDividendTax(txn, config, taxYear, incomeAboveBasicRate))

      // Annual summary: aggregate across all dividend transactions.
      // The dividend allowance is applied once across the year, not per-transaction,
      // so we re-derive totals directly from per-txn gross amounts.
      const { default: Big } = await import('big.js')
      const totalGrossGbp = items.reduce((s, r) => s.plus(r.grossGbp), new Big(0))
      const totalWithholdingGbp = items.reduce((s, r) => s.plus(r.withholdingGbp), new Big(0))
      const totalFtcr = items.reduce((s, r) => s.plus(r.ftcr), new Big(0))
      const totalUkTaxAfterCredit = items.reduce((s, r) => s.plus(r.ukTaxAfterCredit), new Big(0))
      const allowance = new Big(config.dividendAllowance)
      const taxableGross = totalGrossGbp.minus(allowance).gt(0)
        ? totalGrossGbp.minus(allowance)
        : new Big(0)
      const ukRate = incomeAboveBasicRate
        ? new Big(config.dividendHigherRate)
        : new Big(config.dividendBasicRate)
      const annualUkTaxBeforeCredit = taxableGross.times(ukRate)
      const annualFtcr = annualUkTaxBeforeCredit.lt(totalWithholdingGbp)
        ? annualUkTaxBeforeCredit
        : totalWithholdingGbp
      const annualUkTaxAfterCredit = annualUkTaxBeforeCredit.minus(annualFtcr)

      const summary = {
        totalGrossGbp: totalGrossGbp.toFixed(8),
        totalWithholdingGbp: totalWithholdingGbp.toFixed(8),
        dividendAllowance: config.dividendAllowance,
        taxableGrossGbp: taxableGross.toFixed(8),
        rateBand: (incomeAboveBasicRate ? 'higher' : 'basic') as 'basic' | 'higher',
        ukRateApplied: ukRate.toFixed(4),
        ukTaxBeforeCredit: annualUkTaxBeforeCredit.toFixed(8),
        totalFtcr: annualFtcr.toFixed(8),
        ukTaxAfterCredit: annualUkTaxAfterCredit.toFixed(8),
        transactionCount: items.length,
      }

      return { items, summary }
    },
  )

  // ── GET /api/tax/espp?taxYear=2025-26 ────────────────────────────────────
  // Returns ESPP_PURCHASE employment-income details for a tax year.
  // Also includes unrealised vest_schedule entries (espp-purchase with a discount
  // price) as projected items, flagged with isProjection: true.
  app.get<{ Querystring: { taxYear?: string } }>(
    '/espp',
    async (req) => {
      const user = req.session.user!
      const taxYear = req.query.taxYear ?? taxYearForDate(new Date().toISOString().slice(0, 10))

      const configRow = app.db.prepare('SELECT * FROM tax_year_config WHERE tax_year = ?').get(taxYear) as TaxYearConfigRow | undefined
      if (!configRow) return { items: [], projectedItems: [], summary: null }

      const { default: Big } = await import('big.js')
      const [startDate, endDate] = [configRow.start_date, configRow.end_date]

      // ── Confirmed transactions ─────────────────────────────────────────────
      const txns = app.transactions.list(user.tenantId, { from: startDate, to: endDate })
      const esppTxns = txns.filter(t => t.txnType === 'ESPP_PURCHASE' && t.esppDiscountPriceGbp)

      const items = esppTxns.map(txn =>
        computeEsppPurchaseIncome(txn, txn.esppDiscountPriceGbp!, taxYear)
      )

      // ── Projected (unrealised) vest_schedule entries ───────────────────────
      interface VestScheduleRow {
        id: number; instrument_id: number; scheduled_date: string
        quantity: string; expected_discount_price_native: string | null
      }
      const scheduleRows = app.db.prepare(`
        SELECT vs.id, vs.instrument_id, vs.scheduled_date, vs.quantity,
               vs.expected_discount_price_native
        FROM vest_schedule vs
        WHERE vs.tenant_id = ?
          AND vs.schedule_type = 'espp-purchase'
          AND vs.expected_discount_price_native IS NOT NULL
          AND vs.realised_txn_id IS NULL
          AND vs.scheduled_date >= ?
          AND vs.scheduled_date <= ?
      `).all(user.tenantId, startDate, endDate) as unknown as VestScheduleRow[]

      interface ProjectedEsppItem {
        scheduleId: number
        scheduledDate: string
        taxYear: string
        quantity: string
        mvAtPurchaseGbp: string | null
        pricePaidGbp: string | null
        discountGbp: string | null
        incomeAmountGbp: string | null
        poolCostGbp: string | null
        priceDate: string | null
        isProjection: true
      }

      const projectedItems: ProjectedEsppItem[] = []

      for (const row of scheduleRows) {
        const instrument = app.instruments.getById(user.tenantId, row.instrument_id)
        const latest = app.priceService.getLatestCached(row.instrument_id)

        let mvAtPurchaseGbp: string | null = null
        let pricePaidGbp: string | null = null
        let discountGbp: string | null = null
        let incomeAmountGbp: string | null = null
        let poolCostGbp: string | null = null
        let priceDate: string | null = null

        if (latest && instrument && row.expected_discount_price_native) {
          try {
            priceDate = latest.priceDate
            const currency = instrument.currency
            let priceGbp: InstanceType<typeof Big>
            if (currency === 'GBP') {
              priceGbp = new Big(latest.closePrice)
            } else if (currency === 'GBX') {
              priceGbp = new Big(latest.closePrice).div(100)
            } else {
              const fx = await app.fx.getRate(currency, 'GBP', latest.priceDate)
              priceGbp = new Big(latest.closePrice).times(fx.rate)
            }

            // Discount price is stored in native currency; apply same FX conversion
            let discountPriceGbp: InstanceType<typeof Big>
            if (currency === 'GBP') {
              discountPriceGbp = new Big(row.expected_discount_price_native)
            } else if (currency === 'GBX') {
              discountPriceGbp = new Big(row.expected_discount_price_native).div(100)
            } else {
              const fx = await app.fx.getRate(currency, 'GBP', latest.priceDate)
              discountPriceGbp = new Big(row.expected_discount_price_native).times(fx.rate)
            }

            const qty = new Big(row.quantity)
            const discountPerShare = priceGbp.minus(discountPriceGbp)

            if (discountPerShare.gt(0)) {
              mvAtPurchaseGbp = priceGbp.toFixed(8)
              pricePaidGbp = discountPriceGbp.toFixed(8)
              discountGbp = discountPerShare.times(qty).toFixed(8)
              incomeAmountGbp = discountGbp
              poolCostGbp = priceGbp.times(qty).toFixed(8)
            }
          } catch {
            // FX unavailable — leave nulls
          }
        }

        projectedItems.push({
          scheduleId: row.id,
          scheduledDate: row.scheduled_date,
          taxYear,
          quantity: row.quantity,
          mvAtPurchaseGbp,
          pricePaidGbp,
          discountGbp,
          incomeAmountGbp,
          poolCostGbp,
          priceDate,
          isProjection: true,
        })
      }

      // ── Totals (confirmed only for summary; projected shown separately) ────
      const totalIncomeGbp = items.reduce((s, r) => s.plus(r.incomeAmountGbp), new Big(0))
      const totalDiscountGbp = items.reduce((s, r) => s.plus(r.discountGbp), new Big(0))
      const totalPoolCostGbp = items.reduce((s, r) => s.plus(r.poolCostGbp), new Big(0))

      const projectedIncomeGbp = projectedItems.reduce(
        (s, r) => s.plus(r.incomeAmountGbp ?? '0'), new Big(0)
      )

      const summary = items.length === 0 && projectedItems.length === 0 ? null : {
        totalIncomeGbp: totalIncomeGbp.toFixed(8),
        totalDiscountGbp: totalDiscountGbp.toFixed(8),
        totalPoolCostGbp: totalPoolCostGbp.toFixed(8),
        transactionCount: items.length,
        projectedIncomeGbp: projectedIncomeGbp.toFixed(8),
        projectedCount: projectedItems.length,
        hasProjections: projectedItems.length > 0,
      }

      return { items, projectedItems, summary }
    },
  )

  // ── GET /api/tax/pool-history?instrumentId=1 ─────────────────────────────
  // Returns the S104 pool state after each transaction that affects it,
  // ordered chronologically. Useful for showing the running cost basis.
  app.get<{ Querystring: { instrumentId: string } }>(
    '/pool-history',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['instrumentId'],
          properties: { instrumentId: { type: 'string', pattern: '^\\d+$' } },
        },
      },
    },
    async (req) => {
      const user = req.session.user!
      const instrumentId = parseInt(req.query.instrumentId, 10)
      const txns = app.transactions.list(user.tenantId, { instrumentId })

      // Replay transactions in chronological order, capturing pool state after each
      const sorted = [...txns].sort((a, b) => {
        if (a.txnDate < b.txnDate) return -1
        if (a.txnDate > b.txnDate) return 1
        return a.id - b.id
      })

      const { addToPool, disposeFromPool, emptyPool, poolAvgCost, applyStockSplit, applyCapReturn } = await import('../services/tax/pool.ts')
      const { default: Big } = await import('big.js')
      let pool = emptyPool()
      const history: { txnId: number; date: string; txnType: string; quantity: string; costGbp: string; avgCostGbp: string }[] = []
      for (const txn of sorted) {
        const qty = txn.quantity
        switch (txn.txnType) {
          case 'BUY':
          case 'RSU_VEST':
          case 'ESPP_PURCHASE':
          case 'TRANSFER_IN':
          case 'DRIP': {
            // Use the same cost the engine uses: unitPriceGbp × quantity
            const costGbp = txn.unitPriceGbp
              ? new Big(txn.unitPriceGbp).times(qty).toFixed(8)
              : txn.totalGbp ?? '0'
            pool = addToPool(pool, qty, costGbp)
            break
          }
          case 'SELL':
          case 'TRANSFER_OUT': {
            const result = disposeFromPool(pool, qty)
            pool = result.pool
            break
          }
          case 'SPLIT': {
            if (txn.splitRatio) pool = applyStockSplit(pool, txn.splitRatio)
            continue
          }
          case 'UNSPLIT': {
            if (txn.splitRatio) {
              const [num, den] = txn.splitRatio.split('/')
              pool = applyStockSplit(pool, `${den}/${num}`)
            }
            continue
          }
          case 'CAPRETURN': {
            if (txn.capreturnsPerShareGbp) pool = applyCapReturn(pool, txn.capreturnsPerShareGbp)
            continue
          }
          default:
            continue
        }
        history.push({
          txnId: txn.id,
          date: txn.txnDate,
          txnType: txn.txnType,
          quantity: pool.quantity,
          costGbp: pool.costGbp,
          avgCostGbp: poolAvgCost(pool),
        })
      }

      return history
    },
  )

  // ── GET /api/tax/pool?instrumentId=1 ──────────────────────────────────────
  app.get<{ Querystring: { instrumentId: string } }>(
    '/pool',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['instrumentId'],
          properties: { instrumentId: { type: 'string', pattern: '^\\d+$' } },
        },
      },
    },
    async (req) => {
      const user = req.session.user!
      return app.s104Pools.get(user.tenantId, parseInt(req.query.instrumentId, 10))
    },
  )
}

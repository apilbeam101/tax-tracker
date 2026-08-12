/**
 * Import and export routes.
 *
 * Import:
 *   POST /api/import/preview  — parse CSV + column map, return rows (no DB write)
 *   POST /api/import/commit   — insert valid rows into txn table (with FX backfill)
 *
 * Export:
 *   GET  /api/export/transactions  — all (or filtered) transactions
 *   GET  /api/export/disposals     — CGT disposal records
 *   GET  /api/export/report        — annual PDF report
 *
 * Supported export formats: csv | cgtcalculator | cgtcalc | pdf
 */

import type { FastifyPluginAsync } from 'fastify'
import type { CreateTransactionBody, Instrument } from '../../shared/types.ts'
import { formatCgtCalculator, toCgtCalculatorRows } from '../services/export/cgtcalculator.ts'
import { disposalsToCsv, transactionsToCsv } from '../services/export/csv.ts'
import type { DividendRow, HoldingRow } from '../services/export/pdf.ts'
import { generateAnnualReportPdf } from '../services/export/pdf.ts'
import type { ColumnMapping, MappedRow } from '../services/import/csv-mapper.ts'
import { mapCsvToTransactions, toCreateBody, validRows } from '../services/import/csv-mapper.ts'
import { buildCgtSummary } from '../services/tax/cgt_summary.ts'
import { computeDividendTax } from '../services/tax/dividends.ts'
import { taxYearForDate } from '../services/tax/matching.ts'
import { linkRealisedProjection, recalcInstrument } from '../services/tax/recalc.ts'
import { applyAutoWithholding } from '../services/tax/withholding.ts'

// Shared helper used in transactions route — duplicated here to avoid coupling
async function computeAndPersistGbpFields(
  tenantId: number,
  txnId: number,
  userId: number,
  body: CreateTransactionBody,
  fx: import('../services/fx/index.ts').FxService,
  store: import('../repositories/index.ts').TransactionStore,
  instruments: import('../repositories/index.ts').InstrumentStore,
): Promise<void> {
  if (!body.unitPriceNative || !body.quantity) return
  const { default: Big } = await import('big.js')

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

  const update: import('../../shared/types.ts').UpdateTransactionBody = {
    unitPriceGbp: unitGbp.toFixed(8),
    totalGbp: totalGbp.toFixed(8),
  }

  if (fxRateRecord) {
    update.fxRate = fxRateRecord.rate
    update.fxRateType = fxRateRecord.rateType as import('../../shared/types.ts').FxRateType
  }

  const isBuy = ['BUY', 'RSU_VEST', 'ESPP_PURCHASE', 'TRANSFER_IN', 'RIGHTS_ISSUE'].includes(
    body.txnType,
  )
  update.netGbp = isBuy
    ? totalGbp.plus(costsGbp).neg().toFixed(8)
    : totalGbp.minus(costsGbp).toFixed(8)

  store.update(tenantId, txnId, update, userId)
}

// ── Route schema types ────────────────────────────────────────────────────────

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

function toTaxYearConfig(row: TaxYearConfigRow) {
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

// ── Plugin ────────────────────────────────────────────────────────────────────

export const importExportRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /api/import/preview ──────────────────────────────────────────────
  // Parse the CSV and apply the mapping; return rows without writing to the DB.
  app.post<{
    Body: { csvText: string; mappings: ColumnMapping[]; hasHeader?: boolean }
  }>(
    '/import/preview',
    {
      schema: {
        body: {
          type: 'object',
          required: ['csvText', 'mappings'],
          properties: {
            csvText: { type: 'string', maxLength: 5_000_000 },
            hasHeader: { type: 'boolean' },
            mappings: {
              type: 'array',
              items: {
                type: 'object',
                required: ['source', 'target'],
                properties: {
                  source: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
                  target: { type: 'string' },
                  transform: { type: 'object' },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const rows = mapCsvToTransactions(
          req.body.csvText,
          req.body.mappings,
          req.body.hasHeader ?? true,
        )
        return { rows, validCount: validRows(rows).length }
      } catch (err) {
        return reply.status(400).send({ error: `CSV parse error: ${(err as Error).message}` })
      }
    },
  )

  // ── POST /api/import/commit ───────────────────────────────────────────────
  // Insert valid rows into the transaction table and backfill GBP fields.
  //
  // instrumentId is optional when the ticker field is mapped in the CSV —
  // the server resolves the instrument per row from the ticker.
  // instrumentId is used as a fallback for rows that have no ticker value.
  // If neither is available for a row it is skipped with an error.
  app.post<{
    Body: {
      csvText: string
      mappings: ColumnMapping[]
      instrumentId?: number
      hasHeader?: boolean
    }
  }>(
    '/import/commit',
    {
      schema: {
        body: {
          type: 'object',
          required: ['csvText', 'mappings'],
          properties: {
            csvText: { type: 'string', maxLength: 5_000_000 },
            instrumentId: { type: 'integer', minimum: 1 },
            hasHeader: { type: 'boolean' },
            mappings: {
              type: 'array',
              items: {
                type: 'object',
                required: ['source', 'target'],
                properties: {
                  source: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
                  target: { type: 'string' },
                  transform: { type: 'object' },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.session.user!
      const { csvText, mappings, instrumentId, hasHeader = true } = req.body

      // Validate the fallback instrument if provided
      if (instrumentId !== undefined) {
        const inst = app.instruments.getById(user.tenantId, instrumentId)
        if (!inst) return reply.status(404).send({ error: 'Instrument not found' })
      }

      let rows: MappedRow[]
      try {
        rows = mapCsvToTransactions(csvText, mappings, hasHeader)
      } catch (err) {
        return reply.status(400).send({ error: `CSV parse error: ${(err as Error).message}` })
      }

      const toInsert = validRows(rows)
      if (toInsert.length === 0) {
        return reply.status(400).send({ error: 'No valid rows to import', rows })
      }

      // Build a ticker → instrument map for fast lookup
      const allInstruments = app.instruments.list(user.tenantId)
      const byTicker = new Map(allInstruments.map((i) => [i.ticker.toUpperCase(), i]))

      let inserted = 0
      const errors: { index: number; error: string }[] = []
      const touchedInstruments = new Set<number>()

      for (const row of toInsert) {
        // Resolve instrument: per-row ticker takes priority, fallback to request-level id
        let resolvedId: number | undefined
        if (row.ticker) {
          const inst = byTicker.get(row.ticker.toUpperCase())
          if (inst) {
            resolvedId = inst.id
          } else {
            errors.push({ index: row.index, error: `Unknown ticker: ${row.ticker}` })
            continue
          }
        } else if (instrumentId !== undefined) {
          resolvedId = instrumentId
        } else {
          errors.push({
            index: row.index,
            error: 'No ticker in row and no default instrument specified',
          })
          continue
        }

        try {
          const body = toCreateBody(row, resolvedId)
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
          linkRealisedProjection(
            app,
            user.tenantId,
            resolvedId,
            body.txnType,
            body.txnDate,
            body.quantity,
            txn.id,
          )
          applyAutoWithholding(user.tenantId, txn.id, user.id, app.transactions, app.instruments)
          inserted++
          touchedInstruments.add(resolvedId)
        } catch (err) {
          errors.push({ index: row.index, error: (err as Error).message })
        }
      }

      // Recalc once per instrument (not per row) now that all rows are in —
      // avoids O(n²) recalcs and spurious "exceeds pool" failures from rows
      // landing out of chronological order mid-import.
      for (const id of touchedInstruments) {
        recalcInstrument(app, user.tenantId, id)
      }

      return { inserted, errors, skippedInvalid: rows.length - toInsert.length }
    },
  )

  // ── GET /api/export/transactions ──────────────────────────────────────────
  // format: csv | cgtcalculator | cgtcalc
  app.get<{ Querystring: { format?: string; instrumentId?: string; from?: string; to?: string } }>(
    '/export/transactions',
    async (req, reply) => {
      const user = req.session.user!
      const format = req.query.format ?? 'csv'
      const opts: { instrumentId?: number; from?: string; to?: string } = {}
      if (req.query.instrumentId) opts.instrumentId = parseInt(req.query.instrumentId, 10)
      if (req.query.from) opts.from = req.query.from
      if (req.query.to) opts.to = req.query.to

      const txns = app.transactions.list(user.tenantId, opts)
      const allInstruments = app.instruments.list(user.tenantId)
      const instrumentsById = new Map<number, Instrument>(allInstruments.map((i) => [i.id, i]))

      if (format === 'cgtcalculator') {
        const rows = toCgtCalculatorRows(txns, instrumentsById)
        reply.header('Content-Type', 'text/plain')
        reply.header('Content-Disposition', 'attachment; filename="transactions-cgtcalculator.txt"')
        return reply.send(formatCgtCalculator(rows))
      }

      const csv = transactionsToCsv(txns, instrumentsById)
      reply.header('Content-Type', 'text/csv')
      reply.header('Content-Disposition', 'attachment; filename="transactions.csv"')
      return reply.send(csv)
    },
  )

  // ── GET /api/export/disposals ─────────────────────────────────────────────
  // format: csv
  app.get<{ Querystring: { format?: string; taxYear?: string; instrumentId?: string } }>(
    '/export/disposals',
    async (req, reply) => {
      const user = req.session.user!
      const opts: { taxYear?: string; instrumentId?: number } = {}
      if (req.query.taxYear) opts.taxYear = req.query.taxYear
      if (req.query.instrumentId) opts.instrumentId = parseInt(req.query.instrumentId, 10)

      const disposals = app.cgtDisposals.list(user.tenantId, opts)
      const allInstruments = app.instruments.list(user.tenantId)
      const instrumentsById = new Map<number, Instrument>(allInstruments.map((i) => [i.id, i]))

      const csv = disposalsToCsv(disposals, instrumentsById)
      reply.header('Content-Type', 'text/csv')
      const suffix = opts.taxYear ? `-${opts.taxYear}` : ''
      reply.header('Content-Disposition', `attachment; filename="disposals${suffix}.csv"`)
      return reply.send(csv)
    },
  )

  // ── GET /api/export/report ────────────────────────────────────────────────
  // Generate annual PDF report.  ?taxYear=2025-26&income=0
  app.get<{ Querystring: { taxYear?: string; income?: string } }>(
    '/export/report',
    async (req, reply) => {
      const user = req.session.user!
      const taxYear = req.query.taxYear ?? taxYearForDate(new Date().toISOString().slice(0, 10))
      const income = req.query.income ?? '0'

      const configRow = app.db
        .prepare('SELECT * FROM tax_year_config WHERE tax_year = ?')
        .get(taxYear) as TaxYearConfigRow | undefined
      if (!configRow) return reply.status(404).send({ error: `No tax year config for ${taxYear}` })

      const config = toTaxYearConfig(configRow)
      const disposals = app.cgtDisposals.list(user.tenantId, { taxYear })
      const summary = buildCgtSummary(disposals, config, income)

      const allInstruments = app.instruments.list(user.tenantId)
      const instrumentsById = new Map<number, Instrument>(allInstruments.map((i) => [i.id, i]))

      // Holdings from pool store + price service
      const { default: Big } = await import('big.js')
      const holdings: HoldingRow[] = []
      for (const instrument of allInstruments) {
        const pool = app.s104Pools.get(user.tenantId, instrument.id)
        if (!pool || parseFloat(pool.quantity) <= 0) continue
        const price = app.priceService.getLatestCached(instrument.id)
        let valueGbp: string | null = null
        let unrealisedGainGbp: string | null = null
        if (price) {
          let priceGbp: string
          if (instrument.currency === 'GBP') {
            priceGbp = price.closePrice
          } else {
            const fxResult = await app.fx.convert(
              price.closePrice,
              instrument.currency,
              'GBP',
              price.priceDate,
            )
            priceGbp = fxResult.gbp
          }
          const value = new Big(pool.quantity).times(priceGbp)
          valueGbp = value.toFixed(2)
          unrealisedGainGbp = value.minus(pool.costGbp).toFixed(2)
        }
        holdings.push({
          ticker: instrument.ticker,
          quantity: pool.quantity,
          costGbp: pool.costGbp,
          valueGbp,
          unrealisedGainGbp,
        })
      }

      // Dividend rows
      const dividendTxns = app.transactions
        .list(user.tenantId, {
          from: configRow.start_date,
          to: configRow.end_date,
        })
        .filter((t) => t.txnType === 'DIV_PAY')

      const incomeAboveBasicRate = parseFloat(income) > parseFloat(config.incomeBasicRateLimit)
      const dividends: DividendRow[] = dividendTxns.map((txn) => {
        const dtax = computeDividendTax(txn, config, taxYear, incomeAboveBasicRate)
        const instrument = instrumentsById.get(txn.instrumentId)
        return {
          txnDate: txn.txnDate,
          ticker: instrument?.ticker ?? '',
          grossGbp: dtax.grossGbp,
          withholdingGbp: dtax.withholdingGbp,
          netGbp: dtax.ukTaxAfterCredit,
          ftcrGbp: dtax.ftcr,
        }
      })

      const pdfBuffer = await generateAnnualReportPdf({
        taxYear,
        summary,
        holdings,
        disposals,
        instrumentsById,
        dividends,
        generatedAt: new Date().toISOString().slice(0, 10),
      })

      reply.header('Content-Type', 'application/pdf')
      reply.header('Content-Disposition', `attachment; filename="cgt-report-${taxYear}.pdf"`)
      return reply.send(pdfBuffer)
    },
  )
}

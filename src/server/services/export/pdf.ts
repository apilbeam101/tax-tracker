/**
 * Annual report PDF exporter via pdfkit.
 *
 * Sections:
 *   1. Cover page — tax year, generated date, summary figures
 *   2. Holdings — cost basis, current value, unrealised gain
 *   3. Realised disposals — date, ticker, match type, proceeds, cost, gain
 *   4. Dividend income — date, ticker, gross, withholding, net, FTCR
 *   5. Estimated liability — taxable gain after AEA, rates, liability
 *
 * Returns a Buffer containing the PDF bytes.
 */

import PDFDocument from 'pdfkit'
import type { Instrument } from '../../../shared/types.ts'
import type { CgtDisposalRecord } from '../tax/matching.ts'
import type { CgtSummary } from '../tax/cgt_summary.ts'

export interface HoldingRow {
  ticker: string
  quantity: string
  costGbp: string | null
  valueGbp: string | null
  unrealisedGainGbp: string | null
}

export interface DividendRow {
  txnDate: string
  ticker: string
  grossGbp: string
  withholdingGbp: string
  netGbp: string
  ftcrGbp: string
}

function fmt(v: string | null | undefined, decimals = 2): string {
  if (v == null) return '—'
  const n = parseFloat(v)
  if (isNaN(n)) return v
  return `£${n.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

function fmtNum(v: string | null | undefined): string {
  if (v == null) return '—'
  return parseFloat(v).toLocaleString('en-GB', { maximumFractionDigits: 6 })
}

const MARGIN = 50
const LINE = 16
const COL_GAP = 10

function tableRow(
  doc: InstanceType<typeof PDFDocument>,
  y: number,
  cols: string[],
  widths: number[],
  bold = false,
): void {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
  let x = MARGIN
  for (let i = 0; i < cols.length; i++) {
    doc.text(cols[i] ?? '', x, y, { width: widths[i]!, ellipsis: true, lineBreak: false })
    x += widths[i]! + COL_GAP
  }
}

function sectionTitle(doc: InstanceType<typeof PDFDocument>, title: string): void {
  doc.moveDown(0.5)
  doc.font('Helvetica-Bold').fontSize(12).text(title)
  doc.moveDown(0.3)
}

export async function generateAnnualReportPdf(opts: {
  taxYear: string
  summary: CgtSummary
  holdings: HoldingRow[]
  disposals: CgtDisposalRecord[]
  instrumentsById: Map<number, Instrument>
  dividends: DividendRow[]
  generatedAt: string
}): Promise<Buffer> {
  const { taxYear, summary, holdings, disposals, instrumentsById, dividends, generatedAt } = opts

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN, size: 'A4' })
    const chunks: Buffer[] = []
    doc.on('data', chunk => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    // ── Cover ────────────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(22).text('UK CGT Annual Report', { align: 'center' })
    doc.moveDown(0.5)
    doc.font('Helvetica').fontSize(14).text(`Tax Year ${taxYear}`, { align: 'center' })
    doc.moveDown(0.3)
    doc.fontSize(10).text(`Generated: ${generatedAt}`, { align: 'center' })
    doc.moveDown(2)

    // Summary box
    doc.font('Helvetica-Bold').fontSize(10)
    const summaryItems = [
      ['Total proceeds',           fmt(summary.totalProceeds)],
      ['Allowable costs',          fmt(summary.totalAllowableCost)],
      ['Gross gain',               fmt(summary.grossGain)],
      ['Gross loss',               fmt(summary.grossLoss)],
      ['Net gain / (loss)',        fmt(summary.netGain)],
      ['Annual exempt amount',     fmt(summary.annualExempt)],
      ['Taxable gain',             fmt(summary.taxableGain)],
      ['Estimated CGT liability',  fmt(summary.estimatedTax)],
    ]
    for (const [label, value] of summaryItems) {
      doc.font('Helvetica-Bold').fontSize(10).text(label + ':', MARGIN, doc.y, { continued: true, width: 200 })
      doc.font('Helvetica').text(value ?? '')
    }

    // ── Holdings ─────────────────────────────────────────────────────────────
    doc.addPage()
    sectionTitle(doc, '1. Current Holdings')

    const hWidths = [60, 70, 90, 90, 100]
    tableRow(doc, doc.y, ['Ticker', 'Shares', 'Cost (£)', 'Value (£)', 'Unrealised G/L (£)'], hWidths, true)
    doc.moveDown(0.3)

    for (const h of holdings) {
      if (doc.y > 740) doc.addPage()
      tableRow(doc, doc.y, [
        h.ticker,
        fmtNum(h.quantity),
        fmt(h.costGbp),
        fmt(h.valueGbp),
        fmt(h.unrealisedGainGbp),
      ], hWidths)
      doc.moveDown(0.25)
    }

    // ── Disposals ────────────────────────────────────────────────────────────
    doc.addPage()
    sectionTitle(doc, '2. Realised Disposals')

    const dWidths = [55, 75, 55, 65, 85, 85, 70]
    tableRow(doc, doc.y, ['Date', 'Ticker', 'Match', 'Shares', 'Proceeds (£)', 'Cost (£)', 'Gain (£)'], dWidths, true)
    doc.moveDown(0.3)

    for (const d of disposals) {
      if (doc.y > 740) doc.addPage()
      const instrument = instrumentsById.get(d.instrumentId)
      tableRow(doc, doc.y, [
        d.disposalDate,
        instrument?.ticker ?? '',
        d.matchType,
        fmtNum(d.quantity),
        fmt(d.proceedsGbp),
        fmt(d.allowableCostGbp),
        fmt(d.gainGbp),
      ], dWidths)
      doc.moveDown(0.25)
    }

    // ── Dividends ────────────────────────────────────────────────────────────
    if (dividends.length > 0) {
      doc.addPage()
      sectionTitle(doc, '3. Dividend Income')

      const divWidths = [65, 60, 80, 90, 80, 70]
      tableRow(doc, doc.y, ['Date', 'Ticker', 'Gross (£)', 'Withholding (£)', 'Net (£)', 'FTCR (£)'], divWidths, true)
      doc.moveDown(0.3)

      for (const div of dividends) {
        if (doc.y > 740) doc.addPage()
        tableRow(doc, doc.y, [
          div.txnDate, div.ticker,
          fmt(div.grossGbp), fmt(div.withholdingGbp),
          fmt(div.netGbp), fmt(div.ftcrGbp),
        ], divWidths)
        doc.moveDown(0.25)
      }
    }

    // ── Liability breakdown ──────────────────────────────────────────────────
    doc.addPage()
    sectionTitle(doc, dividends.length > 0 ? '4. Estimated CGT Liability' : '3. Estimated CGT Liability')

    const liabilityItems = [
      ['Taxable gain after AEA',    fmt(summary.taxableGain)],
      ['Basic rate estimate',        fmt(summary.taxAtBasicRate)],
      ['Higher rate estimate',       fmt(summary.taxAtHigherRate)],
      ['Best estimate liability',    fmt(summary.estimatedTax)],
      ['Must report to HMRC',        summary.mustReport ? 'Yes' : 'No'],
    ]
    for (const [label, value] of liabilityItems) {
      doc.font('Helvetica-Bold').fontSize(10).text(label + ':', MARGIN, doc.y, { continued: true, width: 220 })
      doc.font('Helvetica').text(value ?? '')
    }

    doc.font('Helvetica').fontSize(8).moveDown(2)
      .text('This report is generated for informational purposes only and does not constitute tax advice. Verify all figures with a qualified tax adviser before filing.')

    doc.end()
  })
}

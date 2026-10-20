/**
 * Annual report PDF exporter via pdfkit.
 *
 * Sections:
 *   Cover — tax year, generated date, summary figures for the return boxes
 *   1. Holdings — cost basis, current value, unrealised gain
 *   2. Disposal computations — the per-disposal working HMRC requires
 *   3. Realised disposals — match-level recap table
 *   4. Section 104 pool history — provenance for every pooled average cost
 *   5. Dividend income — date, ticker, gross, withholding, net, FTCR
 *   6. Estimated liability — taxable gain after AEA, rates, liability
 *
 * Section 2 is the part that satisfies "you must provide a computation for each
 * disposal"; the rest is supporting context. Section 4 matters because a
 * pool-matched disposal cannot otherwise be evidenced — the average cost is
 * only meaningful alongside the acquisitions that built it.
 *
 * Returns a Buffer containing the PDF bytes.
 */

import Big from 'big.js'
import PDFDocument from 'pdfkit'
import type { Instrument } from '../../../shared/types.ts'
import type { CgtSummary } from '../tax/cgt_summary.ts'
import type { CgtDisposalRecord, PoolSnapshot } from '../tax/matching.ts'
import type { DisposalComputation } from './computation.ts'

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
  if (Number.isNaN(n)) return v
  const abs = Math.abs(n).toLocaleString('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  // Parentheses rather than a minus sign, matching the text renderer and the
  // convention a reviewer expects on a tax computation.
  return n < 0 ? `(£${abs})` : `£${abs}`
}

function fmtNum(v: string | null | undefined): string {
  if (v == null) return '—'
  return parseFloat(v).toLocaleString('en-GB', { maximumFractionDigits: 6 })
}

const MARGIN = 50
const COL_GAP = 10

/**
 * Shorten text to fit a column, measured in the font currently set.
 *
 * Necessary because the cell render runs with `lineBreak: false` — pdfkit will
 * otherwise draw the full string straight past the column edge and over its
 * neighbour. Truncating here keeps that impossible for any input, rather than
 * relying on every label happening to be short enough.
 */
function clip(doc: InstanceType<typeof PDFDocument>, text: string, width: number): string {
  if (doc.widthOfString(text) <= width) return text
  let out = text
  while (out.length > 1 && doc.widthOfString(`${out}…`) > width) {
    out = out.slice(0, -1)
  }
  return `${out}…`
}

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
    // Reset the cursor for every cell. `ellipsis` engages pdfkit's line
    // wrapper, which advances its own cursor as it renders, so later cells in
    // the same row drift off the baseline of the earlier ones even though all
    // are passed the same y. Writing y back each time pins the whole row.
    doc.x = x
    doc.y = y
    doc.text(clip(doc, cols[i] ?? '', widths[i]!), x, y, { width: widths[i]!, lineBreak: false })
    x += widths[i]! + COL_GAP
  }
  doc.y = y
}

const ROW_HEIGHT = 14
// A4 is 841.89pt tall; with MARGIN top and bottom the last baseline that still
// fits a row is comfortably under this.
const PAGE_BOTTOM = 770

/**
 * Draw table rows at explicitly tracked y positions.
 *
 * A row is several independently positioned cells, and pdfkit's implicit
 * cursor is not reliable across them: a row drawn near the page boundary can
 * end up with its leading cells on one page and the rest on the next, which
 * reads as one row's columns overlapping its neighbour. Tracking y here keeps
 * every cell of a row on one baseline and only breaks pages between rows.
 */
function tableRows(
  doc: InstanceType<typeof PDFDocument>,
  widths: number[],
  rows: string[][],
): void {
  let y = doc.y
  for (const cols of rows) {
    if (y > PAGE_BOTTOM) {
      doc.addPage()
      y = doc.y
    }
    tableRow(doc, y, cols, widths)
    y += ROW_HEIGHT
  }
  doc.y = y
}

function tableHeader(
  doc: InstanceType<typeof PDFDocument>,
  widths: number[],
  cols: string[],
): void {
  if (doc.y > PAGE_BOTTOM - ROW_HEIGHT) doc.addPage()
  tableRow(doc, doc.y, cols, widths, true)
  doc.y += ROW_HEIGHT
}

function sectionTitle(doc: InstanceType<typeof PDFDocument>, title: string): void {
  doc.moveDown(0.5)
  doc.font('Helvetica-Bold').fontSize(12).text(title)
  doc.moveDown(0.3)
}

// Raw enum names overflow the narrow table columns, and pdfkit will not
// ellipsise with lineBreak disabled — it just draws past the column edge into
// the next one. Shorten at source rather than relying on truncation.
const TXN_TYPE_LABEL: Record<string, string> = {
  BUY: 'Buy',
  SELL: 'Sell',
  RSU_VEST: 'RSU vest',
  ESPP_PURCHASE: 'ESPP',
  TRANSFER_IN: 'Transfer in',
  TRANSFER_OUT: 'Transfer out',
  DRIP: 'DRIP',
  SPLIT: 'Split',
  UNSPLIT: 'Unsplit',
  CAPRETURN: 'Cap return',
  RIGHTS_ISSUE: 'Rights',
}

const MATCH_TYPE_LABEL: Record<string, string> = {
  'same-day': 'Same day',
  '30-day': '30 day',
  's104-pool': 'S104',
}

function txnTypeLabel(t: string): string {
  return TXN_TYPE_LABEL[t] ?? t
}

function matchTypesLabel(matchTypes: string[]): string {
  const unique = [...new Set(matchTypes)]
  if (unique.length === 0) return '—'
  return unique.map((m) => MATCH_TYPE_LABEL[m] ?? m).join(' + ')
}

/** Narrow, indented body text used for computation workings. */
function working(
  doc: InstanceType<typeof PDFDocument>,
  text: string,
  indent = 0,
  bold = false,
): void {
  if (doc.y > 760) doc.addPage()
  doc
    .font(bold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(9)
    .text(text, MARGIN + indent, doc.y, { width: 495 - indent })
}

export async function generateAnnualReportPdf(opts: {
  taxYear: string
  summary: CgtSummary
  holdings: HoldingRow[]
  disposals: CgtDisposalRecord[]
  computations: DisposalComputation[]
  poolSnapshotsByInstrument: Map<number, PoolSnapshot[]>
  instrumentsById: Map<number, Instrument>
  dividends: DividendRow[]
  generatedAt: string
}): Promise<Buffer> {
  const {
    taxYear,
    summary,
    holdings,
    disposals,
    computations,
    poolSnapshotsByInstrument,
    instrumentsById,
    dividends,
    generatedAt,
  } = opts

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN, size: 'A4' })
    const chunks: Buffer[] = []
    doc.on('data', (chunk) => chunks.push(chunk))
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
      ['Total proceeds', fmt(summary.totalProceeds)],
      ['Acquisition cost (incl. purchase fees)', fmt(summary.totalAllowableCost)],
      ['Incidental costs of sale', fmt(summary.totalSellingCosts)],
      // Matches the SA108 "Allowable costs (including purchase price)" box, so
      // the attached computation reconciles to what is typed into the return.
      ['Allowable costs (including purchase price)', fmt(summary.totalAllowableCostsForReturn)],
      ['Gross gain', fmt(summary.grossGain)],
      ['Gross loss', fmt(summary.grossLoss)],
      ['Net gain / (loss)', fmt(summary.netGain)],
      ['Annual exempt amount', fmt(summary.annualExempt)],
      ['Taxable gain', fmt(summary.taxableGain)],
      ['Estimated CGT liability', fmt(summary.estimatedTax)],
    ]
    for (const [label, value] of summaryItems) {
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(`${label}:`, MARGIN, doc.y, { continued: true, width: 220 })
      doc.font('Helvetica').text(value ?? '')
    }

    doc
      .font('Helvetica')
      .fontSize(8)
      .moveDown(1.5)
      .text(
        'Gross gain and gross loss are stated per match: each identification under TCGA 1992 s.105, ' +
          's.106A or s.104 is a separate computation, so a single sale producing a loss on one match ' +
          'and a gain on another contributes to both figures. Netting within each sale instead would ' +
          'give smaller gross figures and the same net gain. Section 2 shows both the match-level and ' +
          'per-disposal results for every disposal.',
        { width: 495 },
      )

    // ── Holdings ─────────────────────────────────────────────────────────────
    doc.addPage()
    sectionTitle(doc, '1. Current Holdings')

    const hWidths = [60, 70, 90, 90, 100]
    tableHeader(doc, hWidths, ['Ticker', 'Shares', 'Cost (£)', 'Value (£)', 'Unrealised G/L (£)'])
    tableRows(
      doc,
      hWidths,
      holdings.map((h) => [
        h.ticker,
        fmtNum(h.quantity),
        fmt(h.costGbp),
        fmt(h.valueGbp),
        fmt(h.unrealisedGainGbp),
      ]),
    )

    // ── Disposal computations ────────────────────────────────────────────────
    // HMRC requires a separate computation per disposal showing how the gain
    // was arrived at. This is that evidence; the table that follows is only a
    // recap of it.
    doc.addPage()
    sectionTitle(doc, '2. Disposal Computations')
    doc
      .font('Helvetica')
      .fontSize(8)
      .text(
        'A separate computation for each disposal of listed shares and securities. Share identification ' +
          'follows TCGA 1992 s.105 (same-day), s.106A (acquisitions within 30 days) and s.104 (pooled ' +
          'average cost), applied in that order. All amounts in GBP; monetary arithmetic carried at 8 ' +
          'decimal places and rounded for presentation only.',
        { width: 495 },
      )
    doc.moveDown(0.6)

    for (const [i, c] of computations.entries()) {
      if (doc.y > 640) doc.addPage()

      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(
          `Disposal ${i + 1} — ${c.ticker}` +
            (c.instrumentName && c.instrumentName !== c.ticker ? ` (${c.instrumentName})` : ''),
          MARGIN,
          doc.y,
        )
      doc.moveDown(0.2)

      working(doc, `Date of disposal: ${c.disposalDate}`)
      working(doc, `Shares disposed of: ${fmtNum(c.quantity)}`)

      if (c.unitPriceNative && c.nativeCurrency && c.nativeCurrency !== 'GBP') {
        working(
          doc,
          `Price: ${c.nativeCurrency} ${c.unitPriceNative} per share, converted at ${c.fxRate ?? '—'} ` +
            `(${c.fxRateType ?? 'unknown basis'}${c.fxRateSource ? `, ${c.fxRateSource}` : ''}) ` +
            `= ${fmt(c.unitPriceGbp, 6)} per share`,
        )
      } else {
        working(doc, `Price: ${fmt(c.unitPriceGbp, 6)} per share`)
      }

      working(
        doc,
        `Gross proceeds: ${fmtNum(c.quantity)} x ${fmt(c.unitPriceGbp, 6)} = ${fmt(c.grossProceedsGbp)}`,
      )
      if (new Big(c.sellingCostsGbp).gt(0)) {
        working(doc, `Incidental costs of disposal: ${fmt(c.sellingCostsGbp)}`)
      }
      doc.moveDown(0.3)

      for (const [j, s] of c.slices.entries()) {
        working(doc, `(${String.fromCharCode(97 + j)}) ${s.rule}`, 12, true)
        working(doc, `Matched against: ${s.source}`, 28)
        working(doc, `Shares matched: ${fmtNum(s.quantity)}`, 28)
        if (new Big(s.incidentalAcqCostGbp).gt(0)) {
          working(
            doc,
            `Purchase price: ${fmtNum(s.quantity)} x ${fmt(s.pricePerShareGbp, 6)} = ${fmt(s.priceCostGbp)}`,
            28,
          )
          working(
            doc,
            `Incidental acquisition costs apportioned: ${fmt(s.incidentalAcqCostGbp)}`,
            28,
          )
          working(doc, `Allowable cost: ${fmt(s.allowableCostGbp)}`, 28)
        } else {
          working(
            doc,
            `Allowable cost: ${fmtNum(s.quantity)} x ${fmt(s.costPerShareGbp, 6)} = ${fmt(s.allowableCostGbp)}`,
            28,
          )
        }
        working(doc, `Proceeds apportioned: ${fmt(s.proceedsGbp)}`, 28)
        if (new Big(s.sellingCostsGbp).gt(0)) {
          working(doc, `Incidental costs of disposal apportioned: ${fmt(s.sellingCostsGbp)}`, 28)
        }
        const sliceGain = new Big(s.gainGbp)
        working(
          doc,
          `${sliceGain.lt(0) ? 'Loss' : 'Gain'}: ${fmt(s.proceedsGbp)} - ${fmt(s.allowableCostGbp)}` +
            (new Big(s.sellingCostsGbp).gt(0) ? ` - ${fmt(s.sellingCostsGbp)}` : '') +
            ` = ${fmt(s.gainGbp)}`,
          28,
          true,
        )
        doc.moveDown(0.25)
      }

      working(
        doc,
        `Total allowable costs (including incidental costs of sale): ${fmt(c.totalAllowableCostsForReturnGbp)}`,
        12,
      )
      working(
        doc,
        `Net ${new Big(c.totalGainGbp).lt(0) ? 'loss' : 'gain'} on disposal ${i + 1}: ${fmt(c.totalGainGbp)}`,
        12,
        true,
      )
      doc.moveDown(0.8)
    }

    // ── Disposals ────────────────────────────────────────────────────────────
    doc.addPage()
    sectionTitle(doc, '3. Realised Disposals — match detail')

    const dWidths = [55, 60, 70, 60, 85, 85, 70]
    tableHeader(doc, dWidths, [
      'Date',
      'Ticker',
      'Match',
      'Shares',
      'Proceeds (£)',
      'Cost (£)',
      'Gain (£)',
    ])
    tableRows(
      doc,
      dWidths,
      disposals.map((d) => [
        d.disposalDate,
        instrumentsById.get(d.instrumentId)?.ticker ?? '',
        matchTypesLabel([d.matchType]),
        fmtNum(d.quantity),
        fmt(d.proceedsGbp),
        fmt(d.allowableCostGbp),
        fmt(d.gainGbp),
      ]),
    )

    // ── S104 pool history ────────────────────────────────────────────────────
    // Makes every pooled average cost used above traceable to the acquisitions
    // that produced it, which is the part a pool-matched disposal cannot
    // otherwise evidence.
    const poolInstruments = [...poolSnapshotsByInstrument.entries()].filter(
      ([, snapshots]) => snapshots.length > 0,
    )
    if (poolInstruments.length > 0) {
      doc.addPage()
      sectionTitle(doc, '4. Section 104 Pool History')
      doc
        .font('Helvetica')
        .fontSize(8)
        .text(
          'Running pool state after each event affecting it. Shown only for instruments disposed of ' +
            'in this tax year, and only from the point the pool was last fully disposed of before the ' +
            "year's first disposal — earlier history cannot affect these figures, because closing the " +
            'pool resets the pooled cost. Pool cost is inclusive of incidental acquisition costs. A ' +
            'disposal matched same-day or under the 30-day rule leaves the pool unchanged, since those ' +
            'shares are identified with a specific acquisition rather than the pool.',
          { width: 495 },
        )
      doc.moveDown(0.5)

      const pWidths = [60, 62, 72, 78, 85, 78]
      for (const [instrumentId, snapshots] of poolInstruments) {
        if (doc.y > 660) doc.addPage()
        const instrument = instrumentsById.get(instrumentId)
        const headingY = doc.y
        doc
          .font('Helvetica-Bold')
          .fontSize(10)
          .text(`${instrument?.ticker ?? instrumentId}`, MARGIN, headingY, { lineBreak: false })
        // Advance explicitly: the heading shares its x with the first column, so
        // relying on the implicit cursor risks the column header landing on the
        // same baseline and colliding with it.
        doc.y = headingY + 20
        tableHeader(doc, pWidths, [
          'Date',
          'Event',
          'Match',
          'Pool shares',
          'Pool cost (£)',
          'Avg cost (£)',
        ])
        tableRows(
          doc,
          pWidths,
          snapshots.map((s) => [
            s.date,
            txnTypeLabel(s.txnType),
            matchTypesLabel(s.matchTypes),
            fmtNum(s.quantity),
            fmt(s.costGbp),
            fmt(s.avgCostGbp, 4),
          ]),
        )
        doc.moveDown(0.6)
      }
    }

    // ── Dividends ────────────────────────────────────────────────────────────
    if (dividends.length > 0) {
      doc.addPage()
      sectionTitle(doc, '5. Dividend Income')

      const divWidths = [65, 60, 80, 90, 80, 70]
      tableHeader(doc, divWidths, [
        'Date',
        'Ticker',
        'Gross (£)',
        'Withholding (£)',
        'Net (£)',
        'FTCR (£)',
      ])
      tableRows(
        doc,
        divWidths,
        dividends.map((div) => [
          div.txnDate,
          div.ticker,
          fmt(div.grossGbp),
          fmt(div.withholdingGbp),
          fmt(div.netGbp),
          fmt(div.ftcrGbp),
        ]),
      )
    }

    // ── Liability breakdown ──────────────────────────────────────────────────
    doc.addPage()
    sectionTitle(
      doc,
      dividends.length > 0 ? '6. Estimated CGT Liability' : '5. Estimated CGT Liability',
    )

    const liabilityItems = [
      ['Taxable gain after AEA', fmt(summary.taxableGain)],
      ['Basic rate estimate', fmt(summary.taxAtBasicRate)],
      ['Higher rate estimate', fmt(summary.taxAtHigherRate)],
      ['Best estimate liability', fmt(summary.estimatedTax)],
      ['Must report to HMRC', summary.mustReport ? 'Yes' : 'No'],
    ]
    for (const [label, value] of liabilityItems) {
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(`${label}:`, MARGIN, doc.y, { continued: true, width: 220 })
      doc.font('Helvetica').text(value ?? '')
    }

    doc
      .font('Helvetica')
      .fontSize(8)
      .moveDown(2)
      .text(
        'This report is generated for informational purposes only and does not constitute tax advice. Verify all figures with a qualified tax adviser before filing.',
      )

    doc.end()
  })
}

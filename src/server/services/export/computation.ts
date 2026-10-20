/**
 * Per-disposal CGT computations.
 *
 * HMRC requires a separate computation for each disposal, showing how the gain
 * or loss was arrived at — not just the totals that go in the return boxes. A
 * disposal matched across several acquisitions under TCGA 1992 s.105/106A is
 * one HMRC "disposal" but several engine records, so records are grouped by
 * the disposing transaction and each match is shown as a working.
 *
 * `formatComputationsText` renders the same model as plain text, for the
 * "Any other information" box that HMRC accepts in place of an attachment.
 */

import Big from 'big.js'
import type { Instrument, Transaction } from '../../../shared/types.ts'
import type { CgtDisposalRecord, PoolSnapshot } from '../tax/matching.ts'

export interface ComputationSlice {
  matchType: CgtDisposalRecord['matchType']
  /** Human label for the rule applied, e.g. "Same-day rule (s.105)" */
  rule: string
  quantity: string
  /** Where the cost came from: an acquisition date or the pool */
  source: string
  /** Blended cost per share for this slice, inclusive of incidental costs */
  costPerShareGbp: string
  /**
   * Per-share price behind `priceCostGbp` alone. Distinct from
   * `costPerShareGbp` whenever the matched acquisition carried fees — showing
   * the blended rate against the price component would not multiply out.
   */
  pricePerShareGbp: string
  /** Purchase-price component of the allowable cost */
  priceCostGbp: string
  /** Incidental acquisition costs included in the allowable cost (pro-rata) */
  incidentalAcqCostGbp: string
  allowableCostGbp: string
  proceedsGbp: string
  sellingCostsGbp: string
  gainGbp: string
}

export interface DisposalComputation {
  txnId: number
  ticker: string
  instrumentName: string
  disposalDate: string
  quantity: string
  unitPriceGbp: string
  /** Native-currency price and FX provenance, when not already GBP */
  unitPriceNative: string | null
  nativeCurrency: string | null
  fxRate: string | null
  fxRateType: string | null
  fxRateSource: string | null
  grossProceedsGbp: string
  sellingCostsGbp: string
  slices: ComputationSlice[]
  totalAllowableCostGbp: string
  /** Allowable costs including incidental costs of sale — the SA108 basis */
  totalAllowableCostsForReturnGbp: string
  totalGainGbp: string
}

const RULE_LABEL: Record<CgtDisposalRecord['matchType'], string> = {
  'same-day': 'Same-day rule (TCGA 1992 s.105)',
  '30-day': 'Bed & breakfast rule, 30 days (TCGA 1992 s.106A)',
  's104-pool': 'Section 104 holding (pooled average cost)',
}

function div(a: Big, b: Big): Big {
  return b.eq(0) ? new Big(0) : a.div(b)
}

/**
 * Build one computation per disposing transaction.
 *
 * @param poolSnapshotsByInstrument Pool state after each transaction, used to
 *   recover the pool size a s104 match was taken from. The snapshot records
 *   state *after* the disposal, so the pre-disposal pool is reconstructed by
 *   adding the matched quantity and its allowable cost back on.
 */
export function buildDisposalComputations(
  disposals: CgtDisposalRecord[],
  transactionsById: Map<number, Transaction>,
  instrumentsById: Map<number, Instrument>,
  poolSnapshotsByInstrument: Map<number, PoolSnapshot[]>,
): DisposalComputation[] {
  const byTxn = new Map<number, CgtDisposalRecord[]>()
  for (const d of disposals) {
    const list = byTxn.get(d.txnId) ?? []
    list.push(d)
    byTxn.set(d.txnId, list)
  }

  const computations: DisposalComputation[] = []

  for (const [txnId, records] of byTxn) {
    const first = records[0]!
    const saleTxn = transactionsById.get(txnId)
    const instrument = instrumentsById.get(first.instrumentId)

    const slices: ComputationSlice[] = []
    let totalQty = new Big(0)
    let totalProceeds = new Big(0)
    let totalAllowable = new Big(0)
    let totalSellingCosts = new Big(0)
    let totalGain = new Big(0)

    for (const r of records) {
      const qty = new Big(r.quantity)
      const allowable = new Big(r.allowableCostGbp)

      let source: string
      let priceCost = allowable
      let incidental = new Big(0)
      let pricePerShare = div(allowable, qty)

      if (r.matchType === 's104-pool') {
        const pool = poolBeforeDisposal(poolSnapshotsByInstrument, r)
        source = pool
          ? `Section 104 pool of ${trim(pool.quantity)} shares, cost ${money(pool.costGbp)}`
          : 'Section 104 pool'
      } else {
        const acq = r.acquisitionTxnId ? transactionsById.get(r.acquisitionTxnId) : undefined
        if (acq) {
          // Split the allowable cost back into price and the pro-rata fee share
          // so the working shows both components rather than a single number.
          pricePerShare = new Big(acq.unitPriceGbp ?? '0')
          priceCost = pricePerShare.times(qty)
          incidental = allowable.minus(priceCost)
          source =
            `${acq.txnType} ${acq.txnDate} — ${trim(acq.quantity)} shares @ ${money(acq.unitPriceGbp, 6)}` +
            (new Big(acq.costsGbp ?? '0').gt(0) ? `, fees ${money(acq.costsGbp)}` : '')
        } else {
          source = 'matched acquisition'
        }
      }

      slices.push({
        matchType: r.matchType,
        rule: RULE_LABEL[r.matchType],
        quantity: r.quantity,
        source,
        costPerShareGbp: div(allowable, qty).toFixed(8),
        pricePerShareGbp: pricePerShare.toFixed(8),
        priceCostGbp: priceCost.toFixed(8),
        incidentalAcqCostGbp: incidental.toFixed(8),
        allowableCostGbp: r.allowableCostGbp,
        proceedsGbp: r.proceedsGbp,
        sellingCostsGbp: r.sellingCostsGbp,
        gainGbp: r.gainGbp,
      })

      totalQty = totalQty.plus(qty)
      totalProceeds = totalProceeds.plus(r.proceedsGbp)
      totalAllowable = totalAllowable.plus(allowable)
      totalSellingCosts = totalSellingCosts.plus(r.sellingCostsGbp)
      totalGain = totalGain.plus(r.gainGbp)
    }

    computations.push({
      txnId,
      ticker: instrument?.ticker ?? '',
      instrumentName: instrument?.name ?? '',
      disposalDate: first.disposalDate,
      quantity: totalQty.toFixed(8),
      unitPriceGbp: div(totalProceeds, totalQty).toFixed(8),
      unitPriceNative: saleTxn?.unitPriceNative ?? null,
      nativeCurrency: saleTxn?.nativeCurrency ?? null,
      fxRate: saleTxn?.fxRate ?? null,
      fxRateType: saleTxn?.fxRateType ?? null,
      fxRateSource: saleTxn?.fxRateSource ?? null,
      grossProceedsGbp: totalProceeds.toFixed(8),
      sellingCostsGbp: totalSellingCosts.toFixed(8),
      slices,
      totalAllowableCostGbp: totalAllowable.toFixed(8),
      totalAllowableCostsForReturnGbp: totalAllowable.plus(totalSellingCosts).toFixed(8),
      totalGainGbp: totalGain.toFixed(8),
    })
  }

  computations.sort((a, b) =>
    a.disposalDate === b.disposalDate
      ? a.txnId - b.txnId
      : a.disposalDate < b.disposalDate
        ? -1
        : 1,
  )
  return computations
}

function poolBeforeDisposal(
  poolSnapshotsByInstrument: Map<number, PoolSnapshot[]>,
  record: CgtDisposalRecord,
): { quantity: string; costGbp: string } | null {
  const snapshot = poolSnapshotsByInstrument
    .get(record.instrumentId)
    ?.find((s) => s.txnId === record.txnId)
  if (!snapshot) return null
  return {
    quantity: new Big(snapshot.quantity).plus(record.quantity).toFixed(8),
    costGbp: new Big(snapshot.costGbp).plus(record.allowableCostGbp).toFixed(8),
  }
}

// ── Text rendering ────────────────────────────────────────────────────────────

function money(v: string | null | undefined, dp = 2): string {
  if (v == null) return '—'
  const n = new Big(v)
  // Group the integer part only — applying the separator to the whole string
  // puts commas inside the decimals (£50.104,384).
  const [int, frac] = n.abs().toFixed(dp).split('.')
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const abs = frac ? `${grouped}.${frac}` : grouped
  return n.lt(0) ? `(£${abs})` : `£${abs}`
}

function trim(v: string | null | undefined): string {
  if (v == null) return '—'
  return new Big(v).toFixed(8).replace(/\.?0+$/, '')
}

/**
 * Plain-text computations, suitable for pasting into the HMRC "Any other
 * information" box when an attachment is not used.
 */
export function formatComputationsText(
  computations: DisposalComputation[],
  taxYear: string,
): string {
  const lines: string[] = [
    `CAPITAL GAINS COMPUTATIONS — TAX YEAR ${taxYear}`,
    'Listed shares and securities. All figures in GBP.',
    'Share identification per TCGA 1992 s.104, s.105 and s.106A:',
    'same-day acquisitions, then acquisitions within 30 days, then the Section 104 pool.',
    '',
  ]

  computations.forEach((c, i) => {
    const name = c.instrumentName && c.instrumentName !== c.ticker ? ` (${c.instrumentName})` : ''
    lines.push(`DISPOSAL ${i + 1} — ${c.ticker}${name}`)
    lines.push(`Date of disposal: ${c.disposalDate}`)
    lines.push(`Shares disposed of: ${trim(c.quantity)}`)

    if (c.unitPriceNative && c.nativeCurrency && c.nativeCurrency !== 'GBP') {
      lines.push(
        `Price: ${c.nativeCurrency} ${c.unitPriceNative} per share, converted at ` +
          `${c.fxRate ?? '—'} (${c.fxRateType ?? 'unknown basis'}` +
          `${c.fxRateSource ? `, ${c.fxRateSource}` : ''}) = ${money(c.unitPriceGbp, 6)} per share`,
      )
    } else {
      lines.push(`Price: ${money(c.unitPriceGbp, 6)} per share`)
    }

    lines.push(
      `Gross proceeds: ${trim(c.quantity)} x ${money(c.unitPriceGbp, 6)} = ${money(c.grossProceedsGbp)}`,
    )
    if (new Big(c.sellingCostsGbp).gt(0)) {
      lines.push(`Incidental costs of disposal: ${money(c.sellingCostsGbp)}`)
    }
    lines.push('')

    c.slices.forEach((s, j) => {
      lines.push(`  (${String.fromCharCode(97 + j)}) ${s.rule}`)
      lines.push(`      Matched against: ${s.source}`)
      lines.push(`      Shares matched: ${trim(s.quantity)}`)
      if (new Big(s.incidentalAcqCostGbp).gt(0)) {
        lines.push(
          `      Purchase price: ${trim(s.quantity)} x ${money(s.pricePerShareGbp, 6)} = ${money(s.priceCostGbp)}`,
        )
        lines.push(
          `      Incidental acquisition costs apportioned: ${money(s.incidentalAcqCostGbp)}`,
        )
        lines.push(`      Allowable cost: ${money(s.allowableCostGbp)}`)
      } else {
        lines.push(
          `      Allowable cost: ${trim(s.quantity)} x ${money(s.costPerShareGbp, 6)} = ${money(s.allowableCostGbp)}`,
        )
      }
      lines.push(`      Proceeds apportioned: ${money(s.proceedsGbp)}`)
      if (new Big(s.sellingCostsGbp).gt(0)) {
        lines.push(`      Incidental costs of disposal apportioned: ${money(s.sellingCostsGbp)}`)
      }
      const gain = new Big(s.gainGbp)
      lines.push(
        `      ${gain.lt(0) ? 'Loss' : 'Gain'}: ${money(s.proceedsGbp)} - ${money(s.allowableCostGbp)}` +
          (new Big(s.sellingCostsGbp).gt(0) ? ` - ${money(s.sellingCostsGbp)}` : '') +
          ` = ${money(s.gainGbp)}`,
      )
      lines.push('')
    })

    const gain = new Big(c.totalGainGbp)
    lines.push(
      `  Total allowable costs (incl. costs of sale): ${money(c.totalAllowableCostsForReturnGbp)}`,
    )
    lines.push(
      `  NET ${gain.lt(0) ? 'LOSS' : 'GAIN'} ON DISPOSAL ${i + 1}: ${money(c.totalGainGbp)}`,
    )
    lines.push('')
  })

  // Totals so the computation reconciles to the figures entered in the return.
  //
  // Gains and losses are stated on two bases because the net is identical but
  // the gross split is not, and the return boxes can only hold one of them.
  // Per-match: each identification under s.105/s.106A/s.104 is a separate
  // computation, so a sale with a loss on one match and a gain on another
  // contributes to both totals. Per-disposal: those are netted within the sale
  // first. The engine and the return boxes use the per-match basis; the
  // alternative is shown so an inspector reconciling either way can see both.
  const proceeds = computations.reduce((a, c) => a.plus(c.grossProceedsGbp), new Big(0))
  const costs = computations.reduce((a, c) => a.plus(c.totalAllowableCostsForReturnGbp), new Big(0))

  const perDisposal = splitGainsLosses(computations.map((c) => c.totalGainGbp))
  const perMatch = splitGainsLosses(computations.flatMap((c) => c.slices.map((s) => s.gainGbp)))

  lines.push('SUMMARY')
  lines.push(`Number of disposals: ${computations.length}`)
  lines.push(`Disposal proceeds: ${money(proceeds.toFixed(8))}`)
  lines.push(`Allowable costs (including purchase price): ${money(costs.toFixed(8))}`)
  lines.push('')
  lines.push('Per-match basis (as entered in the return):')
  lines.push(`  Gains before losses: ${money(perMatch.gains.toFixed(8))}`)
  lines.push(`  Losses in the year: ${money(perMatch.losses.toFixed(8))}`)
  lines.push('')
  lines.push('Per-disposal basis (gains and losses netted within each sale):')
  lines.push(`  Gains before losses: ${money(perDisposal.gains.toFixed(8))}`)
  lines.push(`  Losses in the year: ${money(perDisposal.losses.toFixed(8))}`)
  lines.push('')
  lines.push(
    `Net chargeable gain before annual exempt amount (identical on either basis): ${money(
      perMatch.gains.minus(perMatch.losses).toFixed(8),
    )}`,
  )

  return lines.join('\n')
}

function splitGainsLosses(amounts: string[]): { gains: Big; losses: Big } {
  let gains = new Big(0)
  let losses = new Big(0)
  for (const a of amounts) {
    const v = new Big(a)
    if (v.gt(0)) gains = gains.plus(v)
    else if (v.lt(0)) losses = losses.plus(v.abs())
  }
  return { gains, losses }
}

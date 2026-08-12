/**
 * UK CGT share matching: Section 104, same-day, and 30-day (bed & breakfast) rules.
 *
 * HMRC matching order (per TCGA 1992 s106A):
 *   1. Same-day acquisitions (matched against same-day disposals first)
 *   2. Acquisitions within 30 days AFTER the disposal (bed & breakfast rule)
 *   3. Section 104 pool (average cost basis)
 *
 * The engine processes ALL transactions for a single instrument in chronological
 * order and returns the list of disposal records produced plus the final pool state.
 *
 * Inputs must have unitPriceGbp populated (i.e. after backfill-fx has run).
 */
import Big from 'big.js'
import { BadRequestError } from '../../errors.ts'

function bigMin(a: Big, b: Big): Big {
  return a.lt(b) ? a : b
}

import type { MatchType, Transaction } from '../../../shared/types.ts'
import {
  addToPool,
  applyCapReturn,
  applyRightsIssue,
  applyStockSplit,
  disposeFromPool,
  emptyPool,
  type S104PoolState,
} from './pool.ts'

export interface CgtDisposalRecord {
  txnId: number
  instrumentId: number
  disposalDate: string
  taxYear: string
  matchType: MatchType
  acquisitionTxnId: number | null
  quantity: string
  proceedsGbp: string
  allowableCostGbp: string
  sellingCostsGbp: string
  gainGbp: string
}

/** Identifies which UK tax year a date falls in, e.g. "2025-26". */
export function taxYearForDate(date: string): string {
  const parts = date.split('-').map(Number)
  const y = parts[0]!,
    m = parts[1]!,
    d = parts[2]!
  // UK tax year runs 6 Apr to 5 Apr
  const inNewYear = m > 4 || (m === 4 && d >= 6)
  const startYear = inNewYear ? y : y - 1
  return `${startYear}-${String(startYear + 1).slice(-2)}`
}

/**
 * Run CGT share matching for all transactions of a single instrument.
 * Returns disposal records and the final S104 pool state.
 */
export function matchDisposals(
  transactions: Transaction[],
  initialPool: S104PoolState = emptyPool(),
): { disposals: CgtDisposalRecord[]; pool: S104PoolState } {
  // Work only with transactions that affect the S104 pool or generate disposals.
  // Sort by date ascending, then by id (stable order within same date).
  const sorted = [...transactions].sort((a, b) => {
    if (a.txnDate < b.txnDate) return -1
    if (a.txnDate > b.txnDate) return 1
    return a.id - b.id
  })

  const disposals: CgtDisposalRecord[] = []
  let pool = { ...initialPool }

  // Collect acquisitions for 30-day B&B matching (keyed by date)
  // We need look-ahead: when we hit a SELL, scan forward 30 days.
  // To avoid O(n²) repeated scans we build an index of acquisitions by date.
  const acquisitionsByDate = new Map<string, Transaction[]>()
  for (const t of sorted) {
    if (isAcquisition(t)) {
      const list = acquisitionsByDate.get(t.txnDate) ?? []
      list.push(t)
      acquisitionsByDate.set(t.txnDate, list)
    }
  }

  // Track how much of each acquisition has already been matched (consumed),
  // keyed by txn.id.  Values are remaining quantity as Big strings.
  const remaining = new Map<number, Big>()
  for (const t of sorted) {
    if (isAcquisition(t)) {
      remaining.set(t.id, new Big(t.quantity))
    }
  }

  for (const txn of sorted) {
    if (txn.txnType === 'SELL' || txn.txnType === 'TRANSFER_OUT') {
      let toMatch = new Big(txn.quantity)
      const proceedsPerShare = new Big(txn.unitPriceGbp ?? '0')
      const totalProceeds = proceedsPerShare.times(toMatch)
      const sellingCosts = new Big(txn.costsGbp ?? '0')

      // ── 1. Same-day matching ─────────────────────────────────────────────────
      {
        const sameDayAcqs = acquisitionsByDate.get(txn.txnDate) ?? []
        for (const acq of sameDayAcqs) {
          if (toMatch.lte(0)) break
          const avail = remaining.get(acq.id) ?? new Big(0)
          if (avail.lte(0)) continue

          const matched = bigMin(toMatch, avail)
          const costPerShare = new Big(acq.unitPriceGbp ?? '0')
          const allowableCost = costPerShare.times(matched)
          const proceeds = proceedsPerShare.times(matched)
          // Selling costs are attributed pro-rata across all match slices
          const proRataCosts = totalProceeds.gt(0)
            ? sellingCosts.times(proceeds).div(totalProceeds)
            : new Big(0)
          const gain = proceeds.minus(allowableCost).minus(proRataCosts)

          disposals.push({
            txnId: txn.id,
            instrumentId: txn.instrumentId,
            disposalDate: txn.txnDate,
            taxYear: taxYearForDate(txn.txnDate),
            matchType: 'same-day',
            acquisitionTxnId: acq.id,
            quantity: matched.toFixed(8),
            proceedsGbp: proceeds.toFixed(8),
            allowableCostGbp: allowableCost.toFixed(8),
            sellingCostsGbp: proRataCosts.toFixed(8),
            gainGbp: gain.toFixed(8),
          })

          remaining.set(acq.id, avail.minus(matched))
          // Same-day acquisitions that are matched do NOT enter the S104 pool;
          // we need to remember this so pool additions below are reduced.
          toMatch = toMatch.minus(matched)
        }
      }

      // ── 2. 30-day (bed & breakfast) matching ────────────────────────────────
      if (toMatch.gt(0)) {
        const dispDate = txn.txnDate
        const d30 = addDays(dispDate, 30)

        // Gather acquisitions in the window (disposal date + 1 day to + 30 days),
        // in chronological order.
        const bbCandidates: Transaction[] = []
        for (const [date, acqs] of acquisitionsByDate) {
          if (date > dispDate && date <= d30) {
            bbCandidates.push(...acqs)
          }
        }
        bbCandidates.sort((a, b) => {
          if (a.txnDate < b.txnDate) return -1
          if (a.txnDate > b.txnDate) return 1
          return a.id - b.id
        })

        for (const acq of bbCandidates) {
          if (toMatch.lte(0)) break
          const avail = remaining.get(acq.id) ?? new Big(0)
          if (avail.lte(0)) continue

          const matched = bigMin(toMatch, avail)
          const costPerShare = new Big(acq.unitPriceGbp ?? '0')
          const allowableCost = costPerShare.times(matched)
          const proceeds = proceedsPerShare.times(matched)
          const proRataCosts = totalProceeds.gt(0)
            ? sellingCosts.times(proceeds).div(totalProceeds)
            : new Big(0)
          const gain = proceeds.minus(allowableCost).minus(proRataCosts)

          disposals.push({
            txnId: txn.id,
            instrumentId: txn.instrumentId,
            disposalDate: txn.txnDate,
            taxYear: taxYearForDate(txn.txnDate),
            matchType: '30-day',
            acquisitionTxnId: acq.id,
            quantity: matched.toFixed(8),
            proceedsGbp: proceeds.toFixed(8),
            allowableCostGbp: allowableCost.toFixed(8),
            sellingCostsGbp: proRataCosts.toFixed(8),
            gainGbp: gain.toFixed(8),
          })

          remaining.set(acq.id, avail.minus(matched))
          toMatch = toMatch.minus(matched)
        }
      }

      // ── 3. S104 pool ────────────────────────────────────────────────────────
      if (toMatch.gt(0)) {
        const poolQty = new Big(pool.quantity)
        if (poolQty.lt(toMatch)) {
          throw new BadRequestError(
            `Disposal of ${txn.quantity} on ${txn.txnDate} (txn #${txn.id}) exceeds S104 pool (${pool.quantity})`,
          )
        }

        const proceeds = proceedsPerShare.times(toMatch)
        const proRataCosts = totalProceeds.gt(0)
          ? sellingCosts.times(proceeds).div(totalProceeds)
          : new Big(0)

        const { allowableCost, pool: newPool } = disposeFromPool(pool, toMatch.toFixed(8))
        pool = newPool

        const gain = proceeds.minus(new Big(allowableCost)).minus(proRataCosts)

        disposals.push({
          txnId: txn.id,
          instrumentId: txn.instrumentId,
          disposalDate: txn.txnDate,
          taxYear: taxYearForDate(txn.txnDate),
          matchType: 's104-pool',
          acquisitionTxnId: null,
          quantity: toMatch.toFixed(8),
          proceedsGbp: proceeds.toFixed(8),
          allowableCostGbp: allowableCost,
          sellingCostsGbp: proRataCosts.toFixed(8),
          gainGbp: gain.toFixed(8),
        })

        toMatch = new Big(0)
      }
    } else if (isAcquisition(txn)) {
      // Add to S104 pool — but only the shares that were NOT already consumed
      // by same-day matching above.
      const consumed = new Big(txn.quantity).minus(remaining.get(txn.id) ?? new Big(txn.quantity))
      const netAddition = new Big(txn.quantity).minus(consumed)
      if (netAddition.gt(0) && txn.unitPriceGbp) {
        const costGbp = new Big(txn.unitPriceGbp).times(netAddition)
        pool = addToPool(pool, netAddition.toFixed(8), costGbp.toFixed(8))
      }
    } else if (txn.txnType === 'SPLIT' && txn.splitRatio) {
      pool = applyStockSplit(pool, txn.splitRatio)
    } else if (txn.txnType === 'UNSPLIT' && txn.splitRatio) {
      // Reverse split: the ratio stored is "new/old" from the original split,
      // so an unsplit flips it.
      const [num, den] = txn.splitRatio.split('/')
      pool = applyStockSplit(pool, `${den}/${num}`)
    } else if (txn.txnType === 'CAPRETURN' && txn.capreturnsPerShareGbp) {
      pool = applyCapReturn(pool, txn.capreturnsPerShareGbp)
    } else if (txn.txnType === 'RIGHTS_ISSUE' && txn.unitPriceGbp) {
      pool = applyRightsIssue(
        pool,
        txn.quantity,
        new Big(txn.unitPriceGbp).times(txn.quantity).toFixed(8),
      )
    }
  }

  return { disposals, pool }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isAcquisition(t: Transaction): boolean {
  // DRIP (dividend reinvestment) shares enter the pool like any other purchase.
  return ['BUY', 'RSU_VEST', 'ESPP_PURCHASE', 'TRANSFER_IN', 'DRIP'].includes(t.txnType)
}

/** Add N calendar days to an ISO date string "YYYY-MM-DD". */
function addDays(dateStr: string, days: number): string {
  const parts = dateStr.split('-').map(Number)
  const y = parts[0]!,
    m = parts[1]!,
    d = parts[2]!
  // Use UTC to avoid DST shifts
  const ms = Date.UTC(y, m - 1, d) + days * 86_400_000
  const dt = new Date(ms)
  return dt.toISOString().slice(0, 10)
}

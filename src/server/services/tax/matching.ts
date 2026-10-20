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
  poolAvgCost,
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

/**
 * Pool state after a single transaction, in processing order. Emitted for every
 * transaction the matcher considers so the running cost basis can be displayed
 * and reconciled against the persisted pool.
 *
 * `matchTypes` is populated for disposals only. A disposal fully matched
 * same-day or under the 30-day rule leaves the pool untouched, so without the
 * match types a zero-delta row is indistinguishable from a missed deduction.
 */
export interface PoolSnapshot {
  txnId: number
  date: string
  txnType: string
  quantity: string
  costGbp: string
  avgCostGbp: string
  matchTypes: MatchType[]
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
): { disposals: CgtDisposalRecord[]; pool: S104PoolState; history: PoolSnapshot[] } {
  // Work only with transactions that affect the S104 pool or generate disposals.
  // Sort by date ascending, then disposals before everything else, then by id.
  //
  // The disposals-first tie-break is load-bearing, not cosmetic: the pool
  // addition below reduces an acquisition by however much same-day matching
  // already consumed, and that bookkeeping (the `remaining` map) is only
  // written when the disposal is processed. Ordering a same-day acquisition
  // first put its full quantity into the pool and the same-day-matched shares
  // were then never removed, permanently inflating pool quantity and cost.
  // It is also the correct reading of s.105: a same-day acquisition is matched
  // against that day's disposal and never belongs to the pool for it.
  const sorted = [...transactions].sort((a, b) => {
    if (a.txnDate < b.txnDate) return -1
    if (a.txnDate > b.txnDate) return 1
    const rank = disposalRank(a) - disposalRank(b)
    if (rank !== 0) return rank
    return a.id - b.id
  })

  const disposals: CgtDisposalRecord[] = []
  const history: PoolSnapshot[] = []
  let pool = { ...initialPool }

  const snapshot = (txn: Transaction, matchTypes: MatchType[] = []): void => {
    history.push({
      txnId: txn.id,
      date: txn.txnDate,
      txnType: txn.txnType,
      quantity: pool.quantity,
      costGbp: pool.costGbp,
      avgCostGbp: poolAvgCost(pool),
      matchTypes,
    })
  }

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
      const matchTypes: MatchType[] = []
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
          const allowableCost = matchedAcquisitionCost(acq, matched)
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
          // the `remaining` decrement above is what the pool addition reads to
          // reduce itself, which is why disposals must sort before acquisitions.
          matchTypes.push('same-day')
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
          const allowableCost = matchedAcquisitionCost(acq, matched)
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
          matchTypes.push('30-day')
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

        matchTypes.push('s104-pool')
        toMatch = new Big(0)
      }

      snapshot(txn, matchTypes)
    } else if (isAcquisition(txn)) {
      // Add to S104 pool — but only the shares that were NOT already consumed
      // by same-day matching above.
      const consumed = new Big(txn.quantity).minus(remaining.get(txn.id) ?? new Big(txn.quantity))
      const netAddition = new Big(txn.quantity).minus(consumed)
      if (netAddition.gt(0) && txn.unitPriceGbp) {
        // Pro-rata so that a part-consumed same-day acquisition carries only
        // the share of its fees belonging to the shares entering the pool;
        // the rest went out with the same-day match.
        const costGbp = matchedAcquisitionCost(txn, netAddition)
        pool = addToPool(pool, netAddition.toFixed(8), costGbp.toFixed(8))
      }
      snapshot(txn)
    } else if (txn.txnType === 'SPLIT' && txn.splitRatio) {
      pool = applyStockSplit(pool, txn.splitRatio)
      snapshot(txn)
    } else if (txn.txnType === 'UNSPLIT' && txn.splitRatio) {
      // Reverse split: the ratio stored is "new/old" from the original split,
      // so an unsplit flips it.
      const [num, den] = txn.splitRatio.split('/')
      pool = applyStockSplit(pool, `${den}/${num}`)
      snapshot(txn)
    } else if (txn.txnType === 'CAPRETURN' && txn.capreturnsPerShareGbp) {
      pool = applyCapReturn(pool, txn.capreturnsPerShareGbp)
      snapshot(txn)
    } else if (txn.txnType === 'RIGHTS_ISSUE' && txn.unitPriceGbp) {
      pool = applyRightsIssue(
        pool,
        txn.quantity,
        new Big(txn.unitPriceGbp).times(txn.quantity).toFixed(8),
      )
      snapshot(txn)
    }
  }

  return { disposals, pool, history }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Allowable cost of `matched` shares taken from one specific acquisition:
 * purchase price plus that slice's pro-rata share of the acquisition's
 * incidental costs. Brokerage and fees on acquisition are allowable under
 * TCGA 1992 s.38(1)(a), so they belong in the cost of the shares and not
 * only in the gain. Pool-matched disposals pick the same costs up through
 * the pool cost instead, which is why this is only used for same-day and
 * 30-day matches.
 */
function matchedAcquisitionCost(acq: Transaction, matched: Big): Big {
  const price = new Big(acq.unitPriceGbp ?? '0').times(matched)
  const acqQty = new Big(acq.quantity)
  if (acqQty.lte(0)) return price
  return price.plus(new Big(acq.costsGbp ?? '0').times(matched).div(acqQty))
}

/** Sort key for same-date ties: disposals (rank 0) run before everything else. */
function disposalRank(t: Transaction): number {
  return t.txnType === 'SELL' || t.txnType === 'TRANSFER_OUT' ? 0 : 1
}

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

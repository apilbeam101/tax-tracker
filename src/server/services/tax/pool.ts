import Big from 'big.js'
import { BadRequestError } from '../../errors.ts'

export interface S104PoolState {
  quantity: string // exact decimal
  costGbp: string // total allowable cost in the pool, exact decimal
}

export function emptyPool(): S104PoolState {
  return { quantity: '0', costGbp: '0' }
}

/**
 * Average cost per share of the pool; '0' when pool is empty.
 */
export function poolAvgCost(pool: S104PoolState): string {
  const qty = new Big(pool.quantity)
  if (qty.eq(0)) return '0'
  return new Big(pool.costGbp).div(qty).toFixed(8)
}

/**
 * Add an acquisition to the pool.
 * costGbp = total cost of the acquired shares (not per-share).
 */
export function addToPool(pool: S104PoolState, quantity: string, costGbp: string): S104PoolState {
  return {
    quantity: new Big(pool.quantity).plus(quantity).toFixed(8),
    costGbp: new Big(pool.costGbp).plus(costGbp).toFixed(8),
  }
}

/**
 * Remove shares from the pool, returning the allowable cost for the disposal
 * and the updated pool.  Uses the pool average cost.
 * Throws if disposing more than the pool holds.
 */
export function disposeFromPool(
  pool: S104PoolState,
  quantity: string,
): { allowableCost: string; pool: S104PoolState } {
  const poolQty = new Big(pool.quantity)
  const dispQty = new Big(quantity)

  if (dispQty.gt(poolQty)) {
    throw new BadRequestError(`Cannot dispose ${quantity} shares; pool only holds ${pool.quantity}`)
  }

  if (dispQty.eq(0)) {
    return { allowableCost: '0', pool }
  }

  const avgCost = new Big(pool.costGbp).div(poolQty)
  const allowableCost = avgCost.times(dispQty).toFixed(8)

  const newQty = poolQty.minus(dispQty)
  const newCost = newQty.eq(0) ? '0' : new Big(pool.costGbp).minus(allowableCost).toFixed(8)

  return {
    allowableCost,
    pool: { quantity: newQty.toFixed(8), costGbp: newCost },
  }
}

/**
 * Apply a stock split to the pool quantity without changing total cost.
 * splitRatio is "new/old", e.g. "2/1" for a 2-for-1 split.
 */
export function applyStockSplit(pool: S104PoolState, splitRatio: string): S104PoolState {
  const [num, den] = splitRatio.split('/').map((s) => s.trim())
  if (!num || !den) throw new BadRequestError(`Invalid splitRatio: ${splitRatio}`)
  const newQty = new Big(pool.quantity).times(num).div(den).toFixed(8)
  return { quantity: newQty, costGbp: pool.costGbp }
}

/**
 * Apply a capital return (return of capital per share).
 * Reduces the pool cost basis by the aggregate amount returned.
 * If the reduction would push cost below zero, cost is clamped to '0'.
 */
export function applyCapReturn(pool: S104PoolState, amountPerShareGbp: string): S104PoolState {
  const reduction = new Big(pool.quantity).times(amountPerShareGbp)
  const reduced = new Big(pool.costGbp).minus(reduction)
  const newCost = (reduced.lt(0) ? new Big(0) : reduced).toFixed(8)
  return { quantity: pool.quantity, costGbp: newCost }
}

/**
 * Apply a rights issue: add shares acquired at rights price to the pool.
 * Equivalent to addToPool but named for clarity in callers.
 */
export function applyRightsIssue(
  pool: S104PoolState,
  quantity: string,
  costGbp: string,
): S104PoolState {
  return addToPool(pool, quantity, costGbp)
}

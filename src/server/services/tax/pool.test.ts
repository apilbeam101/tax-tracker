import { describe, it, expect } from 'vitest'
import Big from 'big.js'
import {
  emptyPool,
  poolAvgCost,
  addToPool,
  disposeFromPool,
  applyStockSplit,
  applyCapReturn,
} from './pool.ts'

describe('S104 pool — addToPool', () => {
  it('adds shares and cost to an empty pool', () => {
    const pool = addToPool(emptyPool(), '100', '1500.00')
    expect(pool.quantity).toBe(new Big('100').toFixed(8))
    expect(pool.costGbp).toBe(new Big('1500.00').toFixed(8))
  })

  it('accumulates multiple acquisitions, keeping exact decimal', () => {
    let pool = emptyPool()
    pool = addToPool(pool, '100', '1500.00')  // avg £15.00
    pool = addToPool(pool, '50', '900.00')   // avg £18.00 → new avg = (1500+900)/150 = £16.00
    pool = addToPool(pool, '50', '600.00')   // avg £12.00 → total cost = 3000, qty = 200
    expect(pool.quantity).toBe(new Big('200').toFixed(8))
    expect(pool.costGbp).toBe(new Big('3000').toFixed(8))
    expect(poolAvgCost(pool)).toBe(new Big('15').toFixed(8))
  })
})

describe('S104 pool — disposeFromPool', () => {
  it('computes allowable cost using average cost', () => {
    let pool = emptyPool()
    pool = addToPool(pool, '100', '1500.00')
    pool = addToPool(pool, '100', '2500.00')
    // total qty=200, total cost=4000, avg=£20
    const { allowableCost, pool: after } = disposeFromPool(pool, '50')
    expect(new Big(allowableCost).toFixed(2)).toBe('1000.00')  // 50 × £20
    expect(new Big(after.quantity).toFixed(0)).toBe('150')
    expect(new Big(after.costGbp).toFixed(2)).toBe('3000.00')
  })

  it('zeroes the pool on full disposal', () => {
    let pool = addToPool(emptyPool(), '100', '1500.00')
    const { allowableCost, pool: after } = disposeFromPool(pool, '100')
    expect(new Big(allowableCost).toFixed(2)).toBe('1500.00')
    expect(after.quantity).toBe(new Big('0').toFixed(8))
    expect(after.costGbp).toBe('0')
  })

  it('throws when disposing more than pool holds', () => {
    const pool = addToPool(emptyPool(), '10', '100')
    expect(() => disposeFromPool(pool, '11')).toThrow('Cannot dispose')
  })
})

describe('S104 pool — applyStockSplit', () => {
  it('doubles quantity on 2-for-1 split without changing cost', () => {
    const pool = addToPool(emptyPool(), '100', '1500.00')
    const after = applyStockSplit(pool, '2/1')
    expect(new Big(after.quantity).toFixed(0)).toBe('200')
    expect(after.costGbp).toBe(pool.costGbp)
  })

  it('handles reverse split (1-for-4)', () => {
    const pool = addToPool(emptyPool(), '400', '4000.00')
    const after = applyStockSplit(pool, '1/4')
    expect(new Big(after.quantity).toFixed(0)).toBe('100')
    expect(after.costGbp).toBe(pool.costGbp)
  })
})

describe('S104 pool — applyCapReturn', () => {
  it('reduces pool cost by quantity × return per share', () => {
    const pool = addToPool(emptyPool(), '100', '2000.00')
    const after = applyCapReturn(pool, '5.00')  // £500 returned
    expect(new Big(after.costGbp).toFixed(2)).toBe('1500.00')
    expect(after.quantity).toBe(pool.quantity)
  })

  it('clamps cost to zero if return exceeds cost', () => {
    const pool = addToPool(emptyPool(), '100', '100.00')
    const after = applyCapReturn(pool, '5.00')  // £500 > £100 cost
    expect(after.costGbp).toBe(new Big(0).toFixed(8))
  })
})

describe('S104 pool — poolAvgCost', () => {
  it('returns 0 for empty pool', () => {
    expect(poolAvgCost(emptyPool())).toBe('0')
  })

  it('returns exact average', () => {
    let pool = emptyPool()
    pool = addToPool(pool, '3', '30.00')
    expect(new Big(poolAvgCost(pool)).toFixed(2)).toBe('10.00')
  })
})

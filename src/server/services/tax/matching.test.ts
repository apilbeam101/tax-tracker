import Big from 'big.js'
import { describe, expect, it } from 'vitest'
import type { Transaction } from '../../../shared/types.ts'
import { type CgtDisposalRecord, matchDisposals, taxYearForDate } from './matching.ts'

// ── Helpers ───────────────────────────────────────────────────────────────────

let _id = 0
function txn(
  overrides: Partial<Transaction> & Pick<Transaction, 'txnType' | 'txnDate' | 'quantity'>,
): Transaction {
  return {
    id: ++_id,
    tenantId: 1,
    instrumentId: 1,
    txnType: overrides.txnType,
    txnDate: overrides.txnDate,
    quantity: overrides.quantity,
    unitPriceNative: overrides.unitPriceNative ?? null,
    nativeCurrency: overrides.nativeCurrency ?? null,
    fxRate: overrides.fxRate ?? null,
    fxRateType: overrides.fxRateType ?? null,
    fxRateSource: overrides.fxRateSource ?? null,
    unitPriceGbp: overrides.unitPriceGbp ?? null,
    totalGbp: overrides.totalGbp ?? null,
    costsGbp: overrides.costsGbp ?? '0',
    netGbp: overrides.netGbp ?? null,
    incomeAmountGbp: overrides.incomeAmountGbp ?? null,
    esppDiscountPriceNative: overrides.esppDiscountPriceNative ?? null,
    esppDiscountPriceGbp: overrides.esppDiscountPriceGbp ?? null,
    rsuGrossSharesVested: overrides.rsuGrossSharesVested ?? null,
    rsuSharesWithheld: overrides.rsuSharesWithheld ?? null,
    rsuWithholdingRate: overrides.rsuWithholdingRate ?? null,
    rsuWithholdingMethod: overrides.rsuWithholdingMethod ?? null,
    dividendGrossGbp: overrides.dividendGrossGbp ?? null,
    dividendWithholdingGbp: overrides.dividendWithholdingGbp ?? null,
    dividendNetGbp: overrides.dividendNetGbp ?? null,
    splitRatio: overrides.splitRatio ?? null,
    capreturnsPerShareGbp: overrides.capreturnsPerShareGbp ?? null,
    notes: overrides.notes ?? null,
    importSource: overrides.importSource ?? null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  }
}

function gain(d: CgtDisposalRecord) {
  return new Big(d.gainGbp).toFixed(2)
}

// ── taxYearForDate ────────────────────────────────────────────────────────────

describe('taxYearForDate', () => {
  it('maps 6 Apr 2025 to 2025-26', () => {
    expect(taxYearForDate('2025-04-06')).toBe('2025-26')
  })
  it('maps 5 Apr 2025 to 2024-25', () => {
    expect(taxYearForDate('2025-04-05')).toBe('2024-25')
  })
  it('maps 31 Dec 2024 to 2024-25', () => {
    expect(taxYearForDate('2024-12-31')).toBe('2024-25')
  })
})

// ── S104 pool matching ────────────────────────────────────────────────────────

describe('matchDisposals — S104 pool', () => {
  it('simple buy then sell produces correct S104 gain', () => {
    const txns = [
      txn({ txnType: 'BUY', txnDate: '2023-01-10', quantity: '100', unitPriceGbp: '10.00' }),
      txn({ txnType: 'SELL', txnDate: '2024-03-15', quantity: '50', unitPriceGbp: '15.00' }),
    ]
    const { disposals, pool } = matchDisposals(txns)
    expect(disposals).toHaveLength(1)
    expect(disposals[0]!.matchType).toBe('s104-pool')
    // proceeds 50×£15 = £750; cost 50×£10 = £500; gain = £250
    expect(gain(disposals[0]!)).toBe('250.00')
    // pool: 50 shares remain at avg cost £10 → £500
    expect(new Big(pool.quantity).toFixed(0)).toBe('50')
    expect(new Big(pool.costGbp).toFixed(2)).toBe('500.00')
  })

  it('buy × 3 at different prices → pool average → partial disposal', () => {
    const txns = [
      txn({ txnType: 'BUY', txnDate: '2022-05-01', quantity: '100', unitPriceGbp: '10.00' }),
      txn({ txnType: 'BUY', txnDate: '2022-06-01', quantity: '100', unitPriceGbp: '12.00' }),
      txn({ txnType: 'BUY', txnDate: '2022-07-01', quantity: '100', unitPriceGbp: '14.00' }),
      // avg cost = (1000+1200+1400)/300 = £12.00
      txn({ txnType: 'SELL', txnDate: '2023-01-01', quantity: '150', unitPriceGbp: '20.00' }),
    ]
    const { disposals, pool } = matchDisposals(txns)
    expect(disposals).toHaveLength(1)
    // proceeds 150×£20=£3000; cost 150×£12=£1800; gain=£1200
    expect(gain(disposals[0]!)).toBe('1200.00')
    // remaining pool: 150 shares at avg £12 → £1800
    expect(new Big(pool.quantity).toFixed(0)).toBe('150')
    expect(new Big(pool.costGbp).toFixed(2)).toBe('1800.00')
  })
})

// ── Same-day matching ─────────────────────────────────────────────────────────

describe('matchDisposals — same-day rule', () => {
  it('sell and buy on same day → same-day match (not S104)', () => {
    const t1 = txn({
      txnType: 'BUY',
      txnDate: '2024-01-10',
      quantity: '100',
      unitPriceGbp: '10.00',
    })
    const t2 = txn({
      txnType: 'SELL',
      txnDate: '2024-06-01',
      quantity: '100',
      unitPriceGbp: '20.00',
    })
    const t3 = txn({ txnType: 'BUY', txnDate: '2024-06-01', quantity: '50', unitPriceGbp: '19.00' })
    const { disposals, pool } = matchDisposals([t1, t2, t3])
    // 50 of the sell matches same-day buy at £19; 50 from S104 at £10
    const sdMatch = disposals.find((d) => d.matchType === 'same-day')!
    const poolMatch = disposals.find((d) => d.matchType === 's104-pool')!
    expect(sdMatch).toBeDefined()
    expect(poolMatch).toBeDefined()
    expect(new Big(sdMatch.quantity).toFixed(0)).toBe('50')
    // same-day: proceeds 50×£20=£1000; cost 50×£19=£950; gain=£50
    expect(gain(sdMatch)).toBe('50.00')
    // S104: proceeds 50×£20=£1000; cost 50×£10=£500; gain=£500
    expect(gain(poolMatch)).toBe('500.00')
    // Post-sell pool: 50 original shares remain (none of the same-day buy entered pool)
    // Actually same-day buy was all matched; original buy 100 - 50 sold from pool = 50 remain
    expect(new Big(pool.quantity).toFixed(0)).toBe('50')
  })
})

// ── 30-day (bed & breakfast) rule ────────────────────────────────────────────

describe('matchDisposals — 30-day B&B rule', () => {
  it('sell 100, buy 50 within 30 days → 50 matched B&B, 50 from pool', () => {
    // Build up pool first
    const txns = [
      txn({ txnType: 'BUY', txnDate: '2023-01-01', quantity: '200', unitPriceGbp: '10.00' }),
      txn({ txnType: 'SELL', txnDate: '2024-05-01', quantity: '100', unitPriceGbp: '20.00' }),
      // B&B: buy 50 shares 15 days after the sell
      txn({ txnType: 'BUY', txnDate: '2024-05-16', quantity: '50', unitPriceGbp: '22.00' }),
    ]
    const { disposals } = matchDisposals(txns)
    const bbMatch = disposals.find((d) => d.matchType === '30-day')!
    const poolMatch = disposals.find((d) => d.matchType === 's104-pool')!
    expect(bbMatch).toBeDefined()
    expect(poolMatch).toBeDefined()
    expect(new Big(bbMatch.quantity).toFixed(0)).toBe('50')
    // B&B: proceeds 50×£20=£1000; cost 50×£22=£1100; gain=−£100 (a loss)
    expect(gain(bbMatch)).toBe('-100.00')
    // S104: proceeds 50×£20=£1000; cost 50×£10=£500; gain=£500
    expect(gain(poolMatch)).toBe('500.00')
  })

  it('buy on day 31 after disposal is NOT matched as B&B', () => {
    const txns = [
      txn({ txnType: 'BUY', txnDate: '2023-01-01', quantity: '100', unitPriceGbp: '10.00' }),
      txn({ txnType: 'SELL', txnDate: '2024-05-01', quantity: '100', unitPriceGbp: '20.00' }),
      txn({ txnType: 'BUY', txnDate: '2024-06-01', quantity: '100', unitPriceGbp: '22.00' }), // day 31
    ]
    const { disposals } = matchDisposals(txns)
    expect(disposals.every((d) => d.matchType === 's104-pool')).toBe(true)
  })
})

// ── Mixed match types in a single disposal ────────────────────────────────────

describe('matchDisposals — disposal spanning all three match types', () => {
  it('produces three disposal records with correct gain per slice', () => {
    const txns = [
      // Pool build-up
      txn({ txnType: 'BUY', txnDate: '2022-01-01', quantity: '100', unitPriceGbp: '10.00' }),
      // The disposal
      txn({ txnType: 'SELL', txnDate: '2024-06-01', quantity: '200', unitPriceGbp: '30.00' }),
      // Same-day acquisition: 50 shares at £25
      txn({ txnType: 'BUY', txnDate: '2024-06-01', quantity: '50', unitPriceGbp: '25.00' }),
      // 30-day acquisition: 50 shares at £28 (10 days later)
      txn({ txnType: 'BUY', txnDate: '2024-06-11', quantity: '50', unitPriceGbp: '28.00' }),
    ]
    const { disposals } = matchDisposals(txns)
    // Should have: 50 same-day, 50 B&B, 100 S104 = 3 disposal records
    expect(disposals).toHaveLength(3)
    const byType = Object.fromEntries(disposals.map((d) => [d.matchType, d]))
    expect(byType['same-day']).toBeDefined()
    expect(byType['30-day']).toBeDefined()
    expect(byType['s104-pool']).toBeDefined()
    // same-day: 50×£30 proceeds − 50×£25 cost = £250 gain
    expect(gain(byType['same-day']!)).toBe('250.00')
    // 30-day: 50×£30 − 50×£28 = £100 gain
    expect(gain(byType['30-day']!)).toBe('100.00')
    // S104: 100×£30 − 100×£10 = £2000 gain
    expect(gain(byType['s104-pool']!)).toBe('2000.00')
  })
})

// ── RSU vest → subsequent sale ────────────────────────────────────────────────

describe('matchDisposals — RSU vest then sale', () => {
  it('employs vest price as cost basis; CGT gain is post-vest appreciation only', () => {
    // Vest 100 shares at £20 (employment income = £2000 already taxed via PAYE)
    // Sell 6 months later at £25 → CGT gain = £500 (not £2500)
    const txns = [
      txn({ txnType: 'RSU_VEST', txnDate: '2024-06-01', quantity: '100', unitPriceGbp: '20.00' }),
      txn({ txnType: 'SELL', txnDate: '2024-12-01', quantity: '100', unitPriceGbp: '25.00' }),
    ]
    const { disposals } = matchDisposals(txns)
    expect(disposals).toHaveLength(1)
    // proceeds 100×£25=£2500; allowable cost 100×£20=£2000; gain=£500
    expect(gain(disposals[0]!)).toBe('500.00')
  })
})

// ── DRIP (dividend reinvestment) ─────────────────────────────────────────────

describe('matchDisposals — DRIP enters S104 pool', () => {
  it('DRIP transactions add shares to the pool', () => {
    const txns = [
      txn({
        txnType: 'ESPP_PURCHASE',
        txnDate: '2021-01-01',
        quantity: '545',
        unitPriceGbp: '30.00',
      }),
      txn({ txnType: 'DRIP', txnDate: '2021-01-15', quantity: '5', unitPriceGbp: '32.00' }),
      txn({ txnType: 'DRIP', txnDate: '2021-02-15', quantity: '8.86', unitPriceGbp: '34.00' }),
      txn({ txnType: 'SELL', txnDate: '2021-03-22', quantity: '558.86', unitPriceGbp: '35.00' }),
    ]
    // Pool before sell: 545 + 5 + 8.86 = 558.86 — should not throw
    const { disposals, pool } = matchDisposals(txns)
    expect(disposals).toHaveLength(1)
    expect(disposals[0]!.matchType).toBe('s104-pool')
    expect(new Big(pool.quantity).toFixed(0)).toBe('0')
  })

  it('DIV_PAY does NOT enter the pool (cash dividend, income only)', () => {
    const txns = [
      txn({ txnType: 'BUY', txnDate: '2021-01-01', quantity: '100', unitPriceGbp: '30.00' }),
      txn({ txnType: 'DIV_PAY', txnDate: '2021-04-01', quantity: '261', unitPriceGbp: '0.37' }),
      txn({ txnType: 'SELL', txnDate: '2021-06-01', quantity: '100', unitPriceGbp: '35.00' }),
    ]
    const { disposals, pool } = matchDisposals(txns)
    expect(disposals).toHaveLength(1)
    expect(new Big(pool.quantity).toFixed(0)).toBe('0')
  })
})

// ── Stock split ───────────────────────────────────────────────────────────────

describe('matchDisposals — stock split adjusts pool quantity', () => {
  it('2-for-1 split doubles pool quantity, halves effective cost per share', () => {
    const txns = [
      txn({ txnType: 'BUY', txnDate: '2022-01-01', quantity: '100', unitPriceGbp: '20.00' }),
      txn({ txnType: 'SPLIT', txnDate: '2023-01-01', quantity: '100', splitRatio: '2/1' }),
      txn({ txnType: 'SELL', txnDate: '2024-01-01', quantity: '200', unitPriceGbp: '12.00' }),
    ]
    const { disposals, pool } = matchDisposals(txns)
    // After split: 200 shares at total cost £2000 → avg £10/share
    // Sell 200 at £12 → proceeds £2400; cost £2000; gain £400
    expect(disposals).toHaveLength(1)
    expect(gain(disposals[0]!)).toBe('400.00')
    expect(new Big(pool.quantity).toFixed(0)).toBe('0')
  })
})

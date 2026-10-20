import { describe, expect, it } from 'vitest'
import type { Instrument, Transaction } from '../../../shared/types.ts'
import type { CgtDisposalRecord, PoolSnapshot } from '../tax/matching.ts'
import { buildDisposalComputations, formatComputationsText } from './computation.ts'

const ACME: Instrument = {
  id: 1,
  tenantId: 1,
  ticker: 'ACME',
  isin: null,
  name: 'Acme Corporation',
  currency: 'USD',
  exchange: 'NASDAQ',
  instrumentType: 'equity',
  isEmployerStock: false,
  rsuWithholdingMethod: 'net-settlement',
  notes: null,
  createdAt: '2024-01-01T00:00:00Z',
}

function txn(overrides: Partial<Transaction> & Pick<Transaction, 'id' | 'txnType'>): Transaction {
  return {
    tenantId: 1,
    instrumentId: 1,
    txnDate: '2025-06-01',
    quantity: '100',
    unitPriceNative: null,
    nativeCurrency: null,
    fxRate: null,
    fxRateType: null,
    fxRateSource: null,
    unitPriceGbp: '50.00',
    totalGbp: null,
    costsGbp: '0',
    netGbp: null,
    incomeAmountGbp: null,
    esppDiscountPriceNative: null,
    esppDiscountPriceGbp: null,
    rsuGrossSharesVested: null,
    rsuSharesWithheld: null,
    rsuWithholdingRate: null,
    rsuWithholdingMethod: null,
    dividendGrossGbp: null,
    dividendWithholdingGbp: null,
    dividendNetGbp: null,
    splitRatio: null,
    capreturnsPerShareGbp: null,
    notes: null,
    importSource: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  } as Transaction
}

function record(overrides: Partial<CgtDisposalRecord> = {}): CgtDisposalRecord {
  return {
    txnId: 10,
    instrumentId: 1,
    disposalDate: '2025-08-15',
    taxYear: '2025-26',
    matchType: 's104-pool',
    acquisitionTxnId: null,
    quantity: '100.00000000',
    proceedsGbp: '6000.00000000',
    allowableCostGbp: '5000.00000000',
    sellingCostsGbp: '0.00000000',
    gainGbp: '1000.00000000',
    ...overrides,
  }
}

const instruments = new Map([[1, ACME]])

describe('buildDisposalComputations', () => {
  it('groups the match records of one sale into a single disposal', () => {
    const records = [
      record({
        matchType: '30-day',
        acquisitionTxnId: 20,
        quantity: '40',
        proceedsGbp: '2400',
        allowableCostGbp: '2600',
        gainGbp: '-200',
      }),
      record({
        matchType: 's104-pool',
        quantity: '60',
        proceedsGbp: '3600',
        allowableCostGbp: '3000',
        gainGbp: '600',
      }),
    ]
    const txns = new Map([
      [10, txn({ id: 10, txnType: 'SELL', txnDate: '2025-08-15', quantity: '100' })],
      [
        20,
        txn({
          id: 20,
          txnType: 'BUY',
          txnDate: '2025-08-22',
          quantity: '40',
          unitPriceGbp: '65.00',
        }),
      ],
    ])

    const [c, ...rest] = buildDisposalComputations(records, txns, instruments, new Map())

    expect(rest).toHaveLength(0)
    expect(c!.slices).toHaveLength(2)
    expect(c!.ticker).toBe('ACME')
    expect(c!.quantity).toBe('100.00000000')
    expect(parseFloat(c!.grossProceedsGbp)).toBe(6000)
    expect(parseFloat(c!.totalAllowableCostGbp)).toBe(5600)
    // Net of the loss on the 30-day match and the gain on the pool match
    expect(parseFloat(c!.totalGainGbp)).toBe(400)
  })

  it('splits a matched acquisition cost into price and incidental fee components', () => {
    const records = [
      record({
        matchType: 'same-day',
        acquisitionTxnId: 20,
        quantity: '60',
        proceedsGbp: '3900',
        allowableCostGbp: '3612',
        gainGbp: '288',
      }),
    ]
    const txns = new Map([
      [10, txn({ id: 10, txnType: 'SELL', quantity: '60' })],
      [
        20,
        txn({ id: 20, txnType: 'BUY', quantity: '80', unitPriceGbp: '60.00', costsGbp: '16.00' }),
      ],
    ])

    const [c] = buildDisposalComputations(records, txns, instruments, new Map())
    const slice = c!.slices[0]!

    // 60 × £60 = £3600 purchase price; the £12 balance is 60/80 of the £16 fee
    expect(parseFloat(slice.priceCostGbp)).toBe(3600)
    expect(parseFloat(slice.incidentalAcqCostGbp)).toBe(12)
    // Blended rate (£60.20) must differ from the price-only rate (£60.00),
    // otherwise the test would pass even if the two were conflated.
    expect(parseFloat(slice.pricePerShareGbp)).toBe(60)
    expect(parseFloat(slice.costPerShareGbp)).toBe(60.2)
    expect(slice.source).toContain('80 shares')
    expect(slice.source).toContain('fees')
  })

  it('reconstructs the pre-disposal pool for a s104 match from the snapshot', () => {
    const records = [record({ quantity: '100', allowableCostGbp: '5000' })]
    const snapshots: PoolSnapshot[] = [
      {
        txnId: 10,
        date: '2025-08-15',
        txnType: 'SELL',
        quantity: '150.00000000',
        costGbp: '7500.00000000',
        avgCostGbp: '50.00000000',
        matchTypes: ['s104-pool'],
      },
    ]
    const txns = new Map([[10, txn({ id: 10, txnType: 'SELL' })]])

    const [c] = buildDisposalComputations(records, txns, instruments, new Map([[1, snapshots]]))

    // Pool held 250 shares costing £12,500 before 100 shares at £5,000 came out
    expect(c!.slices[0]!.source).toContain('250')
    expect(c!.slices[0]!.source).toContain('12,500')
  })

  it('orders disposals by date', () => {
    const records = [
      record({ txnId: 11, disposalDate: '2025-10-01' }),
      record({ txnId: 10, disposalDate: '2025-08-15' }),
    ]
    const txns = new Map([
      [10, txn({ id: 10, txnType: 'SELL' })],
      [11, txn({ id: 11, txnType: 'SELL' })],
    ])
    const out = buildDisposalComputations(records, txns, instruments, new Map())
    expect(out.map((c) => c.disposalDate)).toEqual(['2025-08-15', '2025-10-01'])
  })
})

describe('formatComputationsText', () => {
  const records = [
    record({
      matchType: '30-day',
      acquisitionTxnId: 20,
      quantity: '40',
      proceedsGbp: '2400',
      allowableCostGbp: '2600',
      gainGbp: '-200',
    }),
    record({
      matchType: 's104-pool',
      quantity: '60',
      proceedsGbp: '3600',
      allowableCostGbp: '3000',
      gainGbp: '600',
    }),
  ]
  const txns = new Map([
    [
      10,
      txn({
        id: 10,
        txnType: 'SELL',
        quantity: '100',
        unitPriceNative: '75.00',
        nativeCurrency: 'USD',
        fxRate: '0.80',
        fxRateType: 'hmrc-monthly',
        fxRateSource: 'trade-tariff.service.gov.uk',
      }),
    ],
    [
      20,
      txn({ id: 20, txnType: 'BUY', txnDate: '2025-08-22', quantity: '40', unitPriceGbp: '65.00' }),
    ],
  ])

  it('states the statutory basis and the FX provenance', () => {
    const text = formatComputationsText(
      buildDisposalComputations(records, txns, instruments, new Map()),
      '2025-26',
    )
    expect(text).toContain('s.104')
    expect(text).toContain('s.106A')
    expect(text).toContain('USD 75.00')
    expect(text).toContain('hmrc-monthly')
    expect(text).toContain('trade-tariff.service.gov.uk')
  })

  it('reports gains and losses on both bases with an identical net', () => {
    const text = formatComputationsText(
      buildDisposalComputations(records, txns, instruments, new Map()),
      '2025-26',
    )
    expect(text).toContain('Per-match basis')
    expect(text).toContain('Per-disposal basis')
    // Per-match: £600 gain and £200 loss. Per-disposal: £400 gain, no loss.
    expect(text).toMatch(/Per-match basis[\s\S]*Gains before losses: £600\.00/)
    expect(text).toMatch(/Per-match basis[\s\S]*Losses in the year: £200\.00/)
    expect(text).toMatch(/Per-disposal basis[\s\S]*Gains before losses: £400\.00/)
    expect(text).toMatch(/Per-disposal basis[\s\S]*Losses in the year: £0\.00/)
    expect(text).toContain('identical on either basis): £400.00')
  })

  it('renders a loss in parentheses rather than with a minus sign', () => {
    const text = formatComputationsText(
      buildDisposalComputations(
        [record({ quantity: '10', proceedsGbp: '100', allowableCostGbp: '150', gainGbp: '-50' })],
        txns,
        instruments,
        new Map(),
      ),
      '2025-26',
    )
    expect(text).toContain('(£50.00)')
    expect(text).toContain('NET LOSS ON DISPOSAL 1')
  })
})

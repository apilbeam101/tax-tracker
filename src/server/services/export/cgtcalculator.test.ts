import { describe, it, expect } from 'vitest'
import { toCgtCalculatorRows, formatCgtCalculator } from './cgtcalculator.ts'
import type { Transaction, Instrument } from '../../../shared/types.ts'

function mkTxn(overrides: Partial<Transaction> & Pick<Transaction, 'txnType' | 'txnDate' | 'quantity'>): Transaction {
  return {
    id: 1, tenantId: 1, instrumentId: 1,
    txnType: overrides.txnType,
    txnDate: overrides.txnDate,
    quantity: overrides.quantity,
    unitPriceNative: null, nativeCurrency: null,
    fxRate: null, fxRateType: null, fxRateSource: null,
    unitPriceGbp: overrides.unitPriceGbp ?? null,
    totalGbp: null,
    costsGbp: overrides.costsGbp ?? '0',
    netGbp: null, incomeAmountGbp: null,
    esppDiscountPriceNative: null, esppDiscountPriceGbp: null,
    rsuGrossSharesVested: null, rsuSharesWithheld: null,
    rsuWithholdingRate: null, rsuWithholdingMethod: null,
    dividendGrossGbp: null, dividendWithholdingGbp: null, dividendNetGbp: null,
    splitRatio: null, capreturnsPerShareGbp: null,
    notes: null, importSource: null,
    createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
  }
}

const CSCO: Instrument = {
  id: 1, tenantId: 1, ticker: 'CSCO', isin: null,
  name: 'Cisco', currency: 'USD', exchange: 'NASDAQ',
  instrumentType: 'equity', isEmployerStock: false,
  rsuWithholdingMethod: 'net-settlement', notes: null,
  createdAt: '2025-01-01T00:00:00Z',
}

const instrumentsById = new Map([[1, CSCO]])

describe('cgtcalculator.com exporter', () => {
  it('formats a BUY row with DD/MM/YYYY date and GBP price (not pence)', () => {
    const txns = [mkTxn({ txnType: 'BUY', txnDate: '2004-01-12', quantity: '10000', unitPriceGbp: '0.525', costsGbp: '10.0' })]
    const rows = toCgtCalculatorRows(txns, instrumentsById)
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.action).toBe('B')
    expect(r.date).toBe('12/01/2004')
    expect(r.company).toBe('CSCO')
    expect(r.shares).toBe('10000')
    expect(r.price).toBe('0.525')     // pounds, not pence
    expect(r.charges).toBe('10.0')
    expect(r.stampDuty).toBe('0')
  })

  it('formats a SELL row correctly', () => {
    const txns = [mkTxn({ txnType: 'SELL', txnDate: '2004-02-23', quantity: '5000', unitPriceGbp: '1.75', costsGbp: '12.50' })]
    const rows = toCgtCalculatorRows(txns, instrumentsById)
    expect(rows[0]!.action).toBe('S')
    expect(rows[0]!.date).toBe('23/02/2004')
    expect(rows[0]!.price).toBe('1.75')
    expect(rows[0]!.charges).toBe('12.50')
  })

  it('maps RSU_VEST to B row', () => {
    const txns = [mkTxn({ txnType: 'RSU_VEST', txnDate: '2024-06-01', quantity: '25', unitPriceGbp: '19.50' })]
    const rows = toCgtCalculatorRows(txns, instrumentsById)
    expect(rows[0]!.action).toBe('B')
  })

  it('skips transactions with no unitPriceGbp', () => {
    const txns = [mkTxn({ txnType: 'BUY', txnDate: '2024-04-01', quantity: '100' })]
    expect(toCgtCalculatorRows(txns, instrumentsById)).toHaveLength(0)
  })

  it('skips non-price types like SPLIT', () => {
    const txns = [mkTxn({ txnType: 'SPLIT', txnDate: '2024-01-01', quantity: '200', unitPriceGbp: '0' })]
    expect(toCgtCalculatorRows(txns, instrumentsById)).toHaveLength(0)
  })

  it('formats output as tab-separated lines matching site example layout', () => {
    // Replicating the example from cgtcalculator.com/instructions.htm:
    //   B  12/01/2004  AVG  10000  0.525  10.0  26.25
    //   S  23/02/2004  NCH  5000   1.75   12.50  0.0
    const txns = [
      mkTxn({ txnType: 'BUY',  txnDate: '2004-01-12', quantity: '10000', unitPriceGbp: '0.525', costsGbp: '10.0' }),
      mkTxn({ txnType: 'SELL', txnDate: '2004-02-23', quantity: '5000',  unitPriceGbp: '1.75',  costsGbp: '12.50' }),
    ]
    const rows = toCgtCalculatorRows(txns, instrumentsById)
    const output = formatCgtCalculator(rows)
    const lines = output.split('\n')
    expect(lines).toHaveLength(2)
    // Tab-delimited, 7 fields: action date company shares price charges stampDuty
    expect(lines[0]!.split('\t')).toHaveLength(7)
    expect(lines[0]).toBe('B\t12/01/2004\tCSCO\t10000\t0.525\t10.0\t0')
    expect(lines[1]).toBe('S\t23/02/2004\tCSCO\t5000\t1.75\t12.50\t0')
  })
})

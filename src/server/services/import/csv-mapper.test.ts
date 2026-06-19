import { describe, it, expect } from 'vitest'
import { mapCsvToTransactions, validRows, toCreateBody } from './csv-mapper.ts'
import type { ColumnMapping } from './csv-mapper.ts'

// ── Basic mapping ──────────────────────────────────────────────────────────────

const BASIC_MAPPINGS: ColumnMapping[] = [
  { source: 'Type',     target: 'txnType' },
  { source: 'Date',     target: 'txnDate' },
  { source: 'Shares',   target: 'quantity' },
  { source: 'Price',    target: 'unitPriceNative' },
  { source: 'Currency', target: 'nativeCurrency' },
]

const BASIC_CSV = `Type,Date,Shares,Price,Currency
BUY,2024-04-01,100,18.25,USD
SELL,2025-01-15,50,22.00,USD
`

describe('mapCsvToTransactions', () => {
  it('maps header columns correctly', () => {
    const rows = mapCsvToTransactions(BASIC_CSV, BASIC_MAPPINGS)
    expect(rows).toHaveLength(2)
    const r = rows[0]!
    expect(r.txnType).toBe('BUY')
    expect(r.txnDate).toBe('2024-04-01')
    expect(r.quantity).toBe('100')
    expect(r.unitPriceNative).toBe('18.25')
    expect(r.nativeCurrency).toBe('USD')
    expect(r.errors).toHaveLength(0)
  })

  it('maps by column index when no header', () => {
    const csv = 'BUY,2024-04-01,100,18.25,USD\n'
    const mappings: ColumnMapping[] = [
      { source: 0, target: 'txnType' },
      { source: 1, target: 'txnDate' },
      { source: 2, target: 'quantity' },
      { source: 3, target: 'unitPriceNative' },
      { source: 4, target: 'nativeCurrency' },
    ]
    const rows = mapCsvToTransactions(csv, mappings, false)
    expect(rows[0]!.txnType).toBe('BUY')
    expect(rows[0]!.errors).toHaveLength(0)
  })

  it('reports error for unknown txnType', () => {
    const csv = `Type,Date,Shares\nFOO,2024-04-01,100\n`
    const mappings: ColumnMapping[] = [
      { source: 'Type',  target: 'txnType' },
      { source: 'Date',  target: 'txnDate' },
      { source: 'Shares', target: 'quantity' },
    ]
    const rows = mapCsvToTransactions(csv, mappings)
    expect(rows[0]!.errors).toContain('Unknown txnType: FOO')
  })

  it('reports error for missing required field txnDate', () => {
    const csv = `Type,Shares\nBUY,100\n`
    const mappings: ColumnMapping[] = [
      { source: 'Type',   target: 'txnType' },
      { source: 'Shares', target: 'quantity' },
    ]
    const rows = mapCsvToTransactions(csv, mappings)
    expect(rows[0]!.errors.some(e => e.includes('txnDate'))).toBe(true)
  })

  it('reports error for invalid decimal quantity', () => {
    const csv = `Type,Date,Shares\nBUY,2024-04-01,1e5\n`
    const mappings: ColumnMapping[] = [
      { source: 'Type',   target: 'txnType' },
      { source: 'Date',   target: 'txnDate' },
      { source: 'Shares', target: 'quantity' },
    ]
    const rows = mapCsvToTransactions(csv, mappings)
    expect(rows[0]!.errors.some(e => e.includes('quantity'))).toBe(true)
  })

  it('reports error for invalid date format', () => {
    const csv = `Type,Date,Shares\nBUY,01/04/2024,100\n`
    const mappings: ColumnMapping[] = [
      { source: 'Type',   target: 'txnType' },
      { source: 'Date',   target: 'txnDate' },
      { source: 'Shares', target: 'quantity' },
    ]
    const rows = mapCsvToTransactions(csv, mappings)
    expect(rows[0]!.errors.some(e => e.includes('txnDate'))).toBe(true)
  })

  it('returns empty array for empty CSV', () => {
    expect(mapCsvToTransactions('', [])).toHaveLength(0)
  })

  // ── Transforms ───────────────────────────────────────────────────────────────

  it('static transform overrides the source column', () => {
    const csv = `Date,Shares\n2024-04-01,100\n`
    const mappings: ColumnMapping[] = [
      { source: 'Date',   target: 'txnDate' },
      { source: 'Shares', target: 'quantity' },
      { source: 'Date',   target: 'txnType', transform: { kind: 'static', value: 'BUY' } },
    ]
    const rows = mapCsvToTransactions(csv, mappings)
    expect(rows[0]!.txnType).toBe('BUY')
    expect(rows[0]!.errors).toHaveLength(0)
  })

  it('map transform remaps raw value to internal value', () => {
    const csv = `Action,Date,Shares\nBought,2024-04-01,100\n`
    const mappings: ColumnMapping[] = [
      { source: 'Action', target: 'txnType', transform: { kind: 'map', values: { Bought: 'BUY', Sold: 'SELL' } } },
      { source: 'Date',   target: 'txnDate' },
      { source: 'Shares', target: 'quantity' },
    ]
    const rows = mapCsvToTransactions(csv, mappings)
    expect(rows[0]!.txnType).toBe('BUY')
    expect(rows[0]!.errors).toHaveLength(0)
  })

  it('dateReformat transform converts DD/MM/YYYY to YYYY-MM-DD', () => {
    const csv = `Type,Date,Shares\nBUY,01/04/2024,100\n`
    const mappings: ColumnMapping[] = [
      { source: 'Type',   target: 'txnType' },
      { source: 'Date',   target: 'txnDate', transform: { kind: 'dateReformat', fromFormat: 'DD/MM/YYYY' } },
      { source: 'Shares', target: 'quantity' },
    ]
    const rows = mapCsvToTransactions(csv, mappings)
    expect(rows[0]!.txnDate).toBe('2024-04-01')
    expect(rows[0]!.errors).toHaveLength(0)
  })

  it('dateReformat transform converts MM/DD/YYYY to YYYY-MM-DD', () => {
    const csv = `Type,Date,Shares\nBUY,04/01/2024,100\n`
    const mappings: ColumnMapping[] = [
      { source: 'Type',   target: 'txnType' },
      { source: 'Date',   target: 'txnDate', transform: { kind: 'dateReformat', fromFormat: 'MM/DD/YYYY' } },
      { source: 'Shares', target: 'quantity' },
    ]
    const rows = mapCsvToTransactions(csv, mappings)
    expect(rows[0]!.txnDate).toBe('2024-04-01')
    expect(rows[0]!.errors).toHaveLength(0)
  })
})

describe('validRows', () => {
  it('filters to only rows with no errors', () => {
    const rows = mapCsvToTransactions(BASIC_CSV, BASIC_MAPPINGS)
    expect(validRows(rows)).toHaveLength(2)
  })
})

describe('toCreateBody', () => {
  it('builds a CreateTransactionBody from a valid row', () => {
    const rows = mapCsvToTransactions(BASIC_CSV, BASIC_MAPPINGS)
    const body = toCreateBody(rows[0]!, 42)
    expect(body.instrumentId).toBe(42)
    expect(body.txnType).toBe('BUY')
    expect(body.txnDate).toBe('2024-04-01')
    expect(body.quantity).toBe('100')
    expect(body.unitPriceNative).toBe('18.25')
    expect(body.nativeCurrency).toBe('USD')
  })
})

describe('ticker field', () => {
  it('maps a ticker column and exposes it on the row', () => {
    const csv = `Ticker,Type,Date,Shares\nCSCO,BUY,2024-04-01,100\nAAPL,SELL,2025-01-15,50\n`
    const mappings: ColumnMapping[] = [
      { source: 'Ticker', target: 'ticker' },
      { source: 'Type',   target: 'txnType' },
      { source: 'Date',   target: 'txnDate' },
      { source: 'Shares', target: 'quantity' },
    ]
    const rows = mapCsvToTransactions(csv, mappings)
    expect(rows[0]!.ticker).toBe('CSCO')
    expect(rows[1]!.ticker).toBe('AAPL')
    expect(rows[0]!.errors).toHaveLength(0)
    expect(rows[1]!.errors).toHaveLength(0)
  })

  it('is null when not mapped', () => {
    const rows = mapCsvToTransactions(BASIC_CSV, BASIC_MAPPINGS)
    expect(rows[0]!.ticker).toBeNull()
  })
})

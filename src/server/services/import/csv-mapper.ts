/**
 * Generic CSV → Transaction mapper.
 *
 * The client supplies a column mapping that says which CSV column maps to
 * which internal field.  The server parses the CSV, applies the mapping,
 * and returns a preview of the rows before the caller decides to commit.
 *
 * No broker-specific presets are included — correctness would require access
 * to real broker exports to validate against, which we don't have.
 *
 * Supported target fields (a subset of CreateTransactionBody):
 *   ticker (used server-side to resolve instrumentId),
 *   txnType, txnDate, quantity,
 *   unitPriceNative, nativeCurrency, costsGbp,
 *   notes
 *
 * instrumentId is resolved server-side: per-row from ticker (if mapped),
 * falling back to the caller-supplied default instrumentId.
 */

import { parse } from 'csv-parse/sync'
import type { TransactionType } from '../../../shared/types.ts'

/** One entry in the user-supplied column map. */
export interface ColumnMapping {
  /** Zero-based index OR header name of the source CSV column. */
  source: number | string
  /** Internal field to map this column to. */
  target: MappableField
  /** Optional transform to apply after extracting the raw value. */
  transform?: ValueTransform
}

export type MappableField =
  | 'ticker'
  | 'txnType'
  | 'txnDate'
  | 'quantity'
  | 'unitPriceNative'
  | 'nativeCurrency'
  | 'costsGbp'
  | 'notes'

export type ValueTransform =
  | { kind: 'static'; value: string }          // always use this value, ignore source column
  | { kind: 'map'; values: Record<string, string> }  // remap raw → internal value
  | { kind: 'negate' }                         // multiply by -1 (e.g. for cost columns stored as positive)
  | { kind: 'dateReformat'; fromFormat: string }  // reformat date to YYYY-MM-DD

/** One parsed row returned to the caller for preview. */
export interface MappedRow {
  /** Row index in the CSV (0-based, excluding header). */
  index: number
  ticker: string | null
  txnType: string | null
  txnDate: string | null
  quantity: string | null
  unitPriceNative: string | null
  nativeCurrency: string | null
  costsGbp: string | null
  notes: string | null
  /** Any validation errors found on this row. */
  errors: string[]
}

const VALID_TXN_TYPES = new Set<string>([
  'BUY', 'SELL', 'DIV_PAY', 'DRIP', 'RSU_VEST', 'ESPP_PURCHASE',
  'SPLIT', 'UNSPLIT', 'CAPRETURN', 'RIGHTS_ISSUE', 'TRANSFER_IN', 'TRANSFER_OUT',
])

const DECIMAL_RE = /^\d+(\.\d+)?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function applyTransform(raw: string, transform: ValueTransform | undefined): string {
  if (!transform) return raw
  switch (transform.kind) {
    case 'static':
      return transform.value
    case 'map': {
      const mapped = transform.values[raw]
      return mapped !== undefined ? mapped : raw
    }
    case 'negate': {
      const n = parseFloat(raw)
      if (!isNaN(n)) return String(-n)
      return raw
    }
    case 'dateReformat': {
      return reformatDate(raw, transform.fromFormat)
    }
  }
}

/**
 * Reformat a date string to YYYY-MM-DD.
 * fromFormat is a simple pattern using Y/M/D placeholders, e.g. "MM/DD/YYYY" or "DD/MM/YYYY".
 */
function reformatDate(raw: string, fromFormat: string): string {
  const fmt = fromFormat.toUpperCase()
  // Determine separator from the format string (first non-YMD char)
  const sep = fmt.replace(/[YMD]/g, '')[0] ?? '/'
  const parts = raw.split(sep)
  const fmtParts = fmt.split(sep)

  let year = '', month = '', day = ''
  for (let i = 0; i < fmtParts.length; i++) {
    const p = fmtParts[i]?.replace(/[^YMD]/g, '')
    if (p === 'YYYY' || p === 'YY') year = parts[i] ?? ''
    else if (p === 'MM' || p === 'M') month = (parts[i] ?? '').padStart(2, '0')
    else if (p === 'DD' || p === 'D') day = (parts[i] ?? '').padStart(2, '0')
  }

  if (year.length === 2) year = '20' + year
  return `${year}-${month}-${day}`
}

function resolveColumn(row: string[], headers: string[], source: number | string): string {
  if (typeof source === 'number') {
    return row[source] ?? ''
  }
  const idx = headers.indexOf(source)
  if (idx === -1) return ''
  return row[idx] ?? ''
}

/** Parse a CSV buffer and apply column mappings. Returns preview rows. */
export function mapCsvToTransactions(
  csvBuffer: Buffer | string,
  mappings: ColumnMapping[],
  hasHeader = true,
): MappedRow[] {
  const records: string[][] = parse(csvBuffer, {
    skip_empty_lines: true,
    relax_column_count: true,
  })

  if (records.length === 0) return []

  const headers = hasHeader ? (records[0] ?? []) : []
  const dataRows = hasHeader ? records.slice(1) : records

  return dataRows.map((row, index) => {
    const result: MappedRow = {
      index,
      ticker: null,
      txnType: null,
      txnDate: null,
      quantity: null,
      unitPriceNative: null,
      nativeCurrency: null,
      costsGbp: null,
      notes: null,
      errors: [],
    }

    for (const mapping of mappings) {
      const raw = resolveColumn(row, headers, mapping.source)
      const value = applyTransform(raw.trim(), mapping.transform)
      if (value !== '') {
        result[mapping.target] = value
      }
    }

    // Validate
    if (!result.txnType) {
      result.errors.push('txnType is required')
    } else if (!VALID_TXN_TYPES.has(result.txnType)) {
      result.errors.push(`Unknown txnType: ${result.txnType}`)
    }

    if (!result.txnDate) {
      result.errors.push('txnDate is required')
    } else if (!DATE_RE.test(result.txnDate)) {
      result.errors.push(`txnDate must be YYYY-MM-DD, got: ${result.txnDate}`)
    }

    if (!result.quantity) {
      result.errors.push('quantity is required')
    } else if (!DECIMAL_RE.test(result.quantity)) {
      result.errors.push(`quantity must be a non-negative decimal, got: ${result.quantity}`)
    }

    for (const field of ['unitPriceNative', 'costsGbp'] as const) {
      const v = result[field]
      if (v !== null && !DECIMAL_RE.test(v)) {
        result.errors.push(`${field} must be a non-negative decimal, got: ${v}`)
      }
    }

    return result
  })
}

/** Filter mapped rows to only those that are valid and ready to import. */
export function validRows(rows: MappedRow[]): MappedRow[] {
  return rows.filter(r => r.errors.length === 0)
}

/** Build a CreateTransactionBody-compatible object from a valid MappedRow. */
export function toCreateBody(row: MappedRow, instrumentId: number): {
  instrumentId: number
  txnType: TransactionType
  txnDate: string
  quantity: string
  unitPriceNative?: string
  nativeCurrency?: string
  costsGbp?: string
  notes?: string
} {
  return {
    instrumentId,
    txnType: row.txnType as TransactionType,
    txnDate: row.txnDate!,
    quantity: row.quantity!,
    ...(row.unitPriceNative ? { unitPriceNative: row.unitPriceNative } : {}),
    ...(row.nativeCurrency ? { nativeCurrency: row.nativeCurrency } : {}),
    ...(row.costsGbp ? { costsGbp: row.costsGbp } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
  }
}

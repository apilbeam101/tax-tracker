import { BadRequestError } from '../../errors.ts'
import type { ArchiveData } from './archive.ts'

const DECIMAL = /^-?\d+(\.\d+)?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY = /^[A-Z]{3}$/

const TXN_TYPES = [
  'BUY',
  'SELL',
  'DIV_PAY',
  'DRIP',
  'RSU_VEST',
  'ESPP_PURCHASE',
  'SPLIT',
  'UNSPLIT',
  'CAPRETURN',
  'RIGHTS_ISSUE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
]
const INSTRUMENT_TYPES = ['equity', 'fund', 'etf', 'reit']
const WITHHOLDING_METHODS = ['net-settlement', 'sell-to-cover', 'cash']
const FX_RATE_TYPES = ['hmrc-monthly', 'daily-spot', 'manual']

type Obj = Record<string, unknown>

function fail(what: string, index: number, field: string): never {
  throw new BadRequestError(`The archive is invalid: ${what} #${index + 1} has a bad "${field}"`)
}

function rows(data: Obj, key: string): Obj[] {
  const list = data[key]
  if (!Array.isArray(list)) throw new BadRequestError(`The archive is missing "${key}"`)
  list.forEach((row, i) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) fail(key, i, 'row')
  })
  return list as Obj[]
}

// Each check names the field and row, because the user has to be able to find what to fix.
function checker(what: string, row: Obj, index: number) {
  const bad = (field: string) => fail(what, index, field)
  return {
    int(field: string) {
      if (!Number.isInteger(row[field])) bad(field)
    },
    text(field: string, nullable = false) {
      const v = row[field]
      if (v === null || v === undefined ? !nullable : typeof v !== 'string') bad(field)
    },
    nonEmpty(field: string) {
      if (typeof row[field] !== 'string' || (row[field] as string).trim() === '') bad(field)
    },
    decimal(field: string, nullable = false) {
      const v = row[field]
      if (v === null || v === undefined ? !nullable : typeof v !== 'string' || !DECIMAL.test(v)) {
        bad(field)
      }
    },
    date(field: string) {
      if (typeof row[field] !== 'string' || !DATE.test(row[field] as string)) bad(field)
    },
    oneOf(field: string, allowed: string[], nullable = false) {
      const v = row[field]
      if (v === null || v === undefined ? !nullable : !allowed.includes(v as string)) bad(field)
    },
    currency(field: string, nullable = false) {
      const v = row[field]
      if (v === null || v === undefined ? !nullable : typeof v !== 'string' || !CURRENCY.test(v)) {
        bad(field)
      }
    },
    bool(field: string) {
      if (typeof row[field] !== 'boolean') bad(field)
    },
  }
}

const TXN_DECIMALS_NULLABLE = [
  'unitPriceNative',
  'fxRate',
  'unitPriceGbp',
  'totalGbp',
  'netGbp',
  'incomeAmountGbp',
  'esppDiscountPriceNative',
  'esppDiscountPriceGbp',
  'rsuGrossSharesVested',
  'rsuSharesWithheld',
  'rsuWithholdingRate',
  'dividendGrossGbp',
  'dividendWithholdingGbp',
  'dividendNetGbp',
  'capreturnsPerShareGbp',
]

// What the stores do not check themselves. A value that slips through here would be stored, and
// later make the tax engine throw, silently leaving an instrument without disposals.
export function validateArchiveData(raw: unknown): ArchiveData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadRequestError('The archive holds no data')
  }
  const data = raw as Obj

  const instruments = rows(data, 'instruments')
  instruments.forEach((row, i) => {
    const c = checker('instrument', row, i)
    c.int('id')
    c.nonEmpty('ticker')
    c.nonEmpty('name')
    c.currency('currency')
    c.oneOf('instrumentType', INSTRUMENT_TYPES)
    c.bool('isEmployerStock')
    c.oneOf('rsuWithholdingMethod', WITHHOLDING_METHODS)
    c.text('isin', true)
    c.text('exchange', true)
    c.text('notes', true)
  })

  rows(data, 'transactions').forEach((row, i) => {
    const c = checker('transaction', row, i)
    c.int('id')
    c.int('instrumentId')
    c.oneOf('txnType', TXN_TYPES)
    c.date('txnDate')
    c.decimal('quantity')
    c.decimal('costsGbp')
    for (const field of TXN_DECIMALS_NULLABLE) c.decimal(field, true)
    c.currency('nativeCurrency', true)
    c.oneOf('fxRateType', FX_RATE_TYPES, true)
    c.oneOf('rsuWithholdingMethod', WITHHOLDING_METHODS, true)
    c.text('fxRateSource', true)
    c.text('splitRatio', true)
    c.text('notes', true)
  })

  rows(data, 'vestSchedule').forEach((row, i) => {
    const c = checker('scheduled vest', row, i)
    c.int('instrumentId')
    c.nonEmpty('scheduleType')
    c.date('scheduledDate')
    c.decimal('quantity')
    c.decimal('expectedPriceUsd', true)
    c.decimal('expectedDiscountPriceNative', true)
    c.text('notes', true)
    if (row.realisedTxnId !== null && !Number.isInteger(row.realisedTxnId)) {
      fail('scheduled vest', i, 'realisedTxnId')
    }
  })

  rows(data, 'prices').forEach((row, i) => {
    const c = checker('price', row, i)
    c.int('instrumentId')
    c.date('priceDate')
    c.decimal('closePrice')
    c.text('source')
  })

  rows(data, 'fxRates').forEach((row, i) => {
    const c = checker('exchange rate', row, i)
    c.currency('fromCurrency')
    c.currency('toCurrency')
    c.date('rateDate')
    c.decimal('rate')
    c.oneOf('rateType', FX_RATE_TYPES)
    c.text('source')
  })

  rows(data, 'taxYearConfig').forEach((row, i) => {
    for (const [field, value] of Object.entries(row)) {
      if (value !== null && typeof value !== 'string') fail('tax year', i, field)
    }
  })

  return data as unknown as ArchiveData
}

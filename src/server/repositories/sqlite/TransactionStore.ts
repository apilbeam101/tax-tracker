import type {
  FxRateType,
  RsuWithholdingMethod,
  Transaction,
  TransactionType,
} from '../../../shared/types.ts'
import type { FieldCipher } from '../../crypto/fields.ts'
import type { Db } from '../../db/database.ts'
import { BadRequestError } from '../../errors.ts'
import type { TransactionStore } from '../index.ts'
import { type ColumnValues, createRowCodec, insertRow, updateRow, writeAudit } from './rowcodec.ts'

const TABLE = 'txn'

interface TxnRow {
  id: number
  tenant_id: number
  instrument_id: number
  txn_type: string
  txn_date: string
  quantity: string
  unit_price_native: string | null
  native_currency: string | null
  fx_rate: string | null
  fx_rate_type: string | null
  fx_rate_source: string | null
  unit_price_gbp: string | null
  total_gbp: string | null
  costs_gbp: string
  net_gbp: string | null
  income_amount_gbp: string | null
  espp_discount_price_native: string | null
  espp_discount_price_gbp: string | null
  rsu_gross_shares_vested: string | null
  rsu_shares_withheld: string | null
  rsu_withholding_rate: string | null
  rsu_withholding_method: string | null
  dividend_gross_gbp: string | null
  dividend_withholding_gbp: string | null
  dividend_net_gbp: string | null
  split_ratio: string | null
  capreturn_per_share_gbp: string | null
  notes: string | null
  import_source: string | null
  created_at: string
  updated_at: string
}

function toTransaction(row: TxnRow): Transaction {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    instrumentId: row.instrument_id,
    txnType: row.txn_type as TransactionType,
    txnDate: row.txn_date,
    quantity: row.quantity,
    unitPriceNative: row.unit_price_native,
    nativeCurrency: row.native_currency,
    fxRate: row.fx_rate,
    fxRateType: row.fx_rate_type as FxRateType | null,
    fxRateSource: row.fx_rate_source,
    unitPriceGbp: row.unit_price_gbp,
    totalGbp: row.total_gbp,
    costsGbp: row.costs_gbp,
    netGbp: row.net_gbp,
    incomeAmountGbp: row.income_amount_gbp,
    esppDiscountPriceNative: row.espp_discount_price_native,
    esppDiscountPriceGbp: row.espp_discount_price_gbp,
    rsuGrossSharesVested: row.rsu_gross_shares_vested,
    rsuSharesWithheld: row.rsu_shares_withheld,
    rsuWithholdingRate: row.rsu_withholding_rate,
    rsuWithholdingMethod: row.rsu_withholding_method as RsuWithholdingMethod | null,
    dividendGrossGbp: row.dividend_gross_gbp,
    dividendWithholdingGbp: row.dividend_withholding_gbp,
    dividendNetGbp: row.dividend_net_gbp,
    splitRatio: row.split_ratio,
    capreturnsPerShareGbp: row.capreturn_per_share_gbp,
    notes: row.notes,
    importSource: row.import_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const DECIMAL_RE = /^\d+(\.\d+)?$/

function validateDecimal(value: string, field: string): void {
  if (!DECIMAL_RE.test(value)) {
    throw new BadRequestError(`Invalid decimal string for ${field}: ${value}`)
  }
}

// Fields an update may change, with their columns. `required` ones cannot be cleared to null: a
// missing value keeps the existing one. The rest are nullable, where `undefined` means "leave
// as is" and `null` means "clear".
const UPDATABLE: ReadonlyArray<{
  field: keyof Transaction
  column: string
  required?: true
}> = [
  { field: 'txnType', column: 'txn_type', required: true },
  { field: 'txnDate', column: 'txn_date', required: true },
  { field: 'quantity', column: 'quantity', required: true },
  { field: 'unitPriceNative', column: 'unit_price_native' },
  { field: 'nativeCurrency', column: 'native_currency' },
  { field: 'fxRate', column: 'fx_rate' },
  { field: 'fxRateType', column: 'fx_rate_type' },
  { field: 'fxRateSource', column: 'fx_rate_source' },
  { field: 'unitPriceGbp', column: 'unit_price_gbp' },
  { field: 'totalGbp', column: 'total_gbp' },
  { field: 'netGbp', column: 'net_gbp' },
  { field: 'costsGbp', column: 'costs_gbp', required: true },
  { field: 'incomeAmountGbp', column: 'income_amount_gbp' },
  { field: 'esppDiscountPriceNative', column: 'espp_discount_price_native' },
  { field: 'esppDiscountPriceGbp', column: 'espp_discount_price_gbp' },
  { field: 'rsuGrossSharesVested', column: 'rsu_gross_shares_vested' },
  { field: 'rsuSharesWithheld', column: 'rsu_shares_withheld' },
  { field: 'rsuWithholdingRate', column: 'rsu_withholding_rate' },
  { field: 'rsuWithholdingMethod', column: 'rsu_withholding_method' },
  { field: 'dividendGrossGbp', column: 'dividend_gross_gbp' },
  { field: 'dividendWithholdingGbp', column: 'dividend_withholding_gbp' },
  { field: 'dividendNetGbp', column: 'dividend_net_gbp' },
  { field: 'splitRatio', column: 'split_ratio' },
  { field: 'capreturnsPerShareGbp', column: 'capreturn_per_share_gbp' },
  { field: 'notes', column: 'notes' },
]

export function createTransactionStore(db: Db, cipher: FieldCipher): TransactionStore {
  const codec = createRowCodec(cipher, TABLE)
  const read = (row: TxnRow) => toTransaction(codec.open(row))

  return {
    list(tenantId, opts = {}) {
      let sql = 'SELECT * FROM txn WHERE tenant_id = ?'
      const params: (number | string)[] = [tenantId]
      if (opts.instrumentId !== undefined) {
        sql += ' AND instrument_id = ?'
        params.push(opts.instrumentId)
      }
      if (opts.from) {
        sql += ' AND txn_date >= ?'
        params.push(opts.from)
      }
      if (opts.to) {
        sql += ' AND txn_date <= ?'
        params.push(opts.to)
      }
      sql += ' ORDER BY txn_date, id'
      return (db.prepare(sql).all(...params) as unknown as TxnRow[]).map(read)
    },

    getById(tenantId, id) {
      const row = db
        .prepare('SELECT * FROM txn WHERE tenant_id = ? AND id = ?')
        .get(tenantId, id) as TxnRow | undefined
      return row ? read(row) : undefined
    },

    create(tenantId, body, userId) {
      validateDecimal(body.quantity, 'quantity')
      if (body.unitPriceNative) validateDecimal(body.unitPriceNative, 'unitPriceNative')
      if (body.costsGbp) validateDecimal(body.costsGbp, 'costsGbp')

      const id = insertRow(db, codec, TABLE, {
        tenant_id: tenantId,
        instrument_id: body.instrumentId,
        txn_type: body.txnType,
        txn_date: body.txnDate,
        quantity: body.quantity,
        unit_price_native: body.unitPriceNative ?? null,
        native_currency: body.nativeCurrency ?? null,
        fx_rate: body.fxRate ?? null,
        fx_rate_type: body.fxRateType ?? null,
        // fx_rate_source is set by FxService after creation
        fx_rate_source: null,
        costs_gbp: body.costsGbp ?? '0',
        income_amount_gbp: body.incomeAmountGbp ?? null,
        espp_discount_price_native: body.esppDiscountPriceNative ?? null,
        // espp_discount_price_gbp is derived by the server after FX
        espp_discount_price_gbp: null,
        rsu_gross_shares_vested: body.rsuGrossSharesVested ?? null,
        rsu_shares_withheld: body.rsuSharesWithheld ?? null,
        rsu_withholding_rate: body.rsuWithholdingRate ?? null,
        rsu_withholding_method: body.rsuWithholdingMethod ?? null,
        dividend_gross_gbp: body.dividendGrossGbp ?? null,
        dividend_withholding_gbp: body.dividendWithholdingGbp ?? null,
        dividend_net_gbp: body.dividendNetGbp ?? null,
        split_ratio: body.splitRatio ?? null,
        capreturn_per_share_gbp: body.capreturnsPerShareGbp ?? null,
        notes: body.notes ?? null,
      })

      writeAudit(db, cipher, {
        tenantId,
        userId,
        action: 'txn.create',
        entityType: 'txn',
        entityId: id,
        newData: body,
      })

      return this.getById(tenantId, id)!
    },

    update(tenantId, id, body, userId) {
      const existing = this.getById(tenantId, id)
      if (!existing) return undefined

      if (body.quantity) validateDecimal(body.quantity, 'quantity')
      if (body.unitPriceNative) validateDecimal(body.unitPriceNative, 'unitPriceNative')
      if (body.costsGbp) validateDecimal(body.costsGbp, 'costsGbp')

      const old = { ...existing }
      const patch = body as Partial<Record<keyof Transaction, unknown>>
      const current = existing as unknown as Record<keyof Transaction, unknown>

      const values: ColumnValues = {}
      for (const { field, column, required } of UPDATABLE) {
        const incoming = patch[field]
        values[column] = (
          required
            ? (incoming ?? current[field])
            : incoming !== undefined
              ? (incoming ?? null)
              : current[field]
        ) as string | null
      }

      updateRow(db, codec, TABLE, id, values, {
        where: 'tenant_id = ?',
        whereParams: [tenantId],
        extraSet: "updated_at = datetime('now')",
      })

      writeAudit(db, cipher, {
        tenantId,
        userId,
        action: 'txn.update',
        entityType: 'txn',
        entityId: id,
        oldData: old,
        newData: body,
      })

      return this.getById(tenantId, id)!
    },

    delete(tenantId, id, userId) {
      const existing = this.getById(tenantId, id)
      if (!existing) return false
      db.prepare('DELETE FROM txn WHERE tenant_id = ? AND id = ?').run(tenantId, id)
      writeAudit(db, cipher, {
        tenantId,
        userId,
        action: 'txn.delete',
        entityType: 'txn',
        entityId: id,
        oldData: existing,
      })
      return true
    },
  }
}

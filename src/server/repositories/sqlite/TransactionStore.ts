import type { Db } from '../../db/database.ts'
import type { TransactionStore } from '../index.ts'
import type {
  Transaction, TransactionType, FxRateType, RsuWithholdingMethod,
  CreateTransactionBody, UpdateTransactionBody,
} from '../../../shared/types.ts'

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
    throw new Error(`Invalid decimal string for ${field}: ${value}`)
  }
}

export function createTransactionStore(db: Db): TransactionStore {
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
      return (db.prepare(sql).all(...params) as unknown as TxnRow[]).map(toTransaction)
    },

    getById(tenantId, id) {
      const row = db.prepare('SELECT * FROM txn WHERE tenant_id = ? AND id = ?').get(tenantId, id) as TxnRow | undefined
      return row ? toTransaction(row) : undefined
    },

    create(tenantId, body, userId) {
      validateDecimal(body.quantity, 'quantity')
      if (body.unitPriceNative) validateDecimal(body.unitPriceNative, 'unitPriceNative')
      if (body.costsGbp) validateDecimal(body.costsGbp, 'costsGbp')

      const result = db.prepare(`
        INSERT INTO txn (
          tenant_id, instrument_id, txn_type, txn_date, quantity,
          unit_price_native, native_currency,
          fx_rate, fx_rate_type, fx_rate_source,
          costs_gbp,
          income_amount_gbp,
          espp_discount_price_native, espp_discount_price_gbp,
          rsu_gross_shares_vested, rsu_shares_withheld, rsu_withholding_rate, rsu_withholding_method,
          dividend_gross_gbp, dividend_withholding_gbp, dividend_net_gbp,
          split_ratio, capreturn_per_share_gbp,
          notes
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        tenantId,
        body.instrumentId,
        body.txnType,
        body.txnDate,
        body.quantity,
        body.unitPriceNative ?? null,
        body.nativeCurrency ?? null,
        body.fxRate ?? null,
        body.fxRateType ?? null,
        null, // fx_rate_source set by FxService after creation
        body.costsGbp ?? '0',
        body.incomeAmountGbp ?? null,
        body.esppDiscountPriceNative ?? null,
        null, // espp_discount_price_gbp derived by server after FX
        body.rsuGrossSharesVested ?? null,
        body.rsuSharesWithheld ?? null,
        body.rsuWithholdingRate ?? null,
        body.rsuWithholdingMethod ?? null,
        body.dividendGrossGbp ?? null,
        body.dividendWithholdingGbp ?? null,
        body.dividendNetGbp ?? null,
        body.splitRatio ?? null,
        body.capreturnsPerShareGbp ?? null,
        body.notes ?? null,
      )
      const id = Number(result.lastInsertRowid)

      db.prepare(`
        INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, new_data)
        VALUES (?, ?, 'txn.create', 'txn', ?, ?)
      `).run(tenantId, userId, id, JSON.stringify(body))

      return this.getById(tenantId, id)!
    },

    update(tenantId, id, body, userId) {
      const existing = this.getById(tenantId, id)
      if (!existing) return undefined

      if (body.quantity) validateDecimal(body.quantity, 'quantity')
      if (body.unitPriceNative) validateDecimal(body.unitPriceNative, 'unitPriceNative')
      if (body.costsGbp) validateDecimal(body.costsGbp, 'costsGbp')

      const old = { ...existing }

      db.prepare(`
        UPDATE txn SET
          txn_type = ?, txn_date = ?, quantity = ?,
          unit_price_native = ?, native_currency = ?,
          fx_rate = ?, fx_rate_type = ?, fx_rate_source = ?,
          unit_price_gbp = ?, total_gbp = ?, net_gbp = ?,
          costs_gbp = ?,
          income_amount_gbp = ?,
          espp_discount_price_native = ?, espp_discount_price_gbp = ?,
          rsu_gross_shares_vested = ?, rsu_shares_withheld = ?,
          rsu_withholding_rate = ?, rsu_withholding_method = ?,
          dividend_gross_gbp = ?, dividend_withholding_gbp = ?, dividend_net_gbp = ?,
          split_ratio = ?, capreturn_per_share_gbp = ?,
          notes = ?,
          updated_at = datetime('now')
        WHERE tenant_id = ? AND id = ?
      `).run(
        body.txnType ?? existing.txnType,
        body.txnDate ?? existing.txnDate,
        body.quantity ?? existing.quantity,
        body.unitPriceNative !== undefined ? (body.unitPriceNative ?? null) : existing.unitPriceNative,
        body.nativeCurrency !== undefined ? (body.nativeCurrency ?? null) : existing.nativeCurrency,
        body.fxRate !== undefined ? (body.fxRate ?? null) : existing.fxRate,
        body.fxRateType !== undefined ? (body.fxRateType ?? null) : existing.fxRateType,
        body.fxRateSource !== undefined ? (body.fxRateSource ?? null) : existing.fxRateSource,
        body.unitPriceGbp !== undefined ? (body.unitPriceGbp ?? null) : existing.unitPriceGbp,
        body.totalGbp !== undefined ? (body.totalGbp ?? null) : existing.totalGbp,
        body.netGbp !== undefined ? (body.netGbp ?? null) : existing.netGbp,
        body.costsGbp ?? existing.costsGbp,
        body.incomeAmountGbp !== undefined ? (body.incomeAmountGbp ?? null) : existing.incomeAmountGbp,
        body.esppDiscountPriceNative !== undefined ? (body.esppDiscountPriceNative ?? null) : existing.esppDiscountPriceNative,
        body.esppDiscountPriceGbp !== undefined ? (body.esppDiscountPriceGbp ?? null) : existing.esppDiscountPriceGbp,
        body.rsuGrossSharesVested !== undefined ? (body.rsuGrossSharesVested ?? null) : existing.rsuGrossSharesVested,
        body.rsuSharesWithheld !== undefined ? (body.rsuSharesWithheld ?? null) : existing.rsuSharesWithheld,
        body.rsuWithholdingRate !== undefined ? (body.rsuWithholdingRate ?? null) : existing.rsuWithholdingRate,
        body.rsuWithholdingMethod !== undefined ? (body.rsuWithholdingMethod ?? null) : existing.rsuWithholdingMethod,
        body.dividendGrossGbp !== undefined ? (body.dividendGrossGbp ?? null) : existing.dividendGrossGbp,
        body.dividendWithholdingGbp !== undefined ? (body.dividendWithholdingGbp ?? null) : existing.dividendWithholdingGbp,
        body.dividendNetGbp !== undefined ? (body.dividendNetGbp ?? null) : existing.dividendNetGbp,
        body.splitRatio !== undefined ? (body.splitRatio ?? null) : existing.splitRatio,
        body.capreturnsPerShareGbp !== undefined ? (body.capreturnsPerShareGbp ?? null) : existing.capreturnsPerShareGbp,
        body.notes !== undefined ? (body.notes ?? null) : existing.notes,
        tenantId,
        id,
      )

      db.prepare(`
        INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
        VALUES (?, ?, 'txn.update', 'txn', ?, ?, ?)
      `).run(tenantId, userId, id, JSON.stringify(old), JSON.stringify(body))

      return this.getById(tenantId, id)!
    },

    delete(tenantId, id, userId) {
      const existing = this.getById(tenantId, id)
      if (!existing) return false
      db.prepare('DELETE FROM txn WHERE tenant_id = ? AND id = ?').run(tenantId, id)
      db.prepare(`
        INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, old_data)
        VALUES (?, ?, 'txn.delete', 'txn', ?, ?)
      `).run(tenantId, userId, id, JSON.stringify(existing))
      return true
    },
  }
}

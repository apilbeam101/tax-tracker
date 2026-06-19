import type { Db } from '../../db/database.ts'
import type { MatchType } from '../../../shared/types.ts'
import type { CgtDisposalRecord } from '../../services/tax/matching.ts'

export interface CgtDisposalStore {
  list(tenantId: number, opts?: { taxYear?: string; instrumentId?: number }): CgtDisposalRecord[]
  upsertForTxn(tenantId: number, disposals: CgtDisposalRecord[]): void
  deleteForInstrument(tenantId: number, instrumentId: number): void
}

interface CgtDisposalRow {
  id: number
  tenant_id: number
  txn_id: number
  instrument_id: number
  disposal_date: string
  tax_year: string
  match_type: string
  acquisition_txn_id: number | null
  quantity: string
  proceeds_gbp: string
  allowable_cost_gbp: string
  selling_costs_gbp: string
  gain_gbp: string
  created_at: string
}

function toRecord(row: CgtDisposalRow): CgtDisposalRecord {
  return {
    txnId: row.txn_id,
    instrumentId: row.instrument_id,
    disposalDate: row.disposal_date,
    taxYear: row.tax_year,
    matchType: row.match_type as MatchType,
    acquisitionTxnId: row.acquisition_txn_id,
    quantity: row.quantity,
    proceedsGbp: row.proceeds_gbp,
    allowableCostGbp: row.allowable_cost_gbp,
    sellingCostsGbp: row.selling_costs_gbp,
    gainGbp: row.gain_gbp,
  }
}

export function createCgtDisposalStore(db: Db): CgtDisposalStore {
  return {
    list(tenantId, opts = {}) {
      let sql = 'SELECT * FROM cgt_disposal WHERE tenant_id = ?'
      const params: (number | string)[] = [tenantId]
      if (opts.taxYear) {
        sql += ' AND tax_year = ?'
        params.push(opts.taxYear)
      }
      if (opts.instrumentId !== undefined) {
        sql += ' AND instrument_id = ?'
        params.push(opts.instrumentId)
      }
      sql += ' ORDER BY disposal_date, id'
      return (db.prepare(sql).all(...params) as unknown as CgtDisposalRow[]).map(toRecord)
    },

    upsertForTxn(tenantId, disposals) {
      // Delete existing disposal records for these txn IDs, then re-insert.
      // This allows the engine to be re-run (idempotent).
      const txnIds = [...new Set(disposals.map(d => d.txnId))]
      if (txnIds.length === 0) return

      const placeholders = txnIds.map(() => '?').join(',')
      const del = db.prepare(
        `DELETE FROM cgt_disposal WHERE tenant_id = ? AND txn_id IN (${placeholders})`
      )

      const insert = db.prepare(`
        INSERT INTO cgt_disposal (
          tenant_id, txn_id, instrument_id, disposal_date, tax_year,
          match_type, acquisition_txn_id,
          quantity, proceeds_gbp, allowable_cost_gbp, selling_costs_gbp, gain_gbp
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `)

      // Atomic: delete old slices and insert new ones in a single transaction
      // so a mid-run crash never leaves the table partially populated.
      db.exec('BEGIN')
      try {
        del.run(tenantId, ...txnIds)
        for (const d of disposals) {
          insert.run(
            tenantId,
            d.txnId,
            d.instrumentId,
            d.disposalDate,
            d.taxYear,
            d.matchType,
            d.acquisitionTxnId ?? null,
            d.quantity,
            d.proceedsGbp,
            d.allowableCostGbp,
            d.sellingCostsGbp,
            d.gainGbp,
          )
        }
        db.exec('COMMIT')
      } catch (err) {
        try { db.exec('ROLLBACK') } catch { /* ignore */ }
        throw err
      }
    },

    deleteForInstrument(tenantId, instrumentId) {
      db.prepare('DELETE FROM cgt_disposal WHERE tenant_id = ? AND instrument_id = ?')
        .run(tenantId, instrumentId)
    },
  }
}

import type { MatchType } from '../../../shared/types.ts'
import type { FieldCipher } from '../../crypto/fields.ts'
import type { Db } from '../../db/database.ts'
import type { CgtDisposalRecord } from '../../services/tax/matching.ts'
import { createRowCodec, insertRow } from './rowcodec.ts'

const TABLE = 'cgt_disposal'

export interface CgtDisposalStore {
  list(
    tenantId: number,
    opts?: { taxYear?: string; instrumentId?: number; from?: string; to?: string },
  ): CgtDisposalRecord[]
  /** Atomically replace all disposal records for an instrument: delete then
   *  re-insert in one transaction, rolling back the delete if the insert fails
   *  (e.g. a disposal date falls outside configured tax years), so a failed
   *  recalc never leaves the instrument with zero disposals. */
  replaceForInstrument(tenantId: number, instrumentId: number, disposals: CgtDisposalRecord[]): void
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

export function createCgtDisposalStore(db: Db, cipher: FieldCipher): CgtDisposalStore {
  const codec = createRowCodec(cipher, TABLE)

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
      if (opts.from) {
        sql += ' AND disposal_date >= ?'
        params.push(opts.from)
      }
      if (opts.to) {
        sql += ' AND disposal_date <= ?'
        params.push(opts.to)
      }
      sql += ' ORDER BY disposal_date, id'
      return (db.prepare(sql).all(...params) as unknown as CgtDisposalRow[]).map((row) =>
        toRecord(codec.open(row)),
      )
    },

    replaceForInstrument(tenantId, instrumentId, disposals) {
      cipher.assertReady()
      const del = db.prepare('DELETE FROM cgt_disposal WHERE tenant_id = ? AND instrument_id = ?')

      db.exec('BEGIN')
      try {
        del.run(tenantId, instrumentId)
        for (const d of disposals) {
          insertRow(db, codec, TABLE, {
            tenant_id: tenantId,
            txn_id: d.txnId,
            instrument_id: d.instrumentId,
            disposal_date: d.disposalDate,
            tax_year: d.taxYear,
            match_type: d.matchType,
            acquisition_txn_id: d.acquisitionTxnId ?? null,
            quantity: d.quantity,
            proceeds_gbp: d.proceedsGbp,
            allowable_cost_gbp: d.allowableCostGbp,
            selling_costs_gbp: d.sellingCostsGbp,
            gain_gbp: d.gainGbp,
          })
        }
        db.exec('COMMIT')
      } catch (err) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* ignore */
        }
        throw err
      }
    },
  }
}

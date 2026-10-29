import type { FieldCipher } from '../../crypto/fields.ts'
import type { Db } from '../../db/database.ts'
import type { VestSchedule, VestScheduleStore } from '../index.ts'
import { createRowCodec, insertRow } from './rowcodec.ts'

const TABLE = 'vest_schedule'

interface VestScheduleRow {
  id: number
  tenant_id: number
  instrument_id: number
  schedule_type: string
  scheduled_date: string
  quantity: string
  expected_price_usd: string | null
  expected_discount_price_native: string | null
  notes: string | null
  realised_txn_id: number | null
  created_at: string
}

function toVestSchedule(row: VestScheduleRow): VestSchedule {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    instrumentId: row.instrument_id,
    scheduleType: row.schedule_type,
    scheduledDate: row.scheduled_date,
    quantity: row.quantity,
    expectedPriceUsd: row.expected_price_usd,
    expectedDiscountPriceNative: row.expected_discount_price_native,
    notes: row.notes,
    realisedTxnId: row.realised_txn_id,
    createdAt: row.created_at,
  }
}

export function createVestScheduleStore(db: Db, cipher: FieldCipher): VestScheduleStore {
  const codec = createRowCodec(cipher, TABLE)
  const read = (row: VestScheduleRow) => toVestSchedule(codec.open(row))

  return {
    list(tenantId, opts = {}) {
      let sql = 'SELECT * FROM vest_schedule WHERE tenant_id = ?'
      const params: (number | string)[] = [tenantId]
      if (opts.instrumentId !== undefined) {
        sql += ' AND instrument_id = ?'
        params.push(opts.instrumentId)
      }
      if (opts.scheduleType) {
        sql += ' AND schedule_type = ?'
        params.push(opts.scheduleType)
      }
      if (opts.from) {
        sql += ' AND scheduled_date >= ?'
        params.push(opts.from)
      }
      if (opts.to) {
        sql += ' AND scheduled_date <= ?'
        params.push(opts.to)
      }
      if (opts.unrealisedOnly) sql += ' AND realised_txn_id IS NULL'
      sql += ' ORDER BY scheduled_date ASC, id ASC'
      return (db.prepare(sql).all(...params) as unknown as VestScheduleRow[]).map(read)
    },

    listAllUnrealised() {
      return (
        db
          .prepare(
            'SELECT * FROM vest_schedule WHERE realised_txn_id IS NULL ORDER BY scheduled_date ASC, id ASC',
          )
          .all() as unknown as VestScheduleRow[]
      ).map(read)
    },

    create(tenantId, body) {
      const id = insertRow(db, codec, TABLE, {
        tenant_id: tenantId,
        instrument_id: body.instrumentId,
        schedule_type: body.scheduleType,
        scheduled_date: body.scheduledDate,
        quantity: body.quantity,
        expected_price_usd: body.expectedPriceUsd ?? null,
        expected_discount_price_native: body.expectedDiscountPriceNative ?? null,
        notes: body.notes ?? null,
      })
      return read(
        db
          .prepare('SELECT * FROM vest_schedule WHERE id = ?')
          .get(id) as unknown as VestScheduleRow,
      )
    },

    delete(tenantId, id) {
      cipher.assertReady()
      return (
        db.prepare('DELETE FROM vest_schedule WHERE tenant_id = ? AND id = ?').run(tenantId, id)
          .changes > 0
      )
    },

    setRealisedTxn(tenantId, id, txnId) {
      cipher.assertReady()
      db.prepare('UPDATE vest_schedule SET realised_txn_id = ? WHERE tenant_id = ? AND id = ?').run(
        txnId,
        tenantId,
        id,
      )
    },

    clearRealisedTxn(tenantId, txnId) {
      cipher.assertReady()
      db.prepare(
        'UPDATE vest_schedule SET realised_txn_id = NULL WHERE tenant_id = ? AND realised_txn_id = ?',
      ).run(tenantId, txnId)
    },

    linkedTxnIds(tenantId) {
      const rows = db
        .prepare(
          'SELECT realised_txn_id AS id FROM vest_schedule WHERE tenant_id = ? AND realised_txn_id IS NOT NULL',
        )
        .all(tenantId) as unknown as Array<{ id: number }>
      return new Set(rows.map((r) => r.id))
    },
  }
}

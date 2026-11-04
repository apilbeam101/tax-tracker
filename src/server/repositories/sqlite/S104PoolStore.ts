import type { FieldCipher } from '../../crypto/fields.ts'
import type { Db } from '../../db/database.ts'
import type { S104PoolState } from '../../services/tax/pool.ts'
import { createRowCodec, insertRow, updateRow } from './rowcodec.ts'

const TABLE = 's104_pool'

export interface S104PoolStore {
  get(tenantId: number, instrumentId: number): S104PoolState
  save(tenantId: number, instrumentId: number, pool: S104PoolState): void
}

interface PoolRow {
  id: number
  pool_quantity: string
  pool_cost_gbp: string
}

export function createS104PoolStore(db: Db, cipher: FieldCipher): S104PoolStore {
  const codec = createRowCodec(cipher, TABLE)

  function find(tenantId: number, instrumentId: number): PoolRow | undefined {
    return db
      .prepare(
        'SELECT id, pool_quantity, pool_cost_gbp FROM s104_pool WHERE tenant_id = ? AND instrument_id = ?',
      )
      .get(tenantId, instrumentId) as PoolRow | undefined
  }

  return {
    get(tenantId, instrumentId) {
      const row = find(tenantId, instrumentId)
      if (!row) return { quantity: '0', costGbp: '0' }
      const opened = codec.open(row)
      return { quantity: opened.pool_quantity, costGbp: opened.pool_cost_gbp }
    },

    // The row id is bound into the ciphertext, so an upsert has to find the existing row rather
    // than replace it (which would assign a new id and orphan the old values' associated data).
    save(tenantId, instrumentId, pool) {
      const values = { pool_quantity: pool.quantity, pool_cost_gbp: pool.costGbp }
      const existing = find(tenantId, instrumentId)
      if (existing) {
        updateRow(db, codec, TABLE, existing.id, values, {
          extraSet: "last_updated = datetime('now')",
        })
      } else {
        insertRow(db, codec, TABLE, {
          tenant_id: tenantId,
          instrument_id: instrumentId,
          ...values,
        })
      }
    },
  }
}

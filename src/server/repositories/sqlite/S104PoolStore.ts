import type { Db } from '../../db/database.ts'
import type { S104PoolState } from '../../services/tax/pool.ts'

export interface S104PoolStore {
  get(tenantId: number, instrumentId: number): S104PoolState
  save(tenantId: number, instrumentId: number, pool: S104PoolState): void
}

interface PoolRow {
  pool_quantity: string
  pool_cost_gbp: string
}

export function createS104PoolStore(db: Db): S104PoolStore {
  return {
    get(tenantId, instrumentId) {
      const row = db
        .prepare(
          'SELECT pool_quantity, pool_cost_gbp FROM s104_pool WHERE tenant_id = ? AND instrument_id = ?',
        )
        .get(tenantId, instrumentId) as PoolRow | undefined

      if (!row) return { quantity: '0', costGbp: '0' }
      return { quantity: row.pool_quantity, costGbp: row.pool_cost_gbp }
    },

    save(tenantId, instrumentId, pool) {
      db.prepare(`
        INSERT INTO s104_pool (tenant_id, instrument_id, pool_quantity, pool_cost_gbp, last_updated)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(tenant_id, instrument_id) DO UPDATE SET
          pool_quantity = excluded.pool_quantity,
          pool_cost_gbp = excluded.pool_cost_gbp,
          last_updated  = excluded.last_updated
      `).run(tenantId, instrumentId, pool.quantity, pool.costGbp)
    },
  }
}

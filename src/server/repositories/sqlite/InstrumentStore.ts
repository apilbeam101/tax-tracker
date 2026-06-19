import type { Db } from '../../db/database.ts'
import type { InstrumentStore } from '../index.ts'
import type {
  Instrument, InstrumentType, RsuWithholdingMethod,
  CreateInstrumentBody, UpdateInstrumentBody,
} from '../../../shared/types.ts'

interface InstrumentRow {
  id: number
  tenant_id: number
  ticker: string
  isin: string | null
  name: string
  currency: string
  exchange: string | null
  instrument_type: string
  is_employer_stock: number
  rsu_withholding_method: string
  notes: string | null
  created_at: string
}

function toInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ticker: row.ticker,
    isin: row.isin,
    name: row.name,
    currency: row.currency,
    exchange: row.exchange,
    instrumentType: row.instrument_type as InstrumentType,
    isEmployerStock: row.is_employer_stock === 1,
    rsuWithholdingMethod: row.rsu_withholding_method as RsuWithholdingMethod,
    notes: row.notes,
    createdAt: row.created_at,
  }
}

export function createInstrumentStore(db: Db): InstrumentStore {
  return {
    list(tenantId) {
      return (db.prepare('SELECT * FROM instrument WHERE tenant_id = ? ORDER BY ticker').all(tenantId) as unknown as InstrumentRow[])
        .map(toInstrument)
    },

    getById(tenantId, id) {
      const row = db.prepare('SELECT * FROM instrument WHERE tenant_id = ? AND id = ?').get(tenantId, id) as InstrumentRow | undefined
      return row ? toInstrument(row) : undefined
    },

    getByTicker(tenantId, ticker) {
      const row = db.prepare('SELECT * FROM instrument WHERE tenant_id = ? AND ticker = ?').get(tenantId, ticker) as InstrumentRow | undefined
      return row ? toInstrument(row) : undefined
    },

    create(tenantId, body, userId) {
      const result = db.prepare(`
        INSERT INTO instrument (tenant_id, ticker, isin, name, currency, exchange, instrument_type, is_employer_stock, rsu_withholding_method, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tenantId,
        body.ticker,
        body.isin ?? null,
        body.name,
        body.currency,
        body.exchange ?? null,
        body.instrumentType ?? 'equity',
        body.isEmployerStock ? 1 : 0,
        body.rsuWithholdingMethod ?? 'net-settlement',
        body.notes ?? null,
      )
      const id = Number(result.lastInsertRowid)
      db.prepare(`
        INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, new_data)
        VALUES (?, ?, 'instrument.create', 'instrument', ?, ?)
      `).run(tenantId, userId, id, JSON.stringify(body))
      return this.getById(tenantId, id)!
    },

    update(tenantId, id, body, userId) {
      const existing = this.getById(tenantId, id)
      if (!existing) return undefined
      const old = { ...existing }
      db.prepare(`
        UPDATE instrument SET
          ticker = ?, isin = ?, name = ?, currency = ?, exchange = ?,
          instrument_type = ?, is_employer_stock = ?, rsu_withholding_method = ?, notes = ?
        WHERE tenant_id = ? AND id = ?
      `).run(
        body.ticker ?? existing.ticker,
        body.isin !== undefined ? body.isin ?? null : existing.isin,
        body.name ?? existing.name,
        body.currency ?? existing.currency,
        body.exchange !== undefined ? body.exchange ?? null : existing.exchange,
        body.instrumentType ?? existing.instrumentType,
        body.isEmployerStock !== undefined ? (body.isEmployerStock ? 1 : 0) : (existing.isEmployerStock ? 1 : 0),
        body.rsuWithholdingMethod ?? existing.rsuWithholdingMethod,
        body.notes !== undefined ? body.notes ?? null : existing.notes,
        tenantId,
        id,
      )
      db.prepare(`
        INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data)
        VALUES (?, ?, 'instrument.update', 'instrument', ?, ?, ?)
      `).run(tenantId, userId, id, JSON.stringify(old), JSON.stringify(body))
      return this.getById(tenantId, id)!
    },

    delete(tenantId, id, userId) {
      const existing = this.getById(tenantId, id)
      if (!existing) return false
      db.prepare('DELETE FROM instrument WHERE tenant_id = ? AND id = ?').run(tenantId, id)
      db.prepare(`
        INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, old_data)
        VALUES (?, ?, 'instrument.delete', 'instrument', ?, ?)
      `).run(tenantId, userId, id, JSON.stringify(existing))
      return true
    },
  }
}

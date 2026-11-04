import type { Instrument, InstrumentType, RsuWithholdingMethod } from '../../../shared/types.ts'
import type { FieldCipher } from '../../crypto/fields.ts'
import type { Db } from '../../db/database.ts'
import type { InstrumentStore } from '../index.ts'
import { createRowCodec, insertRow, updateRow, writeAudit } from './rowcodec.ts'

const TABLE = 'instrument'

interface InstrumentRow {
  id: number
  tenant_id: number
  ticker: string
  isin: string | null
  name: string
  currency: string
  exchange: string | null
  instrument_type: string
  // 0/1 while the database is not encrypting, '0'/'1' once it is
  is_employer_stock: number | string
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
    isEmployerStock: Number(row.is_employer_stock) === 1,
    rsuWithholdingMethod: row.rsu_withholding_method as RsuWithholdingMethod,
    notes: row.notes,
    createdAt: row.created_at,
  }
}

export function createInstrumentStore(db: Db, cipher: FieldCipher): InstrumentStore {
  const codec = createRowCodec(cipher, TABLE)
  const read = (row: InstrumentRow) => toInstrument(codec.open(row))

  return {
    list(tenantId) {
      // Tickers are encrypted, so the ordering the database used to do has to happen here.
      return (
        db
          .prepare('SELECT * FROM instrument WHERE tenant_id = ?')
          .all(tenantId) as unknown as InstrumentRow[]
      )
        .map(read)
        .sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0))
    },

    getById(tenantId, id) {
      const row = db
        .prepare('SELECT * FROM instrument WHERE tenant_id = ? AND id = ?')
        .get(tenantId, id) as InstrumentRow | undefined
      return row ? read(row) : undefined
    },

    getByTicker(tenantId, ticker) {
      const bidx = cipher.blindIndex(TABLE, 'ticker', tenantId, ticker)
      const row = (
        bidx === null
          ? db
              .prepare('SELECT * FROM instrument WHERE tenant_id = ? AND ticker = ?')
              .get(tenantId, ticker)
          : db
              .prepare('SELECT * FROM instrument WHERE tenant_id = ? AND ticker_bidx = ?')
              .get(tenantId, bidx)
      ) as InstrumentRow | undefined
      return row ? read(row) : undefined
    },

    create(tenantId, body, userId) {
      const id = insertRow(db, codec, TABLE, {
        tenant_id: tenantId,
        ticker: body.ticker,
        ticker_bidx: cipher.blindIndex(TABLE, 'ticker', tenantId, body.ticker),
        isin: body.isin ?? null,
        name: body.name,
        currency: body.currency,
        exchange: body.exchange ?? null,
        instrument_type: body.instrumentType ?? 'equity',
        is_employer_stock: body.isEmployerStock ? 1 : 0,
        rsu_withholding_method: body.rsuWithholdingMethod ?? 'net-settlement',
        notes: body.notes ?? null,
      })
      writeAudit(db, cipher, {
        tenantId,
        userId,
        action: 'instrument.create',
        entityType: 'instrument',
        entityId: id,
        newData: body,
      })
      return this.getById(tenantId, id)!
    },

    update(tenantId, id, body, userId) {
      const existing = this.getById(tenantId, id)
      if (!existing) return undefined
      const old = { ...existing }
      const ticker = body.ticker ?? existing.ticker
      updateRow(
        db,
        codec,
        TABLE,
        id,
        {
          ticker,
          ticker_bidx: cipher.blindIndex(TABLE, 'ticker', tenantId, ticker),
          isin: body.isin !== undefined ? (body.isin ?? null) : existing.isin,
          name: body.name ?? existing.name,
          currency: body.currency ?? existing.currency,
          exchange: body.exchange !== undefined ? (body.exchange ?? null) : existing.exchange,
          instrument_type: body.instrumentType ?? existing.instrumentType,
          is_employer_stock: (
            body.isEmployerStock !== undefined
              ? body.isEmployerStock
              : existing.isEmployerStock
          )
            ? 1
            : 0,
          rsu_withholding_method: body.rsuWithholdingMethod ?? existing.rsuWithholdingMethod,
          notes: body.notes !== undefined ? (body.notes ?? null) : existing.notes,
        },
        { where: 'tenant_id = ?', whereParams: [tenantId] },
      )
      writeAudit(db, cipher, {
        tenantId,
        userId,
        action: 'instrument.update',
        entityType: 'instrument',
        entityId: id,
        oldData: old,
        newData: body,
      })
      return this.getById(tenantId, id)!
    },

    delete(tenantId, id, userId) {
      const existing = this.getById(tenantId, id)
      if (!existing) return false
      db.prepare('DELETE FROM instrument WHERE tenant_id = ? AND id = ?').run(tenantId, id)
      writeAudit(db, cipher, {
        tenantId,
        userId,
        action: 'instrument.delete',
        entityType: 'instrument',
        entityId: id,
        oldData: existing,
      })
      return true
    },
  }
}

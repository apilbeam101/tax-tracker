import { encryptedColumns, type FieldCipher, type StoredValue } from '../../crypto/fields.ts'
import type { Db } from '../../db/database.ts'

export type ColumnValues = Record<string, StoredValue>

export interface RowCodec {
  /** Seals the encrypted columns present in `values` for the given row. */
  seal(rowId: number, values: ColumnValues): ColumnValues
  /** Opens the encrypted columns of a row read from the table (the row must carry its `id`). */
  open<T extends object>(row: T): T
}

// Applies the field registry to one table's rows. Stores deal in plaintext domain objects; this is
// the single place where their encrypted columns are turned into ciphertext and back.
export function createRowCodec(cipher: FieldCipher, table: string): RowCodec {
  const columns = encryptedColumns(table)
  return {
    seal(rowId, values) {
      const out: ColumnValues = { ...values }
      for (const column of columns) {
        if (column in out) out[column] = cipher.seal(table, column, rowId, out[column] ?? null)
      }
      return out
    },
    open<T extends object>(row: T): T {
      const record = { ...row } as Record<string, unknown>
      const rowId = Number(record.id)
      for (const column of columns) {
        if (column in record) {
          record[column] = cipher.open(table, column, rowId, record[column] as StoredValue)
        }
      }
      return record as T
    },
  }
}

// The row id is part of every ciphertext's associated data, so it has to be known before the row
// is written. This reproduces what AUTOINCREMENT would assign (never reusing a deleted id). Within
// this process nothing can insert between this call and the INSERT that uses the id (node:sqlite
// is synchronous); insertRow() takes a write lock so another connection cannot either.
export function allocateId(db: Db, table: string): number {
  const sequence = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table) as
    | { seq: number }
    | undefined
  const highest = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM ${table}`).get() as {
    id: number
  }
  return Math.max(sequence?.seq ?? 0, highest.id) + 1
}

export function insertRow(db: Db, codec: RowCodec, table: string, values: ColumnValues): number {
  // Inside a caller's transaction the lock is already held; otherwise take it so the id stays
  // free between allocation and insert even if another connection (a script) is writing.
  const ownsTransaction = !db.isTransaction
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE')
  try {
    const id = allocateId(db, table)
    const sealed = codec.seal(id, values)
    const names = ['id', ...Object.keys(sealed)]
    db.prepare(
      `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    ).run(id, ...Object.values(sealed))
    if (ownsTransaction) db.exec('COMMIT')
    return id
  } catch (err) {
    if (ownsTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore secondary rollback failure */
      }
    }
    throw err
  }
}

export function updateRow(
  db: Db,
  codec: RowCodec,
  table: string,
  id: number,
  values: ColumnValues,
  options: { where?: string; whereParams?: StoredValue[]; extraSet?: string } = {},
): void {
  const sealed = codec.seal(id, values)
  const assignments = Object.keys(sealed).map((name) => `${name} = ?`)
  if (options.extraSet) assignments.push(options.extraSet)
  db.prepare(
    `UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ?${options.where ? ` AND ${options.where}` : ''}`,
  ).run(...Object.values(sealed), id, ...(options.whereParams ?? []))
}

export interface AuditEntry {
  tenantId: number
  userId: number | null
  action: string
  entityType: string
  entityId: number | null
  oldData?: unknown
  newData?: unknown
  ipAddress?: string | null
}

// Audit entries carry whole before/after snapshots, so they are encrypted like the rows they
// describe; only the action, entity and timestamps stay readable.
export function writeAudit(db: Db, cipher: FieldCipher, entry: AuditEntry): void {
  const codec = createRowCodec(cipher, 'audit_log')
  insertRow(db, codec, 'audit_log', {
    tenant_id: entry.tenantId,
    user_id: entry.userId,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    old_data: entry.oldData === undefined ? null : JSON.stringify(entry.oldData),
    new_data: entry.newData === undefined ? null : JSON.stringify(entry.newData),
    ip_address: entry.ipAddress ?? null,
  })
}

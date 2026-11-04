import type { FieldCipher } from '../../crypto/fields.ts'
import type { Db } from '../../db/database.ts'
import { ConflictError } from '../../errors.ts'
import type { AppSecretStore } from '../index.ts'
import { createRowCodec, insertRow, updateRow } from './rowcodec.ts'

const TABLE = 'app_secret'

interface AppSecretRow {
  id: number
  value: string
}

// API keys entered through the UI. The value is always encrypted; this store refuses to run
// against a database that is not encrypting, so a key can never be written in the clear.
export function createAppSecretStore(db: Db, cipher: FieldCipher): AppSecretStore {
  const codec = createRowCodec(cipher, TABLE)

  function requireEncrypting(): void {
    if (!cipher.encrypting) {
      throw new ConflictError('Secrets can only be stored in an encrypted database')
    }
  }

  function find(tenantId: number, name: string): AppSecretRow | undefined {
    return db
      .prepare('SELECT id, value FROM app_secret WHERE tenant_id = ? AND name = ?')
      .get(tenantId, name) as AppSecretRow | undefined
  }

  return {
    get(tenantId, name) {
      const row = find(tenantId, name)
      return row ? (codec.open(row).value as string) : undefined
    },

    set(tenantId, name, value) {
      requireEncrypting()
      const existing = find(tenantId, name)
      if (existing) {
        updateRow(
          db,
          codec,
          TABLE,
          existing.id,
          { value },
          { extraSet: "updated_at = datetime('now')" },
        )
      } else {
        insertRow(db, codec, TABLE, { tenant_id: tenantId, name, value })
      }
    },

    delete(tenantId, name) {
      cipher.assertReady()
      return (
        db.prepare('DELETE FROM app_secret WHERE tenant_id = ? AND name = ?').run(tenantId, name)
          .changes > 0
      )
    },

    names(tenantId) {
      return (
        db
          .prepare('SELECT name FROM app_secret WHERE tenant_id = ? ORDER BY name')
          .all(tenantId) as unknown as Array<{ name: string }>
      ).map((r) => r.name)
    },
  }
}

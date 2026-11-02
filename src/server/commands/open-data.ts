import type { DatabaseSync } from 'node:sqlite'
import { createFieldCipher } from '../crypto/fields.ts'
import { Keyring } from '../crypto/keyring.ts'
import { isEncryptedDatabase } from '../crypto/keyslots.ts'
import { listMigrationFiles } from '../db/migration-files.ts'
import { createCgtDisposalStore } from '../repositories/sqlite/CgtDisposalStore.ts'
import { createFxRateStore } from '../repositories/sqlite/FxRateStore.ts'
import { createInstrumentStore } from '../repositories/sqlite/InstrumentStore.ts'
import { createPriceStore } from '../repositories/sqlite/PriceStore.ts'
import { createS104PoolStore } from '../repositories/sqlite/S104PoolStore.ts'
import { createTransactionStore } from '../repositories/sqlite/TransactionStore.ts'
import { createVestScheduleStore } from '../repositories/sqlite/VestScheduleStore.ts'
import type { ArchiveStores } from '../services/backup/archive.ts'
import type { RecalcDeps } from '../services/tax/recalc.ts'
import { type PassphraseSource, unlockDatabase } from './keys.ts'
import { CliError, dataPaths, openExistingDb } from './util.ts'

export interface DataContext {
  db: DatabaseSync
  dataDir: string
  stores: ArchiveStores
  recalc: RecalcDeps
  userId: number
  close(): void
}

// Opens the database the way the server does once it is unlocked, for commands that read or write
// decrypted values. A protected database asks for the passphrase; the key lives only in this
// process's keyring and is wiped on close. Never migrates: a database behind this version has to
// be opened by the app first.
export async function openData(
  env: NodeJS.ProcessEnv,
  passphrase: PassphraseSource,
): Promise<DataContext> {
  const { dbPath, dataDir } = dataPaths(env)
  const db = openExistingDb(dbPath)
  // As the server opens it: relations are enforced and deleted rows are overwritten, not left in
  // free pages (an import in replace mode deletes the old portfolio).
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA secure_delete = ON')
  const keyring = new Keyring({ protected: false })
  try {
    const applied = new Set(
      (db.prepare('SELECT filename FROM _migrations').all() as Array<{ filename: string }>).map(
        (m) => m.filename,
      ),
    )
    if (listMigrationFiles().some((f) => !applied.has(f))) {
      throw new CliError(
        'The database needs updating. Start the app once to apply updates, then retry.',
      )
    }

    if (isEncryptedDatabase(db)) {
      const dek = await unlockDatabase(db, await passphrase())
      if (!dek) throw new CliError('That passphrase or recovery key does not open this database.')
      const unlocked = new Keyring({ protected: true })
      unlocked.unlock(dek)
      return build(db, dataDir, unlocked)
    }
    return build(db, dataDir, keyring)
  } catch (err) {
    db.close()
    throw err
  }
}

function build(db: DatabaseSync, dataDir: string, keyring: Keyring): DataContext {
  const user = db.prepare('SELECT id FROM "user" WHERE tenant_id = 1 ORDER BY id LIMIT 1').get() as
    | { id: number }
    | undefined
  if (!user) {
    keyring.destroy()
    throw new CliError('No account exists yet. Open the app and complete setup first.')
  }
  const cipher = createFieldCipher(keyring)
  const instruments = createInstrumentStore(db, cipher)
  const transactions = createTransactionStore(db, cipher)
  const cgtDisposals = createCgtDisposalStore(db, cipher)
  const s104Pools = createS104PoolStore(db, cipher)
  return {
    db,
    dataDir,
    userId: user.id,
    stores: {
      db,
      instruments,
      transactions,
      vestSchedules: createVestScheduleStore(db, cipher),
      prices: createPriceStore(db, cipher),
      fxRates: createFxRateStore(db),
    },
    recalc: {
      db,
      instruments,
      transactions,
      cgtDisposals,
      s104Pools,
      log: { warn: (details, message) => console.warn(message, details) },
    },
    close() {
      keyring.destroy()
      db.close()
    },
  }
}

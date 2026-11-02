import Big from 'big.js'
import { isEncryptedDatabase } from '../crypto/keyslots.ts'
import { createFxRateStore } from '../repositories/sqlite/FxRateStore.ts'
import { createFxService } from '../services/fx/index.ts'
import { CliError, dataPaths, errorMessage, openExistingDb, settingsWithFile } from './util.ts'

interface TxnRow {
  id: number
  txn_type: string
  txn_date: string
  quantity: string
  unit_price_native: string
  native_currency: string
  costs_gbp: string
}

const BUY_TYPES = ['BUY', 'RSU_VEST', 'ESPP_PURCHASE', 'TRANSFER_IN', 'RIGHTS_ISSUE', 'DRIP']

// Reads and writes the txn columns directly, with no way to unlock the database, so against an
// encrypted one it would write plaintext into encrypted columns and leave rows the app can no
// longer read.
function assertNotEncrypted(db: ReturnType<typeof openExistingDb>): void {
  if (isEncryptedDatabase(db)) {
    throw new CliError(
      'backfill-fx cannot run against an encrypted database: it has no way to unlock it. Use the application (Import / Export page) instead.',
    )
  }
}

export interface BackfillResult {
  updated: number
  failed: number
}

// Fills the GBP fields of imported transactions that only carry a native price. Safe to re-run: it
// skips rows that already have unit_price_gbp. Run the tax engine afterwards (Tax Summary page).
export async function runBackfillFx(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
): Promise<BackfillResult> {
  const { dbPath, dataDir } = dataPaths(env)
  const policy = settingsWithFile(env, dataDir).FX_RATE_POLICY ?? 'hmrc-monthly'
  if (policy !== 'hmrc-monthly' && policy !== 'daily-spot') {
    throw new CliError(`FX_RATE_POLICY must be hmrc-monthly or daily-spot, got: ${policy}`)
  }

  const db = openExistingDb(dbPath)
  try {
    assertNotEncrypted(db)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    const fx = createFxService(createFxRateStore(db), policy)

    const rows = db
      .prepare(`
        SELECT id, txn_type, txn_date, quantity, unit_price_native, native_currency, costs_gbp
        FROM txn
        WHERE unit_price_gbp IS NULL
          AND unit_price_native IS NOT NULL
          AND native_currency IS NOT NULL
        ORDER BY txn_date, id
      `)
      .all() as unknown as TxnRow[]

    if (rows.length === 0) {
      log('No rows to backfill: all transactions already have unit_price_gbp.')
      return { updated: 0, failed: 0 }
    }
    log(`Backfilling ${rows.length} transactions...`)

    let updated = 0
    let failed = 0
    for (const row of rows) {
      try {
        const fxResult = await fx.convert(
          row.unit_price_native,
          row.native_currency,
          'GBP',
          row.txn_date,
        )
        const unitPriceGbp = fxResult.gbp
        const totalGbp = new Big(row.quantity).times(unitPriceGbp).toFixed(8)
        const costsGbp = new Big(row.costs_gbp ?? '0')
        const netGbp = BUY_TYPES.includes(row.txn_type)
          ? new Big(totalGbp).plus(costsGbp).neg().toFixed(8)
          : new Big(totalGbp).minus(costsGbp).toFixed(8)

        // Each update takes the write lock and re-checks, so an encryption started while this
        // waits on exchange rates cannot be followed by plaintext writes.
        db.exec('BEGIN IMMEDIATE')
        assertNotEncrypted(db)
        db.prepare(`
          UPDATE txn SET
            fx_rate        = ?,
            fx_rate_type   = ?,
            fx_rate_source = ?,
            unit_price_gbp = ?,
            total_gbp      = ?,
            net_gbp        = ?,
            updated_at     = datetime('now')
          WHERE id = ?
        `).run(
          fxResult.rate.rate,
          fxResult.rate.rateType,
          fxResult.rate.source,
          new Big(unitPriceGbp).toFixed(8),
          totalGbp,
          netGbp,
          row.id,
        )
        db.exec('COMMIT')
        updated++
      } catch (err) {
        if (db.isTransaction) db.exec('ROLLBACK')
        if (err instanceof CliError) throw err
        log(`txn #${row.id} (${row.txn_date}): ${errorMessage(err)}`)
        failed++
      }
    }
    log(`Done. ${updated} updated, ${failed} failed.`)
    return { updated, failed }
  } finally {
    db.close()
  }
}

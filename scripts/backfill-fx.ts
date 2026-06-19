/**
 * One-shot FX backfill for imported transactions.
 *
 * Iterates all txn rows where unit_price_gbp IS NULL and unit_price_native IS NOT NULL,
 * calls FxService to get the rate for each transaction's date and currency,
 * then writes back fx_rate, fx_rate_type, fx_rate_source, unit_price_gbp,
 * total_gbp, and net_gbp.
 *
 * Usage:
 *   node --env-file=.env --import tsx/esm scripts/backfill-fx.ts
 *
 * Safe to re-run: it skips rows that already have unit_price_gbp populated.
 * After completing, run the tax engine to compute disposals:
 *   POST /api/tax/run  (or use the Tax Summary page)
 */

import { DatabaseSync } from 'node:sqlite'
import Big from 'big.js'
import { createFxRateStore } from '../src/server/repositories/sqlite/FxRateStore.ts'
import { createFxService } from '../src/server/services/fx/index.ts'

// ── Config ───────────────────────────────────────────────────────────────────

const DB_PATH = process.env['DB_PATH'] ?? './data/taxtracker.db'
const FX_POLICY = (process.env['FX_RATE_POLICY'] ?? 'hmrc-monthly') as 'hmrc-monthly' | 'daily-spot'

// ── Types for raw DB rows ─────────────────────────────────────────────────────

interface TxnRow {
  id: number
  txn_type: string
  txn_date: string
  quantity: string
  unit_price_native: string
  native_currency: string
  costs_gbp: string
}

// ── Main ─────────────────────────────────────────────────────────────────────

const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

const fxStore = createFxRateStore(db)
const fx = createFxService(fxStore, FX_POLICY)

const rows = db.prepare(`
  SELECT id, txn_type, txn_date, quantity, unit_price_native, native_currency, costs_gbp
  FROM txn
  WHERE unit_price_gbp IS NULL
    AND unit_price_native IS NOT NULL
    AND native_currency IS NOT NULL
  ORDER BY txn_date, id
`).all() as TxnRow[]

if (rows.length === 0) {
  console.log('No rows to backfill — all transactions already have unit_price_gbp.')
  process.exit(0)
}

console.log(`Backfilling ${rows.length} transactions…`)

const BUY_TYPES = ['BUY', 'RSU_VEST', 'ESPP_PURCHASE', 'TRANSFER_IN', 'RIGHTS_ISSUE', 'DRIP']
let ok = 0
let failed = 0

for (const row of rows) {
  try {
    const fxResult = await fx.convert(row.unit_price_native, row.native_currency, 'GBP', row.txn_date)
    const unitPriceGbp = fxResult.gbp
    const totalGbp = new Big(row.quantity).times(unitPriceGbp).toFixed(8)
    const costsGbp = new Big(row.costs_gbp ?? '0')
    const isBuy = BUY_TYPES.includes(row.txn_type)
    const netGbp = isBuy
      ? new Big(totalGbp).plus(costsGbp).neg().toFixed(8)
      : new Big(totalGbp).minus(costsGbp).toFixed(8)

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

    ok++
    if (ok % 10 === 0) process.stdout.write(`.`)
  } catch (err) {
    console.error(`\n  ✗ txn #${row.id} (${row.txn_date}): ${(err as Error).message}`)
    failed++
  }
}

console.log(`\nDone. ${ok} updated, ${failed} failed.`)
if (failed > 0) {
  console.error(`Some rows failed — check the error messages above.`)
  process.exit(1)
}

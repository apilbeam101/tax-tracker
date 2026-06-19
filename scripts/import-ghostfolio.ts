/**
 * One-shot import of a Ghostfolio JSON export into the taxtracker database.
 *
 * Usage:
 *   node --env-file=.env --import tsx/esm scripts/import-ghostfolio.ts data/ghostfolio-export-*.json
 *
 * What it does:
 *   1. Reads the JSON file passed as the first CLI argument.
 *   2. Creates an instrument record for each unique symbol (if not already present).
 *   3. Maps each activity to the correct txn_type using the tag names:
 *        tag "RSU"  → RSU_VEST      (BUY with RSU tag)
 *        tag "ESPP" → ESPP_PURCHASE (BUY with ESPP tag)
 *        tag "DIV"  → DRIP          (BUY with DIV tag = dividend reinvestment shares)
 *        type DIVIDEND              → DIV_PAY (cash dividend payment)
 *        type BUY (no tag)          → BUY
 *        type SELL                  → SELL
 *   4. Dates: ISO timestamps are truncated to YYYY-MM-DD in UTC.
 *      Activities at T23:00:00Z are typically midnight BST (next day UK) —
 *      these are flagged in the notes column so you can review them.
 *   5. Fees: stored as a note rather than costsGbp because the fee is in USD,
 *      not GBP. Review flagged rows and enter the GBP equivalent manually.
 *   6. GBP fields (unit_price_gbp, total_gbp, net_gbp, fx_rate) are NOT computed
 *      here. Run a recalculation pass (Phase 3 tooling) to populate them via FxService.
 *   7. import_source is set to "ghostfolio" on every row for traceability.
 */

import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Types ────────────────────────────────────────────────────────────────────

interface GhostfolioActivity {
  accountId: string
  comment: string | null
  fee: number
  quantity: number
  type: 'BUY' | 'SELL' | 'DIVIDEND' | 'ITEM' | 'FEE' | 'INTEREST' | 'LIABILITY'
  unitPrice: number
  currency: string
  dataSource: string
  date: string
  symbol: string
  tags: string[]
}

interface GhostfolioTag {
  id: string
  name: string
}

interface GhostfolioExport {
  meta: { date: string; version: string }
  tags: GhostfolioTag[]
  activities: GhostfolioActivity[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoToDate(iso: string): { date: string; lateNightUtc: boolean } {
  const d = new Date(iso)
  const date = d.toISOString().slice(0, 10)
  // T23:xx UTC = midnight or 1am BST = could be next calendar day in UK
  const lateNightUtc = d.getUTCHours() >= 22
  return { date, lateNightUtc }
}

function toDecimalString(n: number): string {
  // Convert JS float to a plain decimal string, removing scientific notation.
  // big.js won't accept scientific notation.
  return n.toFixed(6).replace(/\.?0+$/, '') || '0'
}

// ── Main ──────────────────────────────────────────────────────────────────────

const filePath = process.argv[2]
if (!filePath) {
  console.error('Usage: import-ghostfolio.ts <path-to-ghostfolio-export.json>')
  process.exit(1)
}

const raw = JSON.parse(readFileSync(resolve(filePath), 'utf-8')) as GhostfolioExport

// Build tag-id → tag-name map
const tagMap = new Map<string, string>(raw.tags.map(t => [t.id, t.name.trim()]))

const dbPath = process.env['DB_PATH'] ?? resolve(__dirname, '../data/taxtracker.db')
console.log(`Opening database: ${dbPath}`)
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = ON')

const TENANT_ID = 1
const USER_ID   = 1  // admin user created during setup

// Ensure instrument exists, return its id
function ensureInstrument(symbol: string, currency: string): number {
  const existing = db.prepare('SELECT id FROM instrument WHERE tenant_id = ? AND ticker = ?').get(TENANT_ID, symbol) as { id: number } | undefined
  if (existing) return existing.id

  const result = db.prepare(`
    INSERT INTO instrument (tenant_id, ticker, name, currency, instrument_type, is_employer_stock, rsu_withholding_method)
    VALUES (?, ?, ?, ?, 'equity', 1, 'net-settlement')
  `).run(TENANT_ID, symbol, symbol, currency)
  console.log(`  Created instrument: ${symbol} (${currency})`)
  return Number(result.lastInsertRowid)
}

let imported = 0
let skipped  = 0
let warnings: string[] = []

const insertTxn = db.prepare(`
  INSERT INTO txn (
    tenant_id, instrument_id, txn_type, txn_date, quantity,
    unit_price_native, native_currency,
    costs_gbp, notes, import_source,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, 'ghostfolio', datetime('now'), datetime('now'))
`)

const insertAudit = db.prepare(`
  INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (?, ?, 'txn.create', 'txn', ?, ?)
`)

db.exec('BEGIN')
try {
  for (const activity of raw.activities) {
    // Resolve tag names for this activity
    const tagNames = activity.tags.map(id => tagMap.get(id) ?? id)

    // Map to txn_type
    let txnType: string
    if (activity.type === 'SELL') {
      txnType = 'SELL'
    } else if (activity.type === 'DIVIDEND') {
      txnType = 'DIV_PAY'
    } else if (activity.type === 'BUY') {
      if (tagNames.includes('RSU')) {
        txnType = 'RSU_VEST'
      } else if (tagNames.includes('ESPP')) {
        txnType = 'ESPP_PURCHASE'
      } else if (tagNames.includes('DIV')) {
        txnType = 'DRIP'
      } else {
        txnType = 'BUY'
      }
    } else {
      console.warn(`  Skipping unsupported type: ${activity.type} (${activity.symbol} ${activity.date})`)
      skipped++
      continue
    }

    const { date, lateNightUtc } = isoToDate(activity.date)

    // Build notes
    const noteParts: string[] = []
    if (lateNightUtc) {
      noteParts.push(`date-check: original timestamp ${activity.date} is late UTC — may be next day UK`)
      warnings.push(`${activity.symbol} ${date} (${txnType}): timestamp ${activity.date} — verify date`)
    }
    if (activity.fee > 0) {
      noteParts.push(`fee: ${activity.fee} ${activity.currency} — enter GBP equivalent in costsGbp`)
      warnings.push(`${activity.symbol} ${date} (${txnType}): fee ${activity.fee} ${activity.currency} stored as note, not costsGbp`)
    }
    if (activity.comment) {
      noteParts.push(`ghostfolio comment: ${activity.comment}`)
    }
    noteParts.push(`tags: ${tagNames.join(', ') || 'none'}`)

    const instrumentId = ensureInstrument(activity.symbol, activity.currency)
    const quantity = toDecimalString(activity.quantity)
    const unitPrice = toDecimalString(activity.unitPrice)
    const notes = noteParts.join(' | ')

    const result = insertTxn.run(
      TENANT_ID,
      instrumentId,
      txnType,
      date,
      quantity,
      unitPrice,
      activity.currency,
      notes,
    )
    const txnId = Number(result.lastInsertRowid)
    insertAudit.run(TENANT_ID, USER_ID, txnId, JSON.stringify({ importSource: 'ghostfolio', symbol: activity.symbol, date, txnType }))
    imported++
  }

  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  console.error('Import failed, rolled back:', err)
  process.exit(1)
}

console.log(`\nImport complete: ${imported} transactions imported, ${skipped} skipped.`)

if (warnings.length > 0) {
  console.log(`\n⚠  ${warnings.length} item(s) need manual review:`)
  for (const w of warnings) console.log(`   • ${w}`)
}

console.log('\nNext steps:')
console.log('  • Review flagged dates above (late UTC timestamps may be off by one day UK)')
console.log('  • Enter GBP fees for flagged transactions in the Transactions UI')
console.log('  • GBP fields (fx_rate, unit_price_gbp, total_gbp) are null — will be')
console.log('    populated when the FX recalculation pass is run (Phase 3 tooling)')

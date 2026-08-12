/**
 * Fetches dividend history from Alpha Vantage and proposes DIV_PAY transaction rows.
 *
 * Usage:
 *   node --env-file=.env --import tsx/esm scripts/fetch-dividends.ts AAPL
 *   node --env-file=.env --import tsx/esm scripts/fetch-dividends.ts AAPL --commit
 *   node --env-file=.env --import tsx/esm scripts/fetch-dividends.ts AAPL --from 2020-01-01
 *
 * Flags:
 *   --commit          Write proposed rows to the database (default: dry-run only)
 *   --from YYYY-MM-DD Only consider dividends on or after this date (default: none)
 *
 * What it does:
 *   1. Fetches dividend history for the ticker from Alpha Vantage DIVIDENDS endpoint.
 *   2. For each record, determines the date to use as txn_date:
 *        payment_date  if present (the date cash is received — correct for UK income tax)
 *        ex_dividend_date + 30 days  as a fallback when payment_date is "None"
 *   3. Computes the shares held at the ex-dividend date by walking the transaction
 *      history (acquisitions minus disposals, adjusted for splits).
 *   4. Skips records where a DIV_PAY already exists within ±3 days of the payment date.
 *   5. Dry-run: prints a table of proposed rows. With --commit: inserts them.
 *
 * After committing, run backfill-fx.ts to populate GBP fields, then POST /api/tax/run.
 *
 * Requires ALPHA_VANTAGE_API_KEY in .env.
 */

import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const ticker = args.find((a) => !a.startsWith('--'))
if (!ticker) {
  console.error('Usage: fetch-dividends.ts <TICKER> [--commit] [--from YYYY-MM-DD]')
  process.exit(1)
}
const commit = args.includes('--commit')
const fromIdx = args.indexOf('--from')
const fromDate: string | null = fromIdx !== -1 ? (args[fromIdx + 1] ?? null) : null

const apiKey = process.env.ALPHA_VANTAGE_API_KEY
if (!apiKey) {
  console.error('ALPHA_VANTAGE_API_KEY is not set in .env')
  process.exit(1)
}

// ── DB setup ──────────────────────────────────────────────────────────────────

const DB_PATH = process.env.DB_PATH ?? resolve(__dirname, '../data/taxtracker.db')
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA foreign_keys = ON')

const TENANT_ID = 1
const USER_ID = 1

// ── Find instrument ───────────────────────────────────────────────────────────

interface InstrumentRow {
  id: number
  ticker: string
  currency: string
}
const instrument = db
  .prepare('SELECT id, ticker, currency FROM instrument WHERE tenant_id = ? AND ticker = ?')
  .get(TENANT_ID, ticker) as InstrumentRow | undefined

if (!instrument) {
  console.error(`Instrument "${ticker}" not found in database. Import it first.`)
  process.exit(1)
}

console.log(`Instrument: ${instrument.ticker} (${instrument.currency}) — id=${instrument.id}`)

// ── Fetch from Alpha Vantage ──────────────────────────────────────────────────

interface AlphaVantageDividend {
  ex_dividend_date: string
  declaration_date: string
  record_date: string
  payment_date: string
  amount: string
}

interface AlphaVantageResponse {
  symbol: string
  data: AlphaVantageDividend[]
  Information?: string
}

console.log(`Fetching dividend history for ${ticker} from Alpha Vantage…`)
const url = `https://www.alphavantage.co/query?function=DIVIDENDS&symbol=${encodeURIComponent(ticker)}&apikey=${apiKey}`
const resp = await fetch(url)
if (!resp.ok) {
  console.error(`Alpha Vantage request failed: HTTP ${resp.status}`)
  process.exit(1)
}
const payload = (await resp.json()) as AlphaVantageResponse

if (payload.Information) {
  console.error(`Alpha Vantage error: ${payload.Information}`)
  process.exit(1)
}

if (!Array.isArray(payload.data) || payload.data.length === 0) {
  console.log('No dividend data returned.')
  process.exit(0)
}

console.log(`  ${payload.data.length} records received.`)

// ── Load existing transactions for this instrument ────────────────────────────

interface TxnRow {
  id: number
  txn_type: string
  txn_date: string
  quantity: string
  split_ratio: string | null
}

const existingTxns = db
  .prepare(`
  SELECT id, txn_type, txn_date, quantity, split_ratio
  FROM txn
  WHERE tenant_id = ? AND instrument_id = ?
  ORDER BY txn_date, id
`)
  .all(TENANT_ID, instrument.id) as unknown as TxnRow[]

// ── Compute pool quantity at a given date (ex-date) ───────────────────────────
// We walk all acquisitions and disposals strictly before the ex-date,
// applying splits, to know how many shares qualified for the dividend.

const ACQUISITION_TYPES = new Set([
  'BUY',
  'RSU_VEST',
  'ESPP_PURCHASE',
  'TRANSFER_IN',
  'RIGHTS_ISSUE',
  'DRIP',
])
const DISPOSAL_TYPES = new Set(['SELL', 'TRANSFER_OUT'])

function poolQuantityAt(beforeDate: string): string {
  let qty = 0
  for (const t of existingTxns) {
    if (t.txn_date >= beforeDate) break
    if (ACQUISITION_TYPES.has(t.txn_type)) {
      qty += parseFloat(t.quantity)
    } else if (DISPOSAL_TYPES.has(t.txn_type)) {
      qty -= parseFloat(t.quantity)
    } else if (t.txn_type === 'SPLIT' && t.split_ratio) {
      const [num, den] = t.split_ratio.split('/').map(Number)
      if (num && den) qty = (qty * num) / den
    }
  }
  return qty > 0 ? qty.toFixed(6).replace(/\.?0+$/, '') || '0' : '0'
}

// ── Dedup: existing DIV_PAY dates for this instrument ────────────────────────

const existingDivDates: string[] = (
  db
    .prepare(`
  SELECT txn_date FROM txn
  WHERE tenant_id = ? AND instrument_id = ? AND txn_type = 'DIV_PAY'
  ORDER BY txn_date
`)
    .all(TENANT_ID, instrument.id) as { txn_date: string }[]
).map((r) => r.txn_date)

function isAlreadyPresent(date: string): boolean {
  for (const existing of existingDivDates) {
    const diffDays = Math.abs(
      (new Date(date).getTime() - new Date(existing).getTime()) / 86_400_000,
    )
    if (diffDays <= 3) return true
  }
  return false
}

// ── Compute payment date (fallback: ex-date + 30 days) ────────────────────────

function resolvePaymentDate(record: AlphaVantageDividend): { date: string; isFallback: boolean } {
  if (record.payment_date && record.payment_date !== 'None') {
    return { date: record.payment_date, isFallback: false }
  }
  // Fallback: ex-dividend date + 30 days
  const d = new Date(record.ex_dividend_date)
  d.setUTCDate(d.getUTCDate() + 30)
  return { date: d.toISOString().slice(0, 10), isFallback: true }
}

// ── Build proposed rows ───────────────────────────────────────────────────────

interface ProposedRow {
  exDate: string
  paymentDate: string
  paymentDateIsFallback: boolean
  amountPerShare: string
  quantity: string
  currency: string
  skipReason: string | null
}

const proposed: ProposedRow[] = []

for (const record of payload.data) {
  if (fromDate && record.ex_dividend_date < fromDate) continue
  if (!record.amount || record.amount === '0') continue

  const { date: paymentDate, isFallback: paymentDateIsFallback } = resolvePaymentDate(record)
  const quantity = poolQuantityAt(record.ex_dividend_date)

  let skipReason: string | null = null
  if (isAlreadyPresent(paymentDate)) {
    skipReason = 'duplicate (DIV_PAY within ±3 days already exists)'
  } else if (quantity === '0') {
    skipReason = 'no shares held at ex-date (pool was empty)'
  }

  proposed.push({
    exDate: record.ex_dividend_date,
    paymentDate,
    paymentDateIsFallback,
    amountPerShare: record.amount,
    quantity,
    currency: instrument.currency,
    skipReason,
  })
}

// ── Print preview ─────────────────────────────────────────────────────────────

const toInsert = proposed.filter((r) => r.skipReason === null)
const toSkip = proposed.filter((r) => r.skipReason !== null)

console.log(`\n${'─'.repeat(80)}`)
console.log(`Proposed DIV_PAY rows (${toInsert.length} to insert, ${toSkip.length} skipped):`)
console.log(`${'─'.repeat(80)}`)

if (toInsert.length > 0) {
  console.log('  Ex-Date     Pay-Date    Amount/Share  Shares-Held  Note')
  for (const r of toInsert) {
    const note = r.paymentDateIsFallback ? '⚠ payment date estimated (ex+30d)' : ''
    console.log(
      `  ${r.exDate}  ${r.paymentDate}  ${r.amountPerShare.padStart(12)}  ${r.quantity.padStart(11)}  ${note}`,
    )
  }
}

if (toSkip.length > 0) {
  console.log('\nSkipped:')
  for (const r of toSkip) {
    console.log(`  ${r.exDate}  ${r.paymentDate}  — ${r.skipReason}`)
  }
}

if (toInsert.length === 0) {
  console.log('\nNothing to insert.')
  process.exit(0)
}

if (!commit) {
  console.log(`\nDry run — no changes written. Re-run with --commit to insert.`)
  process.exit(0)
}

// ── Insert ────────────────────────────────────────────────────────────────────

const insertTxn = db.prepare(`
  INSERT INTO txn (
    tenant_id, instrument_id, txn_type, txn_date, quantity,
    unit_price_native, native_currency,
    costs_gbp, notes, import_source,
    created_at, updated_at
  ) VALUES (?, ?, 'DIV_PAY', ?, ?, ?, ?, '0', ?, 'alpha-vantage', datetime('now'), datetime('now'))
`)

const insertAudit = db.prepare(`
  INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (?, ?, 'txn.create', 'txn', ?, ?)
`)

db.exec('BEGIN')
let inserted = 0
try {
  for (const r of toInsert) {
    const notes = [
      `ex_dividend_date: ${r.exDate}`,
      r.paymentDateIsFallback ? `payment_date estimated (no Alpha Vantage data): ex+30d` : null,
      `source: alpha-vantage`,
    ]
      .filter(Boolean)
      .join(' | ')

    const result = insertTxn.run(
      TENANT_ID,
      instrument.id,
      r.paymentDate,
      r.quantity,
      r.amountPerShare,
      r.currency,
      notes,
    )
    const txnId = Number(result.lastInsertRowid)
    insertAudit.run(
      TENANT_ID,
      USER_ID,
      txnId,
      JSON.stringify({
        importSource: 'alpha-vantage',
        ticker,
        exDate: r.exDate,
        paymentDate: r.paymentDate,
      }),
    )
    inserted++
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  console.error('Insert failed, rolled back:', err)
  process.exit(1)
}

console.log(`\nInserted ${inserted} DIV_PAY rows.`)
console.log('\nNext steps:')
console.log('  1. Review estimated payment dates (marked ⚠) in the Transactions UI')
console.log('  2. Run backfill-fx.ts to populate GBP fields')
console.log('  3. POST /api/tax/run to recompute disposals and dividend tax')

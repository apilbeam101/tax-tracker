# Implementation Plan — UK Share Tax Liability Tracker

> **Purpose:** phased build plan for contributors. Each phase is independently
> deployable and testable. Phases 1 and 2 are complete; subsequent phases build on them.
>
> For architecture decisions and design rationale, see [DESIGN.md](DESIGN.md).

---

## Phase 1 — Project skeleton ✅ COMPLETE

**Goal:** runnable server with auth, database, and a Svelte shell — nothing crashes,
login works, the skeleton is production-correct from the start.

**Deliverables:**

- [x] `package.json` with `engines: { node: ">=24" }`, all dependencies declared
- [x] `tsconfig.json` (server, strict mode) + `tsconfig.server.json`
- [x] `vite.config.ts` (Svelte 5 SPA, outputs to `dist/client/`)
- [x] `.env.example` with all required keys documented
- [x] `src/server/config/env.ts` — typed, validated environment config
- [x] `src/server/main.ts` — Fastify server entry point
- [x] `src/server/app.ts` — plugin registration: Helmet, rate-limit, cookie, session,
  CSRF, static serving, SPA fallback
- [x] `src/server/db/database.ts` — `initDb()`, WAL mode, migration runner
- [x] `src/server/db/migrations/001_core_schema.sql` — full domain schema:
  `tenant`, `user`, `tax_year_config` (seeded), `instrument`, `fx_rate`, `price`,
  `txn`, `s104_pool`, `cgt_disposal`, `vest_schedule`, `audit_log`
- [x] `src/server/auth/password.ts` — argon2id hash/verify
- [x] `src/server/auth/middleware.ts` — `requireAuth` Fastify hook
- [x] `src/server/routes/auth.ts` — `/api/auth/status`, `/api/auth/setup`,
  `/api/auth/login`, `/api/auth/logout`
- [x] `src/server/routes/api.ts` — authenticated API parent plugin (stub)
- [x] `src/client/` — Svelte 5 SPA: `App.svelte` (auth routing), `Setup.svelte`,
  `Login.svelte`, `Dashboard.svelte` (shell)

**To verify Phase 1:**
```bash
cp .env.example .env
# Edit .env: generate SESSION_SECRET and ENCRYPTION_KEY, set PORT
npm install
npm run build:client
node --env-file=.env src/server/main.ts
# Open http://localhost:3000
# You should see the first-run passphrase setup screen
# After setup, the login screen appears
# After login, the dashboard skeleton appears
```

---

## Phase 2 — Transaction CRUD + FX service ✅ COMPLETE

**Goal:** users can manually enter any transaction type; FX rates are automatically
fetched and stored; the transaction is validated and persisted.

**Deliverables:**

- [x] `src/shared/types.ts` — TypeScript types shared between server and client:
  `Transaction`, `Instrument`, `TaxYearConfig`, `FxRate`, `TransactionType` enum, etc.
- [x] `src/server/repositories/` — TypeScript interfaces:
  `InstrumentStore`, `TransactionStore`, `FxRateStore`, `PriceStore`
- [x] `src/server/repositories/sqlite/` — SQLite implementations (all scoped by
  `tenant_id`; audit log entry written on every create/update/delete)
- [x] `src/server/services/fx/hmrc.ts` — downloads and parses HMRC monthly CSV from
  `trade-tariff.service.gov.uk`; caches in `fx_rate` table
- [x] `src/server/services/fx/frankfurter.ts` — Frankfurter daily spot fallback;
  caches in `fx_rate` table; carries forward prior business day on weekends
- [x] `src/server/services/fx/index.ts` — `FxService` that applies the configured
  `FX_RATE_POLICY` and returns an `FxRate` record for a given currency pair and date
- [x] `src/server/routes/instruments.ts` — CRUD for `instrument` records;
  registered at `/api/instruments`
- [x] `src/server/routes/transactions.ts` — CRUD for `txn` records; on create/update,
  calls `FxService` to populate `fx_rate`/`unit_price_gbp`/`total_gbp`; registered at
  `/api/transactions`
- [x] `src/client/src/routes/Transactions.svelte` — transaction list, add/edit form
  with all transaction types, FX rate display (showing rate + source)
- [x] `src/server/types/fastify.d.ts` — central Fastify instance type augmentation
  (`db`, `instruments`, `transactions`, `fx`)
- [x] `scripts/import-ghostfolio.ts` — one-shot importer for Ghostfolio JSON exports;
  maps tags to `txn_type` (RSU/ESPP/DIV), handles BST/UTC date offset, flags fees

**Key design constraints:**
- All monetary input from the client is validated as a decimal string matching
  `/^\d+(\.\d+)?$/` before being passed to `big.js`. Reject anything that would parse
  as a float literal.
- The FX service must record `rate_type` and `source` with every rate stored — this
  is an audit requirement.
- Transaction create/update must write to `audit_log`.

**Tests written** (`npm test` — cumulative 12 passing at end of phase):
- [x] `FxService` returns the correct monthly rate for a date within the period
- [x] `FxService` carries forward the prior business-day rate on weekends (Frankfurter mode)
- [x] `FxService` identity: `fromCurrency === toCurrency` returns rate=1 without a fetch
- [x] `FxService` cache hit: cached rate returned without a network call
- [x] `big.js` arithmetic: `105.47 × 25.24 × 0.74596 = 1985.7924` (no float drift)
- [x] Transaction create/read/list/update/delete round-trip
- [x] Transaction decimal validation rejects scientific notation
- [x] Audit log written on create, update, and delete

**Test data:**
- Transactions can be imported via `scripts/import-ghostfolio.ts` from a Ghostfolio JSON export.
  GBP fields (`unit_price_gbp`, `total_gbp`, `net_gbp`, `fx_rate`) are null after import —
  to be populated by the FX recalculation pass added in Phase 3.
  Any transactions with USD fees stored as notes can be found with:
  `SELECT id, txn_date, notes FROM txn WHERE notes LIKE '%fee:%'`

**Security fixes applied to Phase 1 (before Phase 2 merge):**
- Login timing oracle fixed: `verifyPassword` always runs against `DUMMY_HASH` when
  username doesn't exist, preventing username enumeration via response latency
- CSRF wired up: `GET /api/auth/csrf` token endpoint added; `POST /api/auth/logout`
  protected with `app.csrfProtection` preHandler; client fetches token before logout
- `onMount` error handling: network/JSON failure now transitions to login rather than
  infinite loading state
- Logout response check: client only clears session state if server returns 2xx
- `last_login_at` DB write moved before `session.regenerate()` to avoid valid cookie + 500
- `requireEnv` renamed from `require` to avoid shadowing Node built-in
- Duplicate `node:path`/`node:fs` imports in `database.ts` consolidated
- Migration ROLLBACK guarded against masking the original error
- `req.session.user` used directly in `/api/me` instead of unsafe `Record` cast

---

## Phase 3 — Tax engine (CGT + S104 + B&B + RSU/ESPP + dividends) ✅ COMPLETE

**Goal:** the core of the product. After entering transactions, the system computes
realised CGT per disposal, maintains the S104 pool, and summarises tax by year.

**Deliverables:**

- [x] `scripts/backfill-fx.ts` — one-shot FX backfill for imported transactions:
  iterates all `txn` rows where `unit_price_gbp IS NULL AND unit_price_native IS NOT NULL`,
  calls `FxService` for each, writes back `fx_rate`, `unit_price_gbp`, `total_gbp`, `net_gbp`.
  Required before the tax engine can run against any imported transaction data.
- [x] `scripts/fetch-dividends.ts` — one-shot dividend history importer via Alpha Vantage:
  fetches all dividend records for a ticker, computes shares held at each ex-date from the
  S104 pool walk, deduplicates against existing DIV_PAY rows (±3 days), and inserts
  `DIV_PAY` transactions with `payment_date` as `txn_date` (fallback: ex-date + 30 days).
  Requires `ALPHA_VANTAGE_API_KEY` in `.env`. Dry-run by default; use `--commit` to write.
  ```bash
  node --env-file=.env --import tsx/esm scripts/fetch-dividends.ts AAPL          # preview
  node --env-file=.env --import tsx/esm scripts/fetch-dividends.ts AAPL --commit # insert
  node --env-file=.env --import tsx/esm scripts/fetch-dividends.ts AAPL --from 2020-04-06
  ```
- [x] `src/server/db/migrations/002_tax_years_2020_2022.sql` — seeds missing
  `tax_year_config` rows for 2020-21 and 2021-22 (required for instruments with history from 2018 onwards)
- [x] `src/server/db/migrations/003_rename_dividend_types.sql` — splits the old
  catch-all `DIVIDEND` type into `DRIP` (stock price ≥ $5, enters S104 pool as acquisition)
  and `DIV_PAY` (per-share cash dividend, income only)
- [x] `src/server/db/migrations/004_espp_discount_price.sql` — adds two nullable TEXT
  columns to `txn`: `espp_discount_price_native` (user-supplied) and
  `espp_discount_price_gbp` (server-derived via FX ratio). When the discount price is
  provided, the server recomputes `income_amount_gbp` and `net_gbp` to reflect the actual
  cash outflow rather than the full market value.
- [x] `src/server/db/migrations/005_vest_schedule_espp_discount.sql` — adds
  `expected_discount_price_native TEXT` to `vest_schedule`. Allows a scheduled ESPP
  purchase event to carry the expected discounted purchase price, enabling estimated
  employment income to be projected on the Tax Summary page before the purchase occurs.
- [x] `src/server/services/tax/matching.ts` — deterministic share matcher:
  - Input: all transactions for an instrument (sorted by date)
  - Output: array of `CgtDisposalRecord` records with `match_type` and computed gain
  - Implements: same-day → 30-day → S104 pool, in that order
  - `isAcquisition` includes `DRIP`; `DIV_PAY` is ignored by the pool
  - Returns pool state after all transactions are processed
- [x] `src/server/services/tax/pool.ts` — S104 pool operations:
  `addToPool`, `disposeFromPool`, `applyStockSplit`, `applyCapReturn`, `applyRightsIssue`
- [x] `src/server/services/tax/rsu.ts` — RSU vest processor supporting all three
  withholding methods:
  - `income_amount_gbp = gross_shares_vested × vest_price_gbp` (always gross)
  - **`net-settlement`** (default): `quantity` on txn = net shares delivered;
    `rsu_shares_withheld` withheld shares never touch the S104 pool;
    pool addition = `net_shares × vest_price_gbp`
  - **`sell-to-cover`**: all gross shares enter pool; a separate zero-gain SELL txn
    covers the withheld cash amount
  - **`cash`**: all gross shares enter pool at vest price
- [x] `src/server/services/tax/espp.ts` — `computeEsppPurchaseIncome()` helper:
  given a transaction and the discounted price paid per share (GBP), returns
  `income_amount_gbp = (mv_at_purchase − price_paid) × qty` and `pool_cost_gbp = mv_at_purchase × qty`.
  Used by the tax engine when walking pool history for ESPP income reporting.
  The equivalent calculation for new/edited transactions is performed inline in
  `routes/transactions.ts` using the already-fetched FX rate.
- [x] `src/server/services/tax/dividends.ts` — DIV_PAY tax + FTCR:
  `credit = min(withholding, treaty_rate × gross, uk_tax_on_dividend)`;
  prefers `dividendGrossGbp` field, falls back to `totalGbp`
- [x] `src/server/services/tax/cgt_summary.ts` — per tax year summary:
  aggregate gains/losses, apply AEA, apply CGT rates, handle 2024-25 mid-year split
- [x] `src/server/services/tax/engine.ts` — `runTaxEngine` and
  `runTaxEngineForInstrument` — orchestrates matching, persists disposals and pool state
- [x] `src/server/repositories/sqlite/CgtDisposalStore.ts` — persist and retrieve
  disposal records (written after every matching run)
- [x] `src/server/repositories/sqlite/S104PoolStore.ts` — persist and retrieve
  S104 pool state per instrument
- [x] `src/server/routes/tax.ts` — `/api/tax/years`, `/api/tax/run`,
  `/api/tax/summary?taxYear=2025-26`, `/api/tax/disposals`, `/api/tax/pool`,
  `/api/tax/dividends` (returns `{ items, summary }` — per-transaction results plus an
  annual aggregate applying the allowance once across all payments),
  `/api/tax/espp` (returns `{ items, projectedItems, summary }` — confirmed
  `ESPP_PURCHASE` transactions with a discount price, unrealised `vest_schedule` entries
  with `expected_discount_price_native` as projected items valued from the latest cached
  price, and totals split between confirmed and projected)
- [x] `src/server/routes/transactions.ts` — added `POST /api/transactions/import-dividends`:
  preview or commit Alpha Vantage dividend history for an instrument; GBP fields are
  populated inline via FxService (no separate backfill step needed after UI import)
- [x] `src/client/src/routes/TaxSummary.svelte` — three sections on one page:
  - **Capital Gains Tax** — tax year selector, band selector, gains cards, disposal table
    with match-type badges, estimated CGT, HMRC reporting threshold warning
  - **Dividend Income** — gross dividends, allowance, taxable amount, withholding, FTCR,
    estimated dividend tax; annual summary table; per-transaction drill-down
  - **ESPP Employment Income** — confirmed purchase income (discount × shares), CGT pool
    cost; projected purchases from vest_schedule shown in a visually distinct section with
    an "estimate" banner; projected items use the latest cached price as proxy for MV at
    purchase and are italicised/purple to avoid confusion with confirmed figures
- [x] `src/client/src/routes/Transactions.svelte` — "↓ Import dividends" button opens
  a preview panel: select instrument → Alpha Vantage data loads automatically → review
  table shows ex-date, payment date (flagged "est." if estimated), per-share amount,
  shares held; skipped rows shown in collapsible section; "Import N rows" commits
- [x] `vitest.config.ts` — dedicated vitest config (decoupled from Svelte Vite config)

**Transaction types** (`src/shared/types.ts`):

| Type | Pool? | Tax treatment |
|---|---|---|
| `BUY` | acquisition | — |
| `SELL` | disposal | CGT |
| `DIV_PAY` | no | Dividend income; FTCR on withholding |
| `DRIP` | acquisition | Shares bought with dividend cash; cost = market price |
| `RSU_VEST` | acquisition | Employment income at vest; CGT base = vest price |
| `ESPP_PURCHASE` | acquisition | Employment income on discount; CGT base = MV at purchase |
| `SPLIT` / `UNSPLIT` | qty adjust | Pool quantity scaled by ratio; cost unchanged |
| `CAPRETURN` | cost adj | Reduces pool cost basis; taxable if cost would go negative |
| `RIGHTS_ISSUE` | acquisition | New shares at subscription price |
| `TRANSFER_IN` / `TRANSFER_OUT` | acq / disposal | Treated as cost-neutral pool movements |

**Tests written** (`npm test` — cumulative 50 passing at end of phase, across 6 test files):
- [x] S104 pool: add multiple acquisitions → correct average cost → partial disposal
- [x] S104 pool: full disposal zeroes cost; dispose-more-than-pool throws
- [x] Stock split doubles quantity without changing cost
- [x] Capital return reduces cost basis; clamps at zero
- [x] Share matcher: simple buy→sell → S104 gain
- [x] Share matcher: buy × 3 at different prices → pool average → partial disposal
- [x] Same-day matching: same-day buy + sell → split between same-day and S104
- [x] 30-day B&B: sell 100, vest 50 at day 15 → 50 B&B at acquisition cost, 50 S104
- [x] 30-day B&B: acquisition on day 31 is NOT matched
- [x] Disposal spanning all three match types: 3 disposal records with correct gains
- [x] RSU vest → subsequent sale: employment income = base cost, CGT = post-vest only
- [x] DRIP enters S104 pool; DIV_PAY does not affect the pool
- [x] Stock split: 2-for-1 halves avg cost, sell all at new price → correct gain
- [x] CGT summary: gain below AEA → zero tax
- [x] CGT summary: losses offset gains before AEA
- [x] CGT summary: band apportionment with income £40k
- [x] CGT summary: all higher rate when income exceeds basic limit
- [x] CGT summary TY 2024-25: disposal 20 Oct → pre-change rates (10%/20%)
- [x] CGT summary TY 2024-25: disposal 5 Nov → post-change rates (18%/24%)
- [x] CGT summary: HMRC reporting threshold triggers `mustReport`
- [x] Dividend FTCR: gross £1000, 15% WHT, basic-rate taxpayer (FTCR = UK tax)
- [x] Dividend FTCR: gross £1000, 15% WHT, higher-rate taxpayer (FTCR = £150)
- [x] Dividend within allowance: no UK tax, no FTCR
- [x] Dividend WHT > treaty rate: capped at treaty rate for FTCR
- (All Phase 2 tests still passing)

**First-time setup after importing transactions:**
1. `node --env-file=.env --import tsx/esm scripts/backfill-fx.ts` — populate GBP fields on all imported transactions
2. `POST /api/tax/run` — run the tax engine
3. Use "↓ Import dividends" on the Transactions page to pull DIV_PAY history from Alpha Vantage
4. Open Tax Summary page → select tax year → enter income for band apportionment

---

## Phase 4 — Price provider + holdings valuation ✅ COMPLETE

**Goal:** live and historical prices; current portfolio value and unrealised gains.

**Deliverables:**

- [x] `src/server/services/prices/provider.ts` — `PriceProvider` interface:
  `getPrice(ticker, currency, date)` and `getHistoricalPrices(ticker, currency, from, to)`.
  Both return price objects without `id`/`fetchedAt`/`instrumentId` — the cache layer adds those.
- [x] `src/server/services/prices/tiingo.ts` — Tiingo EOD adapter using adjusted close;
  free tier: 500 symbols, ≤50 req/hr, ≤1000 req/day. Requires `TIINGO_API_KEY`.
  Returns `null` for 404 responses (market closed or unknown ticker).
- [x] `src/server/services/prices/yahoo.ts` — Yahoo Finance v8 chart API adapter (fallback;
  no API key required; personal use). UK tickers appended `.L`; EUR tickers `.DE`; US tickers
  unchanged. Returns prices in GBp (pence) for LSE tickers — GBX ÷ 100 paths unchanged.
- [x] `src/server/services/prices/cache.ts` — `PriceService` interface; checks `price`
  table first, then tries each provider in order (Tiingo → Yahoo); stores on miss.
  Also exposes `getLatestCached(instrumentId)` and `fetchRange(...)` for bulk backfill.
  `PriceStore.getLatest(instrumentId)` added to the store interface and SQLite implementation.
- [x] `src/server/services/holdings/valuation.ts` — `computeHoldings()`:
  iterates all instruments, reads S104 pool state, fetches latest price (cache → provider),
  converts to GBP via FxService, computes unrealised gain/loss in £ and %;
  skips instruments with zero pool quantity.
- [x] `src/server/routes/holdings.ts` — three endpoints:
  - `GET /api/holdings` — full holdings table with cost basis, value, unrealised gain
  - `POST /api/holdings/refresh-prices` — fetches today's price for all held instruments
  - `POST /api/holdings/fetch-history` — bulk-fetches historical price range for one instrument
- [x] `src/client/src/routes/Holdings.svelte` — holdings table: ticker, shares held,
  cost basis, avg cost/share, latest price (native currency), price date, current value,
  unrealised gain/loss (£ and %); totals row; "↻ Refresh prices" button;
  null-safe display when price data is unavailable
- [x] `src/client/src/routes/Dashboard.svelte` — Holdings nav link wired up;
  `Page` type updated to include `'holdings'`

**Provider registration** (`src/server/app.ts`):
Tiingo is included in the provider chain only if `TIINGO_API_KEY` is set;
Yahoo Finance is always included as the fallback:
```typescript
const priceProviders = [
  ...(config.tiingoApiKey ? [createTiingoProvider(config.tiingoApiKey)] : []),
  createYahooProvider(),
]
```

**Tests written** (`npm test` — cumulative 61 passing at end of phase, across 8 test files):
- [x] `PriceService`: cache hit returns cached price without calling provider
- [x] `PriceService`: cache miss fetches from provider and stores result
- [x] `PriceService`: falls back to second provider when first throws
- [x] `PriceService`: returns null when all providers return no data
- [x] `PriceService`: `fetchRange` stores all returned rows
- [x] Yahoo adapter: parses valid chart API response correctly
- [x] Yahoo adapter: returns empty array for "no data" / 404 response
- [x] `HoldingsValuation`: computes unrealised gain with FX conversion
- [x] `HoldingsValuation`: skips instruments with zero pool quantity
- [x] `HoldingsValuation`: returns null value fields when no price available
- [x] `HoldingsValuation`: handles GBP-denominated instruments without FX conversion
- (All Phase 1–3 tests still passing)

**Also fixed in this phase:**
- `vitest.config.ts` — added `env: { SESSION_SECRET, ENCRYPTION_KEY }` stubs so
  `npm test` runs without requiring `.env` to be present

---

## Phase 5 — Charts + projections ✅ COMPLETE

**Goal:** trend visualisations filtered by date range; forward projection of
upcoming vests/purchases.

**Deliverables:**

- [x] `src/server/routes/charts.ts` — data endpoints for chart series:
  - `GET /api/charts/portfolio-value?period=1y` — time series of portfolio market value
  - `GET /api/charts/realised-gains?taxYear=2025-26` — monthly gains bar chart
  - `GET /api/charts/dividend-income?period=3y` — monthly dividend income bar chart
  - `GET /api/charts/cost-vs-value` — per-instrument cost basis vs current value
  - Period options: `mtd`, `qtd`, `ytd`, `1m`, `3m`, `6m`, `1y`, `2y`, `3y`, `5y`, `7y`, `10y`, `15y`
- [x] `src/server/routes/projections.ts` — upcoming vest/purchase schedule with
  projected GBP value (using latest cached price + FX); estimated employment income
  for RSU vests; estimated ESPP discount income when `expectedDiscountPriceNative` is
  supplied (computed as `(latest price − discount price) × qty`); `GET /`, `POST /`,
  `DELETE /:id`
- [x] `src/client/src/lib/LineChart.svelte` — lightweight canvas-based line chart
  with gradient fill, grid lines, Y-axis labels, and ResizeObserver for responsive layout.
  No external dependencies.
- [x] `src/client/src/lib/BarChart.svelte` — canvas-based bar chart supporting positive
  and negative values (gains / losses in different colours); same responsive pattern.
- [x] `src/client/src/routes/Dashboard.svelte` (complete) — portfolio value line chart
  with period selector (3M/6M/1Y/2Y/3Y/5Y), KPI cards (cost basis, current value,
  unrealised gain/loss + %), realised gains and dividend income bar charts side-by-side,
  upcoming events table (5 rows, links to Projections page)
- [x] `src/client/src/routes/Projections.svelte` — vest/purchase schedule grouped by
  tax year; projected value using latest cached price; estimated employment income for
  RSU vests; estimated discount income for ESPP purchases when a discount price is set;
  add/delete events; discount price input shown when `espp-purchase` type is selected;
  tax-year total summaries
- [x] `src/client/src/lib/masked.svelte.ts` — global masking state (Svelte 5 rune store).
  A single toggle in the nav header masks all private monetary values (`£••••`) across
  every page simultaneously. Public market data (prices, FX rates, gain %, annual exempt
  amount, avg cost/share) is never masked. Chart shapes remain intact; Y-axis labels are
  replaced by the `formatY` prop when masking is active. Share quantities mask separately
  (`••••`, no £). The store is a `.svelte.ts` module so reactive state is shared without
  Svelte context or prop drilling.

**Also updated:**
- `src/server/routes/api.ts` — registered `chartRoutes` at `/api/charts` and
  `projectionRoutes` at `/api/projections`

---

## Phase 6 — Import + export ✅ COMPLETE

**Goal:** import transactions from any CSV via a generic column mapper; export in all supported formats.

**Deliverables:**

- [x] `src/server/services/import/csv-mapper.ts` — generic column mapper with
  per-column transforms (`static`, `map`, `negate`, `dateReformat`); client-supplied
  column mappings; no broker-specific presets (correctness cannot be validated without
  real exports to test against)
- [x] `src/server/services/export/cgtcalculator.ts` — tab-separated format for
  cgtcalculator.com: `B/S DATE COMPANY SHARES PRICE CHARGES STAMPDUTY`; date as
  `DD/MM/YYYY`; PRICE in GBP pounds (not pence); stamp duty always `0`; acquisitions
  map to `B`, disposals to `S`; rows without `unitPriceGbp` or non-price types (SPLIT etc.)
  are skipped
- [x] `src/server/services/export/csv.ts` — generic CSV export for transactions and
  disposals via `csv-stringify/sync`; configurable columns
- [x] `src/server/services/export/pdf.ts` — annual report PDF via `pdfkit`: cover page
  with summary figures, holdings table, disposals table, dividend summary, CGT liability
  breakdown
- [x] `src/server/routes/import-export.ts` — four endpoints:
  - `POST /api/import/preview` — parse CSV + mappings, return preview rows (no DB write)
  - `POST /api/import/commit` — insert valid rows; `instrumentId` is optional when a
    `ticker` column is mapped; per-row ticker resolution (case-insensitive) with fallback
    to the request-level `instrumentId`; rows with no resolvable instrument are skipped
    with a per-row error
  - `GET /api/export/transactions?format=csv|cgtcalculator&instrumentId=&from=&to=`
  - `GET /api/export/disposals?taxYear=&instrumentId=`
  - `GET /api/export/report?taxYear=&income=` (PDF)
- [x] `src/client/src/routes/ImportExport.svelte` — two-tab UI:
  - **Import tab**: optional default instrument selector (labelled "optional" when a
    `ticker` column is mapped); header checkbox; CSV paste textarea; column mapping table
    with auto-populated header dropdowns; preview table (first 50 rows, includes ticker
    column); Preview + Import buttons
  - **Export tab**: type selector (Transactions / CGT Disposals / Annual PDF Report);
    format selector (CSV / cgtcalculator.com) for transactions; optional instrument and
    tax-year filters; income field for PDF rate-band apportionment; Download button
- [x] `src/client/src/routes/Dashboard.svelte` — Import/Export nav link added;
  `Page` type extended with `'import-export'`

**Multi-instrument CSV import:**
A single CSV can contain transactions for multiple instruments. Map a `ticker` column;
the server resolves each row's instrument by case-insensitive ticker match against all
existing instruments. Rows whose ticker doesn't match any instrument are skipped with
an error. If no `ticker` column is mapped, a default instrument must be selected.

**cgtcalculator.com format note:**
Format verified against cgtcalculator.com/instructions.htm. Key distinction: PRICE is
in GBP pounds, not pence. The 8th field (STOCK_TYPE `U` for AIM/OFEX) is not emitted
as it isn't derivable from the stored data.

**Tests written** (`npm test` — 86 passing, 86 total, 10 test files):
- [x] cgtcalculator exporter: BUY → `B` row with `DD/MM/YYYY` date and GBP price
- [x] cgtcalculator exporter: SELL → `S` row; RSU_VEST → `B` row
- [x] cgtcalculator exporter: skips transactions with no `unitPriceGbp`
- [x] cgtcalculator exporter: skips non-price types (SPLIT)
- [x] cgtcalculator exporter: tab-separated 7-field output matches site example layout
- [x] CSV mapper: maps header columns; maps by 0-based index when no header
- [x] CSV mapper: validates unknown `txnType`, missing `txnDate`, invalid decimal, invalid date format
- [x] CSV mapper: `static`, `map`, `dateReformat` (DD/MM/YYYY and MM/DD/YYYY) transforms
- [x] CSV mapper: `validRows` filter; `toCreateBody` builder
- [x] CSV mapper: `ticker` column mapped → exposes `row.ticker`; null when not mapped
- (All Phase 1–5 tests still passing)

---

## Phase 7 — Hardening, security review, and documentation ✅ COMPLETE

**Goal:** production-ready defaults, complete security controls, and clear user docs.

**Deliverables:**

- [x] Confirm all Fastify routes have schema validation on request bodies
- [x] Add `audit_log` entries for all state-changing operations (verify completeness)
- [x] Rate-limit all auth endpoints; confirm global rate-limit is reasonable
  - Global: 200 req/min; login: 10/15min; setup: 5/15min
- [x] Add `robots.txt` (disallow all) — `src/client/public/robots.txt`
- [x] Add database backup utility: `npm run backup` → `data/backups/taxtracker-YYYY-MM-DDTHH-MM-SS.db`
- [x] Reverse proxy setup docs: Caddy and nginx with TLS (added to README)
- [x] `README.md` — complete setup guide:
  - Prerequisites: Node ≥ 24
  - Clone, `npm install`
  - Generate `SESSION_SECRET` and `ENCRYPTION_KEY`
  - Configure `.env`
  - `npm start`
  - First-run passphrase setup
  - Optional: `ALPHA_VANTAGE_API_KEY` for dividend history import (free at alphavantage.co)
  - Optional: `TIINGO_API_KEY` for live prices
  - Optional: reverse proxy for HTTPS
- [x] Security review checklist against OWASP Top 10 for the self-hosted threat model (in README)

---

## Implementation notes for contributors

### Running tests

```bash
npm test           # run all tests once
npm run test:watch # re-run on file changes (development)
```

The tax engine tests (Phase 3) are the most important. Run them first after any change
to `src/server/services/tax/`.

### Money arithmetic rule

**Never use `number` arithmetic on monetary values.** Import `Big` from `big.js` and
keep all intermediate values as `Big` instances. Convert back to string with `.toFixed()`
or `.toPrecision()` only at storage or display boundaries.

```ts
// ✅ correct
import Big from 'big.js'
const cost = new Big(quantity).times(new Big(unitPriceGbp))

// ❌ wrong — float drift
const cost = parseFloat(quantity) * parseFloat(unitPriceGbp)
```

An ESLint rule should enforce this in CI.

### Database column type rule

**Never declare a monetary column as `REAL` or `NUMERIC` in SQL migrations.** Always
use `TEXT`. Add a migration lint step to CI that `grep`s migrations for `REAL` on
monetary columns.

### Adding a new tax year

Insert a row into `tax_year_config` in a new numbered migration file, e.g.
`002_add_tax_year_2027_28.sql`. Verify the rates against the latest HMRC guidance before
merging.

### Adding a new price provider

1. Implement the `PriceProvider` interface in `src/server/services/prices/`.
2. Register it in the provider factory.
3. Add unit tests covering the response parsing and error handling.
4. Document the free-tier limits and ToS restrictions in the provider file.

---

## Dependency versions (June 2026)

| Package | Version | Notes |
|---|---|---|
| `node:sqlite` | built-in (Node ≥24) | No separate install |
| `fastify` | ^5.8.5 | |
| `@fastify/cookie` | ^11.0.2 | |
| `@fastify/csrf-protection` | ^8.0.0 | |
| `@fastify/helmet` | ^13.0.2 | |
| `@fastify/rate-limit` | ^11.0.0 | |
| `@fastify/session` | ^11.1.1 | |
| `@fastify/static` | ^9.1.3 | |
| `@node-rs/argon2` | ^2.0.2 | Prebuilt binaries, no compilation |
| `big.js` | ^7.0.1 | v7: no breaking API changes; constructor rejects `undefined` |
| `csv-parse` | ^7.0.0 | v7 has option renames vs v5; not yet used in code |
| `csv-stringify` | ^6.8.0 | |
| `date-fns` | ^4.4.0 | |
| `pdfkit` | ^0.19.1 | |
| `svelte` | ^5.56.3 | Runes API; minimum 5.46.4 required by vite-plugin-svelte v7 |
| `vite` | ^8.0.0 | |
| `@sveltejs/vite-plugin-svelte` | ^7.1.2 | Requires Vite 8 + Svelte ≥5.46.4 |
| `typescript` | ^6.0.0 | |
| `tsx` | ^4.22.4 | |
| `vitest` | ^4.1.9 | Replaces Jest + ts-jest; native Vite 8 integration, no vulnerable transitive deps |
| `@vitest/coverage-v8` | ^4.1.9 | |
| `eslint` | ^10.5.0 | |

Verify current patch versions before installing; keep `package-lock.json` committed.

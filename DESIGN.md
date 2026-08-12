# Design Document — UK Share Tax Liability Tracker

> **Audience:** contributors, security reviewers, and users who want to understand how
> the system works before trusting it with their financial data.
>
> **Status:** living document — updated as implementation progresses.

---

## 1. Problem statement

UK-resident employees at US-headquartered companies often hold employer stock as **RSUs
(Restricted Stock Units)** and **ESPP (Employee Stock Purchase Plan)** shares. Tracking
the ongoing UK tax liability on these holdings is complex:

- RSU vests are taxed as **employment income** at vest; subsequent appreciation is **CGT**.
- ESPP purchases carry an employment income charge on the **discount**; CGT applies to
  subsequent gains.
- All USD values must be converted to GBP on the **transaction date** using an
  HMRC-acceptable exchange rate.
- Share disposals must follow UK share-matching rules (**same-day → 30-day
  Bed & Breakfast → Section 104 pool**) before CGT is computed.
- Dividend tax, foreign withholding tax (US 15% under the treaty), and Foreign Tax
  Credit Relief add further complexity.
- Allowances and rates change every tax year, sometimes mid-year (the 30 Oct 2024 CGT
  rate change is an example).

No readily available, self-hostable tool handles all of this correctly, transparently,
and for free.

---

## 2. Goals and non-goals

### Goals (v1)

| # | Goal |
|---|------|
| G1 | Correct, auditable HMRC-compliant CGT calculations (S104 pool, B&B rules, RSU/ESPP treatment). |
| G2 | Accurate USD→GBP conversion using HMRC-published rates stored with every transaction. |
| G3 | Manual entry of all transaction types (buy, sell, dividend, RSU vest, ESPP purchase, split, return of capital). |
| G4 | Live and historical share prices via external API; locally cached to respect rate limits. |
| G5 | Time-filtered trend charts (tax year, calendar year, quarter, month, 1/2/3/5/7/10/15-yr) and projections for upcoming vests. |
| G6 | Import from broker CSV; export to cgtcalculator, cgtcalc, generic CSV, and PDF. |
| G7 | Self-hostable with minimal setup: Node ≥ 24, `npm install`, configure `.env`, `npm start`. |
| G8 | Security-first defaults: encrypted at rest, secure cookies, CSRF protection, localhost bind. |
| G9 | Designed so multi-user / multi-tenant can be layered on without a rewrite. |

### Non-goals (v1)

- Hosted SaaS / cloud deployment (designed for it later, not built for it now).
- Payslip import (later phase — no standardised UK payslip format exists).
- Automated broker API pull (broker APIs are approval-gated and plan-unfriendly; manual CSV is the realistic baseline).
- Non-share assets (property, crypto, bonds) — architecture allows adding them; not in scope now.
- Multi-user access control.

---

## 3. Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                    │
│  Svelte 5 SPA  ────── fetch ──────────────────────────────▶ │
└─────────────────────────────────────────────────────────────┘
                                           │
                                    HTTPS / localhost
                                           │
┌─────────────────────────────────────────▼───────────────────┐
│  Node.js ≥24 process                                        │
│                                                             │
│  Fastify                                                    │
│  ├── /assets/*          static Svelte build                 │
│  ├── /api/auth/*        login / logout / first-run setup    │
│  └── /api/*  ─────────────────────────────▶ repositories   │
│                                              │              │
│  Tax engine (pure TS, no I/O)               │              │
│  FX service (HMRC CSV + Frankfurter)        │              │
│  Price service (Tiingo + cache)             │              │
│                                             ▼              │
│  node:sqlite (built-in, WAL mode)  ──── SQLite file        │
│  AES-256-GCM field encryption               │              │
└─────────────────────────────────────────────────────────────┘
                                              │
                                  ./data/taxtracker.db
```

### Key architectural principles

1. **Single Node process, single SQLite file.** No database server, no message queue, no
   Redis. The whole application is `node src/server/main.ts` plus a `.env` file.

2. **Tax engine is pure TypeScript with no I/O.** It takes data in, returns computed
   results out. This makes it fully unit-testable without mocking anything.

3. **Repository layer behind interfaces.** All database access flows through TypeScript
   interfaces (`TransactionStore`, `HoldingStore`, etc.). Handlers depend on interfaces,
   not on the raw `DatabaseSync` instance. This keeps the tenant-scoping and encryption
   boundary in one place, and makes the storage layer swappable.

4. **Tenant column on every domain table from day one.** Currently always `tenant_id = 1`.
   When multi-user is added, adding user signup, a multi-tenant auth layer, and row-level
   scoping is data work, not schema surgery.

5. **Exact decimals everywhere.** All monetary values and quantities are stored as **TEXT
   (exact decimal strings)** in SQLite. Never `REAL`. All arithmetic uses `big.js` with
   explicit rounding modes. This is the foundation of tax-calculation correctness.

---

## 4. Technology choices

### 4.1 Runtime: Node.js ≥ 24 + TypeScript

**Why Node over Go (the other main candidate):**

The historic blocker for Node in this kind of app — painful native SQLite compilation
(`better-sqlite3` needing a C toolchain per platform) — was removed in Node 22/24 with
the built-in `node:sqlite` module. Since:

- The deployment model is a self-hosted web server (not an end-user binary), "install
  Node once" is a non-issue.
- TypeScript end-to-end means the tax engine and the Svelte UI share types. Shared types
  on financial models are a real correctness win.
- The Node ecosystem has everything needed: excellent crypto, CSV, PDF, and date
  libraries.

**Node version requirement:** `>=24` (set in `package.json` `engines`). This is a
*capability* floor — `node:sqlite` reaches Release-Candidate stability at v24. Recommend
**even-numbered LTS lines** (24, 26, …) for production deployments; avoid v25 (a
short-lived non-LTS "Current" release).

### 4.2 Storage: `node:sqlite` (WAL mode)

Node 24's built-in SQLite:
- **No native compilation.** Pre-compiled into Node — zero platform-specific build steps.
- **WAL mode** allows concurrent reads during writes (appropriate for a web app).
- **SQLite is the right fit:** the workload is transactional records + modest time-series
  with date-range filters and aggregations. Not an OLAP problem; SQLite handles it
  trivially at the scale of one person's financial history.

**Why not DuckDB?** DuckDB is an analytics columnar store. Its Go driver requires cgo
(breaking the clean cross-compile story); it's simply the wrong tool for a
transactional ledger.

**Encryption at rest:** AES-256-GCM applied at the application layer via `node:crypto`,
with the key derived from the user's passphrase using argon2id. This keeps the pure-Node
story intact today. SQLCipher whole-file encryption is a future option if a multi-tenant
deployment requires it.

### 4.3 Money: `big.js` with explicit rounding

**Never use JavaScript `number` (IEEE-754 float) for money.**
`big.js` was chosen over `decimal.js`/`bignumber.js` (same author) as the minimal
sibling: ~6 KB, only arithmetic and rounding modes, no trig functions.

**Storage contract:**
- Quantities: TEXT, exact decimal to broker precision (fractional shares supported, e.g.
  `"105.47"`).
- Prices and monetary amounts: TEXT, exact decimal at full precision (e.g.
  `"18.8280304"` for a USD × FX derived figure).
- SQLite column types: always `TEXT`, never `REAL` or `NUMERIC`.

**Rounding policy:** compute at full `big.js` precision internally; round only at two
defined edges:
1. **Display:** `Intl.NumberFormat`, never feeding back into data.
2. **HMRC-prescribed output points** (e.g. final gain rounded to whole pounds in the
   taxpayer's favour), applied at defined steps in the CGT engine with a pinned rounding
   mode, validated against cgtcalc output.

### 4.4 Web framework: Fastify

Fastify is lightweight, TypeScript-first, and has first-class schema validation (JSON
Schema on request bodies). It serves the JSON API and the compiled Svelte SPA as static
assets.

### 4.5 Frontend: Svelte 5

**Svelte 5** compiles away the framework — no large runtime shipped to the browser.
The SPA is compiled by Vite to a static `dist/client/` directory and served by Fastify.

**Charts** are implemented as lightweight canvas-based components (`LineChart.svelte`,
`BarChart.svelte`) with no external chart library dependency. Both use `ResizeObserver`
for responsive layout and accept a `formatY` prop for custom Y-axis label formatting
(used by the masking feature to blank out private values).

### 4.6 Auth: argon2id + server-side sessions

- **`@node-rs/argon2`** — prebuilt binaries for all platforms (no compilation); argon2id
  variant, OWASP-recommended parameters (64 MiB memory, 3 iterations, 4-way parallelism).
- Server-side sessions via `@fastify/session`, stored server-side (not JWT); session ID
  rotated on login to prevent session fixation.
- Cookies: `HttpOnly`, `Secure` (in production), `SameSite=Lax`, 8-hour idle timeout.
- CSRF protection via `@fastify/csrf-protection` (synchronizer token + SameSite defence).

---

## 5. UK tax rules implemented

> All rates are stored in the `tax_year_config` table and are never hardcoded. The
> descriptions below reflect the rules as at June 2026 (TY 2026/27); earlier years are
> seeded with their correct values.

### 5.1 Share identification (matching) order

Every disposal is matched to acquisitions in this HMRC-mandated order (TCGA92):

1. **Same-day rule** (s105(1)) — dispose against same-day acquisitions first.
2. **30-day Bed & Breakfast rule** (s106A) — dispose against acquisitions in the 30 days
   *after* the disposal. Earliest acquisition first. Prevents wash-sale loss manufacturing.
3. **Section 104 pool** — the default: average cost across the remaining pooled holding.

This ordering is the heart of the CGT engine and is implemented as a deterministic,
fully unit-tested matcher.

> **Why this matters for frequent acquirers:** if you sell shares and new shares are
> acquired (by any means) within 30 days, the B&B rule applies — often materially
> changing the computed gain compared to a plain S104 disposal.

#### How B&B interacts with the S104 pool average cost

The B&B rule is a **gain-calculation device only** — it does not remove the disposed
shares from the S104 pool. This distinction is critical and often causes confusion.

When a disposal is matched (in whole or in part) under the 30-day rule:

- The **gain** on those shares is computed using the future acquisition's cost, not
  the pool average.
- The disposed shares **remain in the S104 pool** with their original cost basis. They
  are not deducted from the pool quantity.
- The future acquisition's matched portion does **not enter the S104 pool** — only the
  unmatched remainder is added.

**Consequence for the pool average:** after a B&B event, the S104 pool retains the
old (often lower) cost basis embedded within its average, alongside any new unmatched
shares added at their actual purchase price. The resulting pool average will typically
be *lower* than the most recent acquisition price. This is intentional — the
"deferred gain" (the difference between the old basis and the B&B acquisition price)
is preserved in the pool and will be captured when those shares are eventually sold.

**Why this must be correct:** the total CGT collected over the lifetime of the holding
must equal the total economic profit (total proceeds minus total cost paid). If the
pool were zeroed on a B&B disposal and only the unmatched future shares re-entered at
their new price, the old basis would vanish from the system and a portion of the
eventual sale proceeds would go untaxed. The B&B rule was specifically designed as
anti-avoidance legislation to prevent this — not to give a free step-up in basis.

**Example (numbers illustrative, not from real data):**

| Step | Shares | Pool qty | Pool cost | Pool avg |
|---|---|---|---|---|
| Acquire 100 shares at £40 | + 100 | 100 | £4,000 | £40.00 |
| Sell 60 shares — B&B matched against future acquisition (£55) | 0 from pool | 100 | £4,000 | £40.00 |
| Future acquisition: 80 shares at £55 (60 matched, 20 unmatched) | + 20 | 120 | £5,100 | £42.50 |
| Hypothetical sale of remaining 120 shares at £60 | − 120 | 0 | £0 | — |

Lifetime CGT = B&B gain (60 × (£55 − £55) = £0) + pool gain (120 × £60 − £5,100 = £2,100).
Total proceeds received = 60 × £55 + 120 × £60 = £3,300 + £7,200 = £10,500.
Total cost paid = £4,000 + 80 × £55 = £8,400. Economic profit = £2,100. ✓

### 5.2 Section 104 pool

One pool per `(tenant_id, instrument_id)`. Each acquisition adds to `pool_quantity`
and `pool_cost_gbp`. Each pool disposal removes a proportional share of cost:

```
cost_used = pool_cost * (quantity_sold / pool_quantity)
```

Pool adjustments (no disposal, no gain/loss event):
- **Stock/bonus splits:** `pool_quantity *= ratio`, pool cost unchanged.
- **Rights issues:** amount paid added to `pool_cost_gbp`.
- **Returns of capital:** part-disposal if material; deducted from pool cost if "small."

### 5.3 RSU treatment

RSU vesting is recorded with a `withholding_method` that controls how many shares enter
the S104 pool. The method is **configurable per RSU grant / per instrument** because
different employers handle it differently.

#### Withholding method: `net-settlement` ← default for this deployment

The broker withholds shares at vest to fund the PAYE tax bill. Example:
100 shares vest, 47 withheld (45% income tax + 2% NIC = 47%), 53 delivered.

| Field | Value |
|---|---|
| Gross shares vested | 100 |
| Shares withheld (configurable %) | 47 |
| Net shares delivered to account | 53 |
| Employment income (`income_amount_gbp`) | `100 × vest_price_gbp` (full gross vest) |
| S104 pool addition | **53 shares** at `53 × vest_price_gbp` |
| CGT base cost per share | `vest_price_gbp` |

The 47 withheld shares are **never added to the S104 pool** — they were surrendered at
vest price (zero CGT gain) and are already accounted for through PAYE on the payslip.
The payslip reports gross income from the full 100-share vest and shows the tax withheld,
netting to approximately zero cash impact on the employee.

**Implementation:** store `gross_shares_vested`, `shares_withheld`, and `withholding_rate`
on the txn record. `net_shares_received = gross_shares_vested − shares_withheld` is what
enters the pool. The `income_amount_gbp` is always based on the **gross** vest.

#### Withholding method: `sell-to-cover`

All shares vest and are delivered; the broker immediately sells enough shares to cover
the tax bill on the open market. Creates a tiny CGT event on the sold shares (sold at
vest price = base cost, so gain is typically £0 or a tiny rounding difference). Record as
a separate SELL transaction immediately following the vest.

#### Withholding method: `cash` (pay tax from other funds)

Employee receives all gross shares; pays PAYE tax from salary or other cash. All gross
shares enter the S104 pool. No immediate disposal.

---

**Common fields across all methods:**
1. `income_amount_gbp` = `gross_shares_vested × vest_price_gbp` — the employment income
   reported via PAYE. This is always the gross amount regardless of withholding method.
2. FX conversion: vest-date USD value × the FX rate on the vest date (stored with the
   txn for auditability).
3. Later sale of delivered shares: CGT = proceeds − base cost (only post-vest appreciation
   is taxable as a capital gain).

### 5.4 ESPP treatment (non-tax-advantaged US plans)

1. At purchase: the **discount** (market value at purchase − price paid) is employment
   income, charged via PAYE. Stored as `income_amount_gbp`.
2. CGT base cost = price paid + discount taxed as income = full market value at purchase.
3. FX conversion at purchase date.

Note: the UK charge is on the *real undervalue at acquisition* (MV on purchase date −
price paid), regardless of how the US plan computed its headline discount (e.g. 15%
look-back benefit). The look-back is a US pricing mechanism, not a UK tax concept.

#### Recording the discounted price

The optional `espp_discount_price_native` field (added in migration 004) captures the
actual price paid per share in the native currency. When supplied, the server derives:

- `espp_discount_price_gbp` — discount price converted to GBP using the same FX rate
  already fetched for `unit_price_gbp` (ratio `unit_price_gbp / unit_price_native`)
- `income_amount_gbp` — `(unit_price_gbp − espp_discount_price_gbp) × quantity`
- `net_gbp` — actual cash outflow: `espp_discount_price_gbp × quantity + costs_gbp`
  (negative, as it is an outflow)

When the discount price is not supplied, `income_amount_gbp` is left as entered by the
user and `net_gbp` is computed from the full market value (conservative fallback).

The `computeEsppPurchaseIncome()` helper in `services/tax/espp.ts` provides the same
calculation for use by the tax engine when deriving employment income from pool history.

#### Projected ESPP income

Scheduled ESPP purchases in the `vest_schedule` table (migration 005 adds
`expected_discount_price_native` to that table) are included in the Tax Summary ESPP
section as projected items. The market value at purchase is estimated using the latest
cached price converted to GBP via the most recent available FX rate. Projected items are
visually distinguished from confirmed transactions and carry an explicit "estimate" label.
Projected income is excluded from the confirmed-totals summary; it disappears once the
actual `ESPP_PURCHASE` transaction is entered and the schedule entry is marked as realised.

### 5.5 CGT computation

Per disposal (or part-disposal), after matching:

```
gain = proceeds_gbp − allowable_cost_gbp − selling_costs_gbp
```

Per tax year, after all disposals:

```
net_gains = sum of all gains (losses reduce gains; losses can't reduce below zero for
            the year; unused losses carry forward)
taxable_gains = max(0, net_gains − annual_exempt_amount)
tax = taxable_gains × applicable_rate (18% or 24%, depending on taxpayer band)
```

Rate splits:
- Gains filling the remaining basic-rate income tax band: 18%.
- Gains above that: 24%.
- **For TY 2024-25 only:** disposals before 30 Oct 2024 use 10%/20%; disposals on or
  after 30 Oct 2024 use 18%/24%. The `tax_year_config` table stores both rate sets and
  the split date.

### 5.6 Dividends

```
dividend_tax = max(0, (gross_gbp − allowance) × rate)
credit = min(withholding_gbp, treaty_rate × gross_gbp, dividend_tax)
net_tax = dividend_tax − credit
```

- **Allowance:** £500 for TY 2024-25 and 2025-26; configurable per year.
- **Rates (TY 2025-26):** 8.75% basic / 33.75% higher / 39.35% additional.
- **Rates (TY 2026-27, changed):** 10.75% / 35.75% / 39.35%.
- **US dividends:** W-8BEN secures 15% US withholding (vs 30% default). The FTCR credit
  is capped at `min(actual withholding, 15% × gross, UK tax on that dividend)`.

#### Annual summary vs per-transaction view

`GET /api/tax/dividends` returns both:

- **`items`** — per-transaction tax result (individual `DividendTaxResult` objects,
  useful for reconciling individual payments against broker statements).
- **`summary`** — annual aggregate: total gross, total withholding, the dividend
  allowance applied once across all payments, taxable gross, rate band, UK tax before
  credit, total FTCR, and UK tax after credit.

The allowance is applied at the annual level in the summary (not per-transaction), which
is the correct HMRC treatment. The Tax Summary page displays the annual summary figures
and a collapsible per-transaction table for drill-down.

### 5.7 FX (USD→GBP)

- Stored with every transaction: the rate, rate type (`hmrc-monthly` | `daily-spot`),
  and source.
- **HMRC monthly rates** (the default): downloaded from
  `trade-tariff.service.gov.uk/exchange_rates`, available as CSV and XML.
- **Daily spot (Frankfurter):** free, no API key, historical back to 1948, used as the
  daily-spot fallback. No weekend rates — the prior business day's rate is carried forward.
- Users can choose their FX policy (`FX_RATE_POLICY` in `.env`). The policy must be
  applied consistently within a holding.

---

## 6. External data sources

### Stock prices

All price fetching is behind a `PriceProvider` interface. Prices are cached locally in
the `price` table to respect rate limits and allow offline operation.

| Provider | Free tier | Use case |
|---|---|---|
| **Tiingo** (default) | 50 req/hr, 1000/day, 500 symbols/mo, 30+ yr history | Self-hosted personal use. **Note: "internal use only" on free tier — a public deployment needs a commercial licence.** |
| Alpha Vantage | 25/day | Used for dividend history import (`scripts/fetch-dividends.ts` and the UI import flow). Too tight for live prices. |
| **Yahoo Finance** (fallback) | Free, no key, no documented limits | v8 chart API. Personal use; no official API — ToS restricts commercial use. Implemented as the default fallback after Tiingo. |
| Stooq | Free, no key, deep history | Not implemented — blocks non-browser HTTP clients (returns 403). |
| Manual | n/a | User enters price at time of transaction. |

### FX rates

| Source | Format | Notes |
|---|---|---|
| HMRC Trade Tariff | CSV, XML (monthly) | `trade-tariff.service.gov.uk/exchange_rates`. The HMRC-compliant default. Old gov.uk collection withdrawn 20 Oct 2023. |
| Frankfurter | JSON (daily) | `frankfurter.dev`. Free, no key, ECB-sourced, back to 1948. No weekend rates. |
| Bank of England IADB | CSV (daily) | Optional precise daily spot source. |

---

## 7. Import/export formats

### Import

- **Manual CSV upload** with a configurable **column mapper** (saved per-broker presets).
- Common presets: E\*TRADE transaction CSV, Schwab transaction CSV, Computershare
  statement export.
- **No brokerage API integration in v1** — broker APIs for stock-plan accounts are
  approval-gated, plan-unfriendly, or non-existent (Morgan Stanley StockPlan Connect,
  Fidelity NetBenefits, Computershare have no public APIs).

### Export

| Format | Details |
|---|---|
| **cgtcalculator** | `B/S DATE COMPANY SHARES PRICE CHARGES [TAX] [TYPE]`, all GBP, `dd/mm/yyyy`. |
| **cgtcalc** (mattjgalloway) | `KIND DATE ASSET AMOUNT PRICE EXPENSES`, kinds `BUY SELL CAPRETURN DIVIDEND SPLIT UNSPLIT SPOUSEIN SPOUSEOUT RESTRUCT`, ticker/ISIN. |
| **CSV** | Generic, one row per transaction or per disposal, suitable for Excel/accountant. |
| **PDF** | Annual report: holdings, realised gains, dividend summary, estimated liability. |

The internal transaction model is a **superset of both CGT calculator formats** so
exports are lossless (no data is dropped in translation).

---

## 8. Security model

| Control | Implementation |
|---|---|
| Passphrase hashing | argon2id, 64 MiB memory, 3 iterations, 4-way parallelism (`@node-rs/argon2`). |
| Encryption at rest | AES-256-GCM (field-level) via `node:crypto`; key derived from passphrase via argon2id. |
| Transport | HTTPS required in production; binary defaults to `127.0.0.1` (localhost only). |
| Session security | `HttpOnly`, `Secure`, `SameSite=Lax`, 8h timeout; session ID rotated on login. |
| CSRF | Synchronizer token (`@fastify/csrf-protection`) + `SameSite` cookie defence. |
| Brute-force protection | Rate limiting on `/api/auth/login` (10 attempts per 15 min). |
| Secrets | All sensitive config (session secret, encryption key, API keys) in `.env`, never committed. |
| HTTP headers | `@fastify/helmet` sets `Content-Security-Policy`, `HSTS`, `X-Content-Type-Options`, `Referrer-Policy`. |
| Auth errors | Generic message for login failures (no username enumeration). |
| Error responses | Centralized handler (`src/server/errors.ts`) — a plain thrown `Error` never reaches the client with its real message (e.g. a raw SQLite constraint error); only a recognized `HttpError` subclass, a schema-validation error, or a plugin-classified 4xx (rate limit, CSRF) surfaces its actual message. |
| Log redaction | `src/server/config/logging.ts` scrubs cookies, auth headers, API keys, and secret fields from Pino output before it hits stdout. |
| Secret scanning | gitleaks in CI on every push/PR plus a monthly full-history scan (`.github/workflows/secrets.yml`) — catches an accidentally-committed secret before/soon after it lands. |
| Dependency auditing | `npm audit --omit=dev --audit-level=high` in CI; Dependabot opens grouped update PRs monthly. |

**Important for self-hosters:** if you expose the service on a public IP or domain, you
**must** use HTTPS (set `NODE_ENV=production` and front with a reverse proxy such as
Caddy or nginx with TLS). The app itself defaults to localhost-only to avoid accidental
public exposure.

---

## 9. Multi-tenant readiness

The app is single-user in v1 but the following seams are in place to add multi-user
without a rewrite:

1. **`tenant_id` on every domain table,** defaulted to `1`. All queries are written to
   filter by `tenant_id`; adding a second user means adding a row to `tenant` and
   scoping all repository queries to the correct ID.
2. **Repository layer behind TypeScript interfaces.** All database access is through
   `*Store` interfaces. The implementations inject `tenant_id`; handlers never touch
   `tenant_id` directly.
3. **`Authenticator` interface + `Principal` on the request context.** Today it resolves
   to the single `admin` user; adding OAuth/email login means implementing the interface,
   not changing handlers.
4. **Versioned migrations** from commit #1, auto-run on startup.
5. **Config via `.env`.** DB path, bind address, keys — all injectable so the same binary
   runs single-user on localhost or multi-tenant in a container. `Dockerfile` +
   `deploy/docker-compose.yml` now provide that container path as an additional
   self-hosting option (non-root UID, `read_only` filesystem, bind-mounted SQLite data
   directory) alongside the bare-Node/reverse-proxy setup — see the README's "Docker"
   section.

---

## 10. Numeric precision rationale

A concrete example to illustrate the approach:

> **105.47 shares of Company X, purchased at $25.24/share, FX rate 0.74596**

```
unit_price_native = "25.24"           (TEXT, USD)
quantity          = "105.47"          (TEXT, fractional shares)
fx_rate           = "0.74596"         (TEXT, HMRC monthly)

unit_price_gbp    = 25.24 × 0.74596  = "18.8280304"   (TEXT, full precision)
total_gbp         = 105.47 × 18.8280304 = "1985.785…"  (TEXT, full precision)

Display:  £18.83 per share            (Intl.NumberFormat, 2dp, round half-up)
          £1,985.79 total
```

The S104 pool stores the **total** GBP cost at full precision. The per-share figure
(`£18.8280304`) is **never persisted** — it is recomputed at full precision whenever
needed. This eliminates per-share rounding drift across the entire holding history.

SQLite column types for monetary values: **always `TEXT`** (confirmed in schema).
The schema enforces this via column definitions and `STRICT` mode where beneficial.

---

## 11. Directory structure

```
claude-tax/
├── src/
│   ├── server/
│   │   ├── main.ts           Entry point
│   │   ├── app.ts            Fastify plugin registration
│   │   ├── errors.ts         HttpError taxonomy + global setErrorHandler
│   │   ├── config/
│   │   │   ├── env.ts        Typed, validated config from .env
│   │   │   └── logging.ts    Pino redact config + loggerOptions()
│   │   ├── db/
│   │   │   ├── database.ts   initDb(), migration runner
│   │   │   └── migrations/   001_core_schema.sql … 005_vest_schedule_espp_discount.sql
│   │   ├── auth/
│   │   │   ├── password.ts   argon2id hash/verify
│   │   │   └── middleware.ts requireAuth hook
│   │   ├── repositories/     (TypeScript interfaces + SQLite impls)
│   │   ├── services/
│   │   │   ├── tax/          CGT engine, S104, B&B matcher, RSU/ESPP helpers
│   │   │   ├── fx/           HMRC + Frankfurter FX fetchers
│   │   │   └── prices/       PriceProvider interface + adapters
│   │   └── routes/           Fastify route plugins
│   │       ├── api.ts        Authenticated API parent (CSRF, requireAuth)
│   │       ├── auth.ts
│   │       ├── charts.ts
│   │       ├── health.ts     GET /health → { status: 'ok' }
│   │       ├── holdings.ts
│   │       ├── instruments.ts
│   │       ├── projections.ts  vest_schedule CRUD; ESPP discount price field
│   │       ├── tax.ts          /summary, /disposals, /dividends (+ annual summary),
│   │       │                   /espp (confirmed + projected), /pool, /pool-history
│   │       ├── import-export.ts  CSV import (preview + commit), exports (CSV, cgtcalculator, PDF)
│   │       └── transactions.ts
│   ├── client/               Svelte 5 SPA (Vite build)
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.ts
│   │       ├── App.svelte    Auth routing shell
│   │       ├── routes/       Setup, Login, Dashboard, Transactions,
│   │       │                 Holdings, TaxSummary (CGT + Dividends + ESPP),
│   │       │                 Projections (ESPP discount price field),
│   │       │                 ImportExport (CSV import + all export formats)
│   │       └── lib/
│   │           ├── api.ts            apiFetch (attaches CSRF token)
│   │           ├── masked.svelte.ts  global masking state (Svelte rune store)
│   │           ├── LineChart.svelte  canvas line chart, responsive
│   │           └── BarChart.svelte   canvas bar chart, +/− values
│   └── shared/               Types shared between server and client
├── dist/                     Build output (gitignored)
├── data/                     SQLite DB file (gitignored)
├── deploy/
│   └── docker-compose.yml    Additional self-hosting option (see README "Docker")
├── .github/
│   ├── workflows/            ci.yml (lint/typecheck/test/build/audit), secrets.yml (gitleaks)
│   └── dependabot.yml        Monthly npm + github-actions updates
├── .env.example              Template; copy to .env and fill in
├── biome.json                Lint + format config (not ESLint — see §12)
├── Dockerfile                Multi-stage build; additional self-hosting option
├── .dockerignore
├── CHANGELOG.md              Keep a Changelog format
├── DESIGN.md                 This document
├── IMPLEMENTATION.md         Phased build plan
└── package.json
```

## 12. Repository hygiene, CI, and packaging

Added after v1's initial feature-complete state, informed by lessons from a sibling
project's more mature CI/security setup.

**Linting is Biome, not ESLint.** `typescript-eslint` (the natural ESLint choice for a
TypeScript project) only supports TypeScript `<6.1.0` as a peer dependency; this project
runs TypeScript `^7`. Rather than force an unverified/unsupported combination onto a
financial-calculation codebase, linting moved to Biome, which has no such constraint and
also handles formatting in the same tool. Biome cannot parse `.svelte` templates, so the
client has no linter or type checker wired up (`tsconfig.json` excludes `src/client`) —
`svelte-check` would close that gap if it's ever worth the effort.

**CI** (`.github/workflows/ci.yml`) runs lint, typecheck, test, and build on every
push/PR, plus a separate `npm audit --omit=dev --audit-level=high` job so a dev-only
advisory doesn't block merges. Single Ubuntu/Node-24 job — no OS/Node matrix, since this
is a self-hosted personal app, not a package or image consumed by third parties across
platforms.

**Secret scanning** (`.github/workflows/secrets.yml`, `.gitleaks.toml`) runs gitleaks on
every push/PR against the diff range, plus a monthly full-history scan — the on-push mode
alone cannot see further back than the pushed commit range, so the periodic full scan is
what actually guarantees full-history coverage.

**Error handling and logging** (§8) were hardened at the same time: a centralized error
handler prevents an unclassified exception from leaking internal detail, and Pino log
redaction prevents cookies/secrets from landing in stdout.

**Testing:** the price/FX external-API parsers (Tiingo, HMRC monthly CSV, Frankfurter)
gained fixture-based tests against realistic (synthetic but format-accurate) captured
response shapes — previously thin or entirely untested despite being the layer most
exposed to upstream format drift. Routes, auth, most repositories, and the Svelte client
remain untested; this was a deliberately scoped addition, not a general coverage push.

**Docker packaging** is additive, not a replacement for the bare-Node/reverse-proxy setup.
Non-root fixed UID, `read_only` root filesystem with a `tmpfs`-backed `/tmp` (SQLite spills
temp b-trees to disk on large queries even under `PRAGMA temp_store = MEMORY`'s intent to
avoid it — belt and suspenders) and a bind-mounted `/app/data`, `init: true` for correct
SIGTERM handling (a plain Node process as container PID 1 ignores SIGTERM outright), and
the published port bound to `127.0.0.1` only — same "always behind a reverse proxy"
posture as the non-Docker deployment. See the README's "Docker" section for the mandatory
pre-flight steps (real secrets, `chown` on the bind-mounted host data directory).

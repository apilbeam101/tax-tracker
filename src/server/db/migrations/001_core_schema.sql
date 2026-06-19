-- ============================================================
-- Core schema for the UK Share Tax Liability Tracker
--
-- Numeric conventions:
--   All monetary values stored as TEXT (exact decimal strings, e.g. "18.8280304").
--   Quantities stored as TEXT to support fractional shares.
--   NEVER store as REAL — SQLite REAL is a 64-bit IEEE float.
--   Dates stored as TEXT in ISO-8601 format "YYYY-MM-DD".
--   All tables include tenant_id for future multi-user support
--   (defaults to 1 = the single local user for now).
-- ============================================================

-- ── Tenants / Users ────────────────────────────────────────
CREATE TABLE tenant (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenant(id),
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  -- argon2id hash of the passphrase
  password_hash TEXT    NOT NULL,
  -- per-user preferences stored as JSON
  preferences   TEXT    NOT NULL DEFAULT '{}',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- Seed the single default tenant and user placeholder
-- (the real user record is created on first-run passphrase setup)
INSERT INTO tenant (id, name) VALUES (1, 'default');

-- ── Tax year configuration ─────────────────────────────────
-- All rates and allowances are stored here — NEVER hardcoded.
-- Seeded with known values; operator can add future years.
CREATE TABLE tax_year_config (
  -- e.g. "2025-26" meaning 6 Apr 2025 to 5 Apr 2026
  tax_year              TEXT    PRIMARY KEY,
  start_date            TEXT    NOT NULL,  -- "YYYY-MM-DD" (always 06-Apr)
  end_date              TEXT    NOT NULL,  -- "YYYY-MM-DD" (always 05-Apr next year)

  -- CGT
  cgt_annual_exempt     TEXT    NOT NULL,  -- e.g. "3000"
  -- CGT rates on shares (not residential property)
  -- For 2024-25: two rate regimes within one year (before/after 30 Oct 2024)
  cgt_basic_rate        TEXT    NOT NULL,  -- e.g. "0.18"
  cgt_higher_rate       TEXT    NOT NULL,  -- e.g. "0.24"
  -- Optional: rates before 30 Oct 2024 (only used for 2024-25 split)
  cgt_basic_rate_pre    TEXT,
  cgt_higher_rate_pre   TEXT,
  cgt_rate_change_date  TEXT,              -- "2024-10-30" for the Oct Budget change

  -- Dividends
  dividend_allowance    TEXT    NOT NULL,  -- e.g. "500"
  dividend_basic_rate   TEXT    NOT NULL,  -- e.g. "0.0875"
  dividend_higher_rate  TEXT    NOT NULL,  -- e.g. "0.3375"
  dividend_addl_rate    TEXT    NOT NULL,  -- e.g. "0.3935"

  -- CGT proceeds reporting threshold
  cgt_proceeds_threshold TEXT   NOT NULL,  -- e.g. "50000"

  -- Income tax basic rate band upper limit (used to apportion CGT band)
  income_basic_rate_limit TEXT  NOT NULL   -- e.g. "50270"
);

-- Seed known tax years (rates web-verified June 2026)
INSERT INTO tax_year_config VALUES
  ('2022-23', '2022-04-06', '2023-04-05',
   '12300', '0.10', '0.20', NULL, NULL, NULL,
   '2000', '0.0875', '0.3375', '0.3935',
   '49200', '50270'),
  ('2023-24', '2023-04-06', '2024-04-05',
   '6000', '0.10', '0.20', NULL, NULL, NULL,
   '1000', '0.0875', '0.3375', '0.3935',
   '50000', '50270'),
  ('2024-25', '2024-04-06', '2025-04-05',
   '3000', '0.18', '0.24', '0.10', '0.20', '2024-10-30',
   '500', '0.0875', '0.3375', '0.3935',
   '50000', '50270'),
  ('2025-26', '2025-04-06', '2026-04-05',
   '3000', '0.18', '0.24', NULL, NULL, NULL,
   '500', '0.0875', '0.3375', '0.3935',
   '50000', '50270'),
  ('2026-27', '2026-04-06', '2027-04-05',
   '3000', '0.18', '0.24', NULL, NULL, NULL,
   '500', '0.1075', '0.3575', '0.3935',
   '50000', '50270');

-- ── Instruments (shares / ETFs / funds) ───────────────────
CREATE TABLE instrument (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL REFERENCES tenant(id) DEFAULT 1,
  -- User-visible ticker / name
  ticker      TEXT    NOT NULL,              -- e.g. "AAPL", "LON:BATS"
  isin        TEXT,                          -- e.g. "US0378331005"
  name        TEXT    NOT NULL,
  currency    TEXT    NOT NULL DEFAULT 'GBP',-- ISO 4217, e.g. "USD" or "GBP"
  exchange    TEXT,                          -- e.g. "NASDAQ", "LSE"
  instrument_type TEXT NOT NULL DEFAULT 'equity', -- equity | fund | etf | reit
  is_employer_stock INTEGER NOT NULL DEFAULT 0,
  -- Default RSU withholding method for vests of this instrument.
  -- Overridable per-vest on the txn record.
  -- "net-settlement" = broker withholds shares (most common UK employer pattern)
  -- "sell-to-cover"  = broker sells shares to raise cash for tax
  -- "cash"           = employee pays PAYE from salary/other funds, receives all shares
  rsu_withholding_method TEXT NOT NULL DEFAULT 'net-settlement',
  notes       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, ticker)
);

-- ── FX rates ───────────────────────────────────────────────
CREATE TABLE fx_rate (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_currency TEXT NOT NULL,  -- e.g. "USD"
  to_currency   TEXT NOT NULL,  -- e.g. "GBP"
  rate_date     TEXT NOT NULL,  -- "YYYY-MM-DD" (first day of month for HMRC monthly)
  rate          TEXT NOT NULL,  -- exact decimal string, e.g. "0.74596"
  rate_type     TEXT NOT NULL,  -- "hmrc-monthly" | "daily-spot" | "manual"
  source        TEXT NOT NULL,  -- e.g. "trade-tariff.service.gov.uk" | "frankfurter.dev"
  fetched_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_currency, to_currency, rate_date, rate_type)
);

-- ── Prices ─────────────────────────────────────────────────
CREATE TABLE price (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument_id INTEGER NOT NULL REFERENCES instrument(id),
  price_date    TEXT    NOT NULL,  -- "YYYY-MM-DD"
  close_price   TEXT    NOT NULL,  -- exact decimal string, in instrument's native currency
  source        TEXT    NOT NULL,  -- e.g. "tiingo" | "manual"
  fetched_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(instrument_id, price_date)
);

-- ── Transactions ───────────────────────────────────────────
-- Covers: BUY, SELL, DIVIDEND, RSU_VEST, ESPP_PURCHASE,
--         SPLIT, UNSPLIT, CAPRETURN, RIGHTS_ISSUE, TRANSFER_IN, TRANSFER_OUT
CREATE TABLE txn (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL REFERENCES tenant(id) DEFAULT 1,
  instrument_id   INTEGER NOT NULL REFERENCES instrument(id),
  txn_type        TEXT    NOT NULL, -- see enum above
  txn_date        TEXT    NOT NULL, -- "YYYY-MM-DD"

  -- Quantity: exact decimal string (fractional shares supported)
  quantity        TEXT    NOT NULL,

  -- Unit price in the instrument's native currency (e.g. USD), exact decimal
  -- NULL for non-price events (splits, capreturn)
  unit_price_native TEXT,
  native_currency   TEXT,          -- e.g. "USD"

  -- FX conversion
  fx_rate           TEXT,          -- exact decimal rate used for this txn
  fx_rate_type      TEXT,          -- "hmrc-monthly" | "daily-spot" | "manual"
  fx_rate_source    TEXT,

  -- Derived GBP values (all exact decimal strings)
  unit_price_gbp    TEXT,          -- unit_price_native * fx_rate
  total_gbp         TEXT,          -- quantity * unit_price_gbp (before costs)
  costs_gbp         TEXT NOT NULL DEFAULT '0', -- broker fees, stamp duty etc.
  net_gbp           TEXT,          -- total_gbp +/- costs_gbp (signed for the user)

  -- RSU/ESPP fields
  -- For RSU_VEST: income_amount_gbp = employment income on GROSS vest (all shares × price)
  -- For ESPP_PURCHASE: income_amount_gbp = discount taxed as employment income
  income_amount_gbp TEXT,

  -- RSU withholding (net-share settlement — the common UK employer pattern)
  -- gross_shares_vested: total shares that vested (before any withholding)
  -- shares_withheld: shares surrendered by broker to cover PAYE tax + NIC
  -- withholding_method: "net-settlement" | "sell-to-cover" | "cash"
  -- net shares added to S104 pool = gross_shares_vested - shares_withheld
  -- (i.e. the `quantity` column on a RSU_VEST txn = net delivered shares)
  rsu_gross_shares_vested TEXT,  -- e.g. "100" (for display and payslip reconciliation)
  rsu_shares_withheld     TEXT,  -- e.g. "47"
  rsu_withholding_rate    TEXT,  -- e.g. "0.47" (stored for audit; 0.45 + 0.02 = 0.47)
  rsu_withholding_method  TEXT,  -- "net-settlement" | "sell-to-cover" | "cash"

  -- For DIVIDEND: gross, withholding, net (all GBP)
  dividend_gross_gbp     TEXT,
  dividend_withholding_gbp TEXT,   -- e.g. US 15% WHT
  dividend_net_gbp       TEXT,

  -- For SPLIT: the ratio as "new_qty/old_qty", e.g. "2/1" for a 2-for-1
  split_ratio     TEXT,

  -- For CAPRETURN: amount per share returned
  capreturn_per_share_gbp TEXT,

  -- User notes
  notes           TEXT,
  import_source   TEXT,            -- e.g. "etrade-csv" | "manual"
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_txn_instrument_date ON txn(instrument_id, txn_date);
CREATE INDEX idx_txn_tenant_date     ON txn(tenant_id, txn_date);
CREATE INDEX idx_txn_type            ON txn(txn_type);

-- ── Section 104 pool state ─────────────────────────────────
-- Maintained incrementally as transactions are processed.
-- One row per (tenant, instrument) — the current live state.
CREATE TABLE s104_pool (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenant(id) DEFAULT 1,
  instrument_id INTEGER NOT NULL REFERENCES instrument(id),
  -- Exact decimal strings — NEVER REAL
  pool_quantity TEXT    NOT NULL DEFAULT '0',
  pool_cost_gbp TEXT    NOT NULL DEFAULT '0',
  last_updated  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, instrument_id)
);

-- ── CGT disposal records ───────────────────────────────────
-- One row per disposal event, after share matching has been applied.
-- A single SELL transaction may generate multiple disposal rows
-- (e.g. part matched same-day, part matched 30-day, part from S104 pool).
CREATE TABLE cgt_disposal (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL REFERENCES tenant(id) DEFAULT 1,
  txn_id          INTEGER NOT NULL REFERENCES txn(id),
  instrument_id   INTEGER NOT NULL REFERENCES instrument(id),
  disposal_date   TEXT    NOT NULL,
  tax_year        TEXT    NOT NULL REFERENCES tax_year_config(tax_year),

  -- Matched acquisition details
  match_type      TEXT    NOT NULL,  -- "same-day" | "30-day" | "s104-pool"
  -- For 30-day: the acquisition txn_id
  acquisition_txn_id INTEGER REFERENCES txn(id),

  -- Exact decimal strings
  quantity        TEXT    NOT NULL,
  proceeds_gbp    TEXT    NOT NULL,
  allowable_cost_gbp TEXT NOT NULL,
  selling_costs_gbp  TEXT NOT NULL DEFAULT '0',
  gain_gbp        TEXT    NOT NULL,  -- proceeds - cost - selling_costs (can be negative)

  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_cgt_disposal_year     ON cgt_disposal(tax_year);
CREATE INDEX idx_cgt_disposal_date     ON cgt_disposal(disposal_date);
CREATE INDEX idx_cgt_disposal_tenant   ON cgt_disposal(tenant_id);

-- ── Vest / purchase schedule (projections) ────────────────
CREATE TABLE vest_schedule (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenant(id) DEFAULT 1,
  instrument_id INTEGER NOT NULL REFERENCES instrument(id),
  schedule_type TEXT    NOT NULL,  -- "rsu-vest" | "espp-purchase" | "option-expiry"
  scheduled_date TEXT   NOT NULL,
  quantity      TEXT    NOT NULL,
  -- For ESPP: the expected purchase price (e.g. 85% of offering/purchase price)
  expected_price_usd TEXT,
  notes         TEXT,
  -- Set when this event has been realised (matched to an actual txn)
  realised_txn_id INTEGER REFERENCES txn(id),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_vest_schedule_date ON vest_schedule(tenant_id, scheduled_date);

-- ── Audit log ─────────────────────────────────────────────
-- Immutable append-only record of all data changes (financial data needs this).
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL DEFAULT 1,
  user_id     INTEGER,
  action      TEXT    NOT NULL,  -- e.g. "txn.create", "txn.update", "txn.delete"
  entity_type TEXT    NOT NULL,
  entity_id   INTEGER,
  -- JSON snapshot of the changed data
  old_data    TEXT,
  new_data    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  ip_address  TEXT
);

CREATE INDEX idx_audit_log_tenant ON audit_log(tenant_id, created_at);

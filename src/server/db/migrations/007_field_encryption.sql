-- ============================================================
-- 007_field_encryption.sql
-- Support for field-level encryption (see crypto/fields.ts).
--
-- instrument.ticker is stored encrypted once key slots exist, so uniqueness can no longer be
-- enforced on the column itself (every ciphertext differs). ticker_bidx holds a keyed
-- HMAC of the ticker (a "blind index") and carries the uniqueness instead. It is NULL while the
-- database is not encrypting, in which case the original UNIQUE(tenant_id, ticker) applies.
--
-- app_secret holds API keys entered through the UI; value is always encrypted.
-- ============================================================

ALTER TABLE instrument ADD COLUMN ticker_bidx TEXT;

CREATE UNIQUE INDEX idx_instrument_ticker_bidx
  ON instrument(tenant_id, ticker_bidx)
  WHERE ticker_bidx IS NOT NULL;

-- Once the database has key slots a row without a blind index would silently escape the
-- uniqueness rule (the legacy UNIQUE(tenant_id, ticker) is meaningless over random ciphertext),
-- so refuse it outright. The upgrade that creates the slots must set ticker and ticker_bidx in
-- the same UPDATE.
CREATE TRIGGER instrument_ticker_bidx_required_insert
BEFORE INSERT ON instrument
WHEN NEW.ticker_bidx IS NULL AND EXISTS (SELECT 1 FROM key_slot)
BEGIN
  SELECT RAISE(ABORT, 'instrument.ticker_bidx is required once key slots exist');
END;

CREATE TRIGGER instrument_ticker_bidx_required_update
BEFORE UPDATE ON instrument
WHEN NEW.ticker_bidx IS NULL AND EXISTS (SELECT 1 FROM key_slot)
BEGIN
  SELECT RAISE(ABORT, 'instrument.ticker_bidx is required once key slots exist');
END;

CREATE TABLE app_secret (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL DEFAULT 1 REFERENCES tenant(id),
  name       TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, name)
);

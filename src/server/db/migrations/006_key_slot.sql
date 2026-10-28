-- ============================================================
-- 006_key_slot.sql
-- Key slots: the data encryption key (DEK) is wrapped by one or more
-- key-encryption keys (KEKs), one row per source. Unlocking unwraps the DEK
-- from any single slot, so changing a passphrase rewraps one row and never
-- re-encrypts field data. The DEK itself is never stored in plain form.
--   passphrase : argon2id over the login passphrase
--   recovery   : 256-bit random recovery key shown once at setup
--   unattended : ENCRYPTION_KEY supplied by the deployment (optional)
-- ============================================================

CREATE TABLE key_slot (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL DEFAULT 1 REFERENCES tenant(id),
  slot_type   TEXT    NOT NULL CHECK (slot_type IN ('passphrase', 'recovery', 'unattended')),
  -- JSON describing how the KEK is derived (algorithm and cost parameters)
  kdf_params  TEXT    NOT NULL,
  -- base64url random salt for the KDF
  salt        TEXT    NOT NULL,
  -- base64url(nonce || ciphertext || tag) of the DEK under the KEK
  wrapped_dek TEXT    NOT NULL,
  -- short fingerprint of the DEK, identifies which key a slot belongs to
  key_id      TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  -- last time the slot was rewrapped (passphrase change, recovery reset, rotation)
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, slot_type)
);

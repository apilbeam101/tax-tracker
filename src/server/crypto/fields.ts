import { createHmac } from 'node:crypto'
import { BadRequestError } from '../errors.ts'
import { fromBase64Url, NONCE_LENGTH, open, seal, TAG_LENGTH, toBase64Url } from './aead.ts'
import { hkdf } from './kdf.ts'
import type { Keyring } from './keyring.ts'
import { keyIdOf } from './keyslots.ts'

export type FieldClass = 'encrypted' | 'plaintext'

const E: FieldClass = 'encrypted'
const P: FieldClass = 'plaintext'

// Every column of every table is classified here, and a test fails if the schema gains a column
// that is not. Encrypted columns are sealed by the repository stores; plaintext ones stay readable
// because the database needs them for keys, joins, indexing and tax-year bucketing.
export const FIELD_REGISTRY: Record<string, Record<string, FieldClass>> = {
  tenant: { id: P, name: P, created_at: P },
  user: {
    id: P,
    tenant_id: P,
    username: P,
    password_hash: P,
    preferences: P,
    created_at: P,
    last_login_at: P,
  },
  tax_year_config: {
    tax_year: P,
    start_date: P,
    end_date: P,
    cgt_annual_exempt: P,
    cgt_basic_rate: P,
    cgt_higher_rate: P,
    cgt_basic_rate_pre: P,
    cgt_higher_rate_pre: P,
    cgt_rate_change_date: P,
    dividend_allowance: P,
    dividend_basic_rate: P,
    dividend_higher_rate: P,
    dividend_addl_rate: P,
    cgt_proceeds_threshold: P,
    income_basic_rate_limit: P,
  },
  instrument: {
    id: P,
    tenant_id: P,
    ticker: E,
    isin: E,
    name: E,
    currency: P,
    exchange: E,
    instrument_type: P,
    is_employer_stock: E,
    rsu_withholding_method: E,
    notes: E,
    created_at: P,
    ticker_bidx: P,
  },
  fx_rate: {
    id: P,
    from_currency: P,
    to_currency: P,
    rate_date: P,
    rate: P,
    rate_type: P,
    source: P,
    fetched_at: P,
  },
  price: {
    id: P,
    instrument_id: P,
    price_date: P,
    close_price: E,
    source: P,
    fetched_at: P,
  },
  txn: {
    id: P,
    tenant_id: P,
    instrument_id: P,
    txn_type: P,
    txn_date: P,
    quantity: E,
    unit_price_native: E,
    native_currency: P,
    fx_rate: E,
    fx_rate_type: P,
    fx_rate_source: P,
    unit_price_gbp: E,
    total_gbp: E,
    costs_gbp: E,
    net_gbp: E,
    income_amount_gbp: E,
    rsu_gross_shares_vested: E,
    rsu_shares_withheld: E,
    rsu_withholding_rate: E,
    rsu_withholding_method: E,
    dividend_gross_gbp: E,
    dividend_withholding_gbp: E,
    dividend_net_gbp: E,
    split_ratio: E,
    capreturn_per_share_gbp: E,
    notes: E,
    import_source: E,
    created_at: P,
    updated_at: P,
    espp_discount_price_native: E,
    espp_discount_price_gbp: E,
  },
  s104_pool: {
    id: P,
    tenant_id: P,
    instrument_id: P,
    pool_quantity: E,
    pool_cost_gbp: E,
    last_updated: P,
  },
  cgt_disposal: {
    id: P,
    tenant_id: P,
    txn_id: P,
    instrument_id: P,
    disposal_date: P,
    tax_year: P,
    match_type: P,
    acquisition_txn_id: P,
    quantity: E,
    proceeds_gbp: E,
    allowable_cost_gbp: E,
    selling_costs_gbp: E,
    gain_gbp: E,
    created_at: P,
  },
  vest_schedule: {
    id: P,
    tenant_id: P,
    instrument_id: P,
    schedule_type: P,
    scheduled_date: P,
    quantity: E,
    expected_price_usd: E,
    notes: E,
    realised_txn_id: P,
    created_at: P,
    expected_discount_price_native: E,
  },
  audit_log: {
    id: P,
    tenant_id: P,
    user_id: P,
    action: P,
    entity_type: P,
    entity_id: P,
    old_data: E,
    new_data: E,
    created_at: P,
    ip_address: E,
  },
  key_slot: {
    id: P,
    tenant_id: P,
    slot_type: P,
    kdf_params: P,
    salt: P,
    wrapped_dek: P,
    key_id: P,
    created_at: P,
    updated_at: P,
  },
  app_secret: { id: P, tenant_id: P, name: P, value: E, updated_at: P },
  _migrations: { id: P, filename: P, applied_at: P },
}

export function encryptedColumns(table: string): string[] {
  const columns = FIELD_REGISTRY[table]
  if (!columns) throw new Error(`Table ${table} is not in the field registry`)
  return Object.entries(columns)
    .filter(([, cls]) => cls === 'encrypted')
    .map(([name]) => name)
}

const VERSION = 'v1'
const KEY_ID_PATTERN = '[0-9a-f]{8}'
const PAD_BUCKET = 32
// The smallest possible sealed payload: nonce, one padded bucket (an empty value), tag.
const MIN_PAYLOAD_CHARS = Math.ceil(((NONCE_LENGTH + PAD_BUCKET + TAG_LENGTH) * 4) / 3)
const SEALED_PATTERN = new RegExp(
  `^${VERSION}\\.(${KEY_ID_PATTERN})\\.([A-Za-z0-9_-]{${MIN_PAYLOAD_CHARS},})$`,
)
const BLIND_INDEX_INFO = 'tax-tracker blind index v1'
const FIELD_KEY_INFO = 'tax-tracker field key v1'

export class FieldCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FieldCryptoError'
  }
}

// Part of every value's AAD, so it must identify exactly one row: an undefined or fractional id
// would make values interchangeable between rows.
function aadFor(table: string, column: string, rowId: number): Buffer {
  if (!Number.isSafeInteger(rowId) || rowId <= 0) {
    throw new Error(`Invalid row id for ${table}.${column}: ${rowId}`)
  }
  return Buffer.from(`${table}.${column}.${rowId}`, 'utf8')
}

export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && SEALED_PATTERN.test(value)
}

// AES-GCM keeps the plaintext length, which would give away short enumerated values (a
// withholding method, an import source) and the magnitude of amounts. Plaintext is therefore
// length-prefixed and zero-padded to a multiple of PAD_BUCKET bytes before it is sealed.
const LENGTH_PREFIX = 4

function pad(plaintext: string): Buffer {
  const data = Buffer.from(plaintext, 'utf8')
  const total = Math.ceil((LENGTH_PREFIX + data.length) / PAD_BUCKET) * PAD_BUCKET
  const padded = Buffer.alloc(total)
  padded.writeUInt32BE(data.length, 0)
  data.copy(padded, LENGTH_PREFIX)
  return padded
}

function unpad(padded: Buffer): string | null {
  if (padded.length < LENGTH_PREFIX) return null
  const length = padded.readUInt32BE(0)
  if (length > padded.length - LENGTH_PREFIX) return null
  return padded.subarray(LENGTH_PREFIX, LENGTH_PREFIX + length).toString('utf8')
}

// Format: v1.<keyId>.<base64url(nonce || ciphertext || tag)>. The AAD ties each value to its
// table, column and row, so values cannot be swapped between rows or columns. The AES key is
// derived from the DEK rather than being the DEK itself, so the key id and the blind index
// (which are also derived from it) share no key material with the encryption.
export function sealField(
  dek: Buffer,
  keyId: string,
  table: string,
  column: string,
  rowId: number,
  plaintext: string,
): string {
  const aad = aadFor(table, column, rowId)
  const key = hkdf(dek, FIELD_KEY_INFO)
  const padded = pad(plaintext)
  try {
    return `${VERSION}.${keyId}.${toBase64Url(seal(key, padded, aad))}`
  } finally {
    key.fill(0)
    padded.fill(0)
  }
}

export function openField(
  dek: Buffer,
  keyId: string,
  table: string,
  column: string,
  rowId: number,
  stored: string,
): string {
  const aad = aadFor(table, column, rowId)
  const match = SEALED_PATTERN.exec(stored)
  const where = `${table}.${column} row ${rowId}`
  if (!match) throw new FieldCryptoError(`Stored value is not in encrypted form (${where})`)
  if (match[1] !== keyId) {
    throw new FieldCryptoError(`Value was encrypted under a different key (${where})`)
  }
  const key = hkdf(dek, FIELD_KEY_INFO)
  let padded: Buffer | undefined
  try {
    padded = open(key, fromBase64Url(match[2] as string), aad)
    const plaintext = unpad(padded)
    if (plaintext === null) throw new FieldCryptoError(`Malformed value (${where})`)
    return plaintext
  } catch (err) {
    if (err instanceof FieldCryptoError) throw err
    throw new FieldCryptoError(`Decryption failed (${where})`)
  } finally {
    key.fill(0)
    padded?.fill(0)
  }
}

// Only these columns have a blind index (see migration 007).
const BLIND_INDEXED = new Set(['instrument.ticker'])

// Deterministic, keyed lookup tag for a value that must stay findable (the ticker) while its
// stored form is randomised. Derived from the DEK, so it is useless without unlocking. The value
// is matched exactly, as the original case-sensitive UNIQUE(tenant_id, ticker) did.
export function blindIndex(
  dek: Buffer,
  table: string,
  column: string,
  tenantId: number,
  value: string,
): string {
  if (!BLIND_INDEXED.has(`${table}.${column}`)) {
    throw new Error(`${table}.${column} has no blind index`)
  }
  const key = hkdf(dek, BLIND_INDEX_INFO)
  try {
    return createHmac('sha256', key)
      .update(`${table}.${column}.${tenantId}\0${value}`)
      .digest('hex')
  } finally {
    key.fill(0)
  }
}

export type StoredValue = string | number | null

// What the repository stores use to read and write encrypted columns. In an unprotected database
// (no key slots yet) values pass through untouched, so behaviour is unchanged until slots exist.
export interface FieldCipher {
  readonly encrypting: boolean
  seal(table: string, column: string, rowId: number, value: StoredValue): StoredValue
  open(table: string, column: string, rowId: number, stored: StoredValue): StoredValue
  /** Blind index for a lookup, or null when the database is not encrypting. */
  blindIndex(table: string, column: string, tenantId: number, value: string): string | null
  /**
   * Throws the keyring's 423 if the data is locked. For writes that touch no encrypted column
   * (a delete, an unlink) and would otherwise slip through while locked.
   */
  assertReady(): void
}

function assertEncrypted(table: string, column: string): void {
  if (FIELD_REGISTRY[table]?.[column] !== 'encrypted') {
    throw new Error(`${table}.${column} is not an encrypted column`)
  }
}

export const plainCipher: FieldCipher = {
  encrypting: false,
  seal(table, column, _rowId, value) {
    assertEncrypted(table, column)
    // A stored value shaped like ciphertext could never be read back, in this database or after
    // it gains key slots, so it is refused at the door.
    if (isSealed(value)) throw new BadRequestError('That value cannot be stored')
    return value
  },
  open(table, column, rowId, stored) {
    assertEncrypted(table, column)
    if (isSealed(stored)) {
      throw new FieldCryptoError(
        `Encrypted value found in a database without key slots (${table}.${column} row ${rowId})`,
      )
    }
    return stored
  },
  blindIndex: () => null,
  assertReady: () => undefined,
}

// Reads the key from the keyring on every call, so locking takes effect immediately (the call
// then raises the keyring's 423). Whether the database encrypts follows the keyring, which flips
// once, when key slots are created (Keyring.protect). A protected database never accepts
// plaintext where ciphertext is expected.
export function createFieldCipher(keyring: Keyring): FieldCipher {
  return {
    get encrypting() {
      return keyring.isProtected
    },

    seal(table, column, rowId, value) {
      if (!keyring.isProtected) return plainCipher.seal(table, column, rowId, value)
      assertEncrypted(table, column)
      if (value === null) return null
      return keyring.withDek((dek) =>
        sealField(dek, keyIdOf(dek), table, column, rowId, String(value)),
      )
    },

    open(table, column, rowId, stored) {
      if (!keyring.isProtected) return plainCipher.open(table, column, rowId, stored)
      assertEncrypted(table, column)
      if (stored === null) return null
      if (typeof stored !== 'string') {
        throw new FieldCryptoError(
          `Stored value is not in encrypted form (${table}.${column} row ${rowId})`,
        )
      }
      return keyring.withDek((dek) => openField(dek, keyIdOf(dek), table, column, rowId, stored))
    },

    blindIndex(table, column, tenantId, value) {
      if (!keyring.isProtected) return null
      return keyring.withDek((dek) => blindIndex(dek, table, column, tenantId, value))
    },

    assertReady() {
      if (keyring.isProtected) keyring.withDek(() => undefined)
    },
  }
}

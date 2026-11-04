import { describe, expect, it, vi } from 'vitest'
import { initDb } from '../db/database.ts'
import { BadRequestError, LockedError } from '../errors.ts'
import { seal as sealBytes, toBase64Url } from './aead.ts'
import {
  blindIndex,
  createFieldCipher,
  encryptedColumns,
  FIELD_REGISTRY,
  FieldCryptoError,
  isSealed,
  openField,
  plainCipher,
  sealField,
} from './fields.ts'
import { hkdf } from './kdf.ts'
import { Keyring } from './keyring.ts'
import { keyIdOf } from './keyslots.ts'

const DEK = Buffer.alloc(32, 0x11)
const KEY_ID = keyIdOf(DEK)

function unlockedKeyring(dek = DEK): Keyring {
  const keyring = new Keyring({ protected: true })
  keyring.unlock(Buffer.from(dek))
  return keyring
}

describe('field registry', () => {
  // The real migration runner, so tables it creates itself (_migrations) are covered too.
  async function schemaColumns(): Promise<Record<string, string[]>> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const db = await initDb(':memory:')
    log.mockRestore()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
    const result: Record<string, string[]> = {}
    for (const { name } of tables) {
      const info = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>
      result[name] = info.map((c) => c.name)
    }
    return result
  }

  it('classifies every column of every table in the schema', async () => {
    const missing: string[] = []
    for (const [table, columns] of Object.entries(await schemaColumns())) {
      for (const column of columns) {
        if (!FIELD_REGISTRY[table]?.[column]) missing.push(`${table}.${column}`)
      }
    }
    expect(missing, 'unclassified columns: add them to FIELD_REGISTRY').toEqual([])
  })

  it('has no entries for tables or columns that do not exist', async () => {
    const schema = await schemaColumns()
    const stale: string[] = []
    for (const [table, columns] of Object.entries(FIELD_REGISTRY)) {
      for (const column of Object.keys(columns)) {
        if (!schema[table]?.includes(column)) stale.push(`${table}.${column}`)
      }
    }
    expect(stale).toEqual([])
  })

  // The whole encrypted set is pinned, so moving any column to plaintext is a deliberate,
  // reviewed change to this list rather than an accident.
  const EXPECTED_ENCRYPTED: Record<string, string[]> = {
    tenant: [],
    user: [],
    tax_year_config: [],
    fx_rate: [],
    key_slot: [],
    _migrations: [],
    instrument: [
      'exchange',
      'is_employer_stock',
      'isin',
      'name',
      'notes',
      'rsu_withholding_method',
      'ticker',
    ],
    price: ['close_price'],
    txn: [
      'capreturn_per_share_gbp',
      'costs_gbp',
      'dividend_gross_gbp',
      'dividend_net_gbp',
      'dividend_withholding_gbp',
      'espp_discount_price_gbp',
      'espp_discount_price_native',
      'fx_rate',
      'import_source',
      'income_amount_gbp',
      'net_gbp',
      'notes',
      'quantity',
      'rsu_gross_shares_vested',
      'rsu_shares_withheld',
      'rsu_withholding_method',
      'rsu_withholding_rate',
      'split_ratio',
      'total_gbp',
      'unit_price_gbp',
      'unit_price_native',
    ],
    s104_pool: ['pool_cost_gbp', 'pool_quantity'],
    cgt_disposal: [
      'allowable_cost_gbp',
      'gain_gbp',
      'proceeds_gbp',
      'quantity',
      'selling_costs_gbp',
    ],
    vest_schedule: ['expected_discount_price_native', 'expected_price_usd', 'notes', 'quantity'],
    audit_log: ['ip_address', 'new_data', 'old_data'],
    app_secret: ['value'],
  }

  it('encrypts exactly the pinned set of columns in every table', () => {
    expect(Object.keys(FIELD_REGISTRY).sort()).toEqual(Object.keys(EXPECTED_ENCRYPTED).sort())
    for (const [table, expected] of Object.entries(EXPECTED_ENCRYPTED)) {
      expect(encryptedColumns(table).sort(), table).toEqual([...expected].sort())
    }
  })

  it('keeps keys, dates and types readable', () => {
    for (const column of [
      'txn_type',
      'txn_date',
      'native_currency',
      'tenant_id',
      'instrument_id',
    ]) {
      expect(FIELD_REGISTRY.txn?.[column], `txn.${column}`).toBe('plaintext')
    }
  })

  // A column default is written by the database when an INSERT omits the column, which would put
  // plaintext into an encrypted column. The stores must therefore write every one of these
  // explicitly; this lists them so a new default cannot slip in unnoticed.
  it('knows every encrypted column that has a schema default, for the stores to write explicitly', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const db = await initDb(':memory:')
    log.mockRestore()
    const withDefault: string[] = []
    for (const [table, columns] of Object.entries(FIELD_REGISTRY)) {
      const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string
        dflt_value: string | null
      }>
      for (const column of info) {
        if (columns[column.name] === 'encrypted' && column.dflt_value !== null) {
          withDefault.push(`${table}.${column.name}`)
        }
      }
    }
    expect(withDefault.sort()).toEqual(
      [
        'cgt_disposal.selling_costs_gbp',
        'instrument.is_employer_stock',
        'instrument.rsu_withholding_method',
        's104_pool.pool_cost_gbp',
        's104_pool.pool_quantity',
        'txn.costs_gbp',
      ].sort(),
    )
  })

  it('refuses an unknown table', () => {
    expect(() => encryptedColumns('nope')).toThrow(/not in the field registry/)
  })
})

describe('sealField / openField', () => {
  const seal = (value: string, row = 1, column = 'notes', table = 'txn', dek = DEK) =>
    sealField(dek, keyIdOf(dek), table, column, row, value)

  it('produces the v1.<keyId>.<payload> format and round-trips', () => {
    const sealed = seal('hello 123.456')
    expect(sealed).toMatch(new RegExp(`^v1\\.${KEY_ID}\\.[A-Za-z0-9_-]+$`))
    expect(isSealed(sealed)).toBe(true)
    expect(openField(DEK, KEY_ID, 'txn', 'notes', 1, sealed)).toBe('hello 123.456')
  })

  it.each(['', '0', 'ünïcödé ✓', 'x'.repeat(100_000)])('round-trips %j', (value) => {
    const sealed = seal(value)
    expect(openField(DEK, KEY_ID, 'txn', 'notes', 1, sealed)).toBe(value)
  })

  it('never contains the plaintext, and differs on every call', () => {
    const a = seal('SECRET-TICKER')
    const b = seal('SECRET-TICKER')
    expect(a).not.toContain('SECRET-TICKER')
    expect(a).not.toBe(b)
  })

  it('rejects a value moved to another row, column or table', () => {
    const sealed = seal('7500', 5, 'quantity')
    expect(() => openField(DEK, KEY_ID, 'txn', 'quantity', 6, sealed)).toThrow(FieldCryptoError)
    expect(() => openField(DEK, KEY_ID, 'txn', 'costs_gbp', 5, sealed)).toThrow(FieldCryptoError)
    expect(() => openField(DEK, KEY_ID, 'cgt_disposal', 'quantity', 5, sealed)).toThrow(
      FieldCryptoError,
    )
    expect(openField(DEK, KEY_ID, 'txn', 'quantity', 5, sealed)).toBe('7500')
  })

  it('rejects the wrong key and a key id that does not match', () => {
    const sealed = seal('x')
    const other = Buffer.alloc(32, 0x22)
    expect(() => openField(other, keyIdOf(other), 'txn', 'notes', 1, sealed)).toThrow(
      /different key/,
    )
    expect(() => openField(other, KEY_ID, 'txn', 'notes', 1, sealed)).toThrow(/Decryption failed/)
  })

  it('rejects tampering with the payload', () => {
    const sealed = seal('payload')
    const [version, keyId, payload] = sealed.split('.') as [string, string, string]
    const bytes = Buffer.from(payload, 'base64url')
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
    const tampered = `${version}.${keyId}.${bytes.toString('base64url')}`
    expect(() => openField(DEK, KEY_ID, 'txn', 'notes', 1, tampered)).toThrow(/Decryption failed/)
  })

  it.each([
    ['plain text', 'just a note'],
    ['a different version', 'v2.deadbeef.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['a short payload', 'v1.deadbeef.AAAA'],
    ['an empty string', ''],
  ])('refuses %s where ciphertext is expected, rather than passing it through', (_n, stored) => {
    expect(() => openField(DEK, KEY_ID, 'txn', 'notes', 1, stored)).toThrow(/not in encrypted form/)
  })

  it('names the table, column and row but never the value, in errors', () => {
    try {
      openField(DEK, KEY_ID, 'txn', 'notes', 42, 'a plaintext secret')
    } catch (err) {
      expect((err as Error).message).toContain('txn.notes row 42')
      expect((err as Error).message).not.toContain('a plaintext secret')
    }
    expect.assertions(2)
  })

  it('hides the length of short values: enumerated strings seal to the same size', () => {
    const lengths = new Set(
      ['cash', 'sell-to-cover', 'net-settlement', 'manual', 'etrade-csv', ''].map(
        (value) => seal(value).length,
      ),
    )
    expect(lengths.size).toBe(1)
  })

  it('pads in whole buckets, so longer values still only reveal a coarse size', () => {
    const lengthOf = (n: number) => seal('x'.repeat(n)).length
    expect(lengthOf(28)).toBe(lengthOf(1))
    expect(lengthOf(29)).toBeGreaterThan(lengthOf(28))
    expect(lengthOf(60)).toBe(lengthOf(29))
  })

  it('rejects a sealed payload whose inner length prefix is corrupt', () => {
    // Re-seal a payload that authenticates correctly but claims more data than it holds.
    const key = hkdf(DEK, 'tax-tracker field key v1')
    const bogus = Buffer.alloc(32)
    bogus.writeUInt32BE(1000, 0)
    const stored = `v1.${KEY_ID}.${toBase64Url(sealBytes(key, bogus, Buffer.from('txn.notes.1')))}`
    expect(() => openField(DEK, KEY_ID, 'txn', 'notes', 1, stored)).toThrow(/Malformed value/)
  })

  it.each([undefined, Number.NaN, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuses row id %s, which would make values swappable between rows',
    (rowId) => {
      expect(() => sealField(DEK, KEY_ID, 'txn', 'notes', rowId as number, 'x')).toThrow(
        /Invalid row id/,
      )
    },
  )

  it('binds each name part, not just their concatenation', () => {
    // 'a.b' + 'c' versus 'a' + 'b.c' would collide if the separator were dropped from the AAD.
    const sealed = seal('x', 1, 'quantity', 'txn')
    expect(() => openField(DEK, KEY_ID, 'tx', 'n.quantity', 1, sealed)).toThrow(FieldCryptoError)
  })

  it('accepts the shortest possible payload and rejects one character fewer', () => {
    const min = seal('')
    const payload = (min.split('.')[2] as string).length
    const ok = `v1.${KEY_ID}.${'A'.repeat(payload)}`
    const short = `v1.${KEY_ID}.${'A'.repeat(payload - 1)}`
    expect(isSealed(ok)).toBe(true)
    expect(isSealed(short)).toBe(false)
  })
})

describe('blindIndex', () => {
  const index = (value: string, table = 'instrument', column = 'ticker', tenant = 1, dek = DEK) =>
    blindIndex(dek, table, column, tenant, value)

  it('is deterministic and pinned (changing it would orphan every stored index)', () => {
    expect(index('AAPL')).toBe(index('AAPL'))
    expect(index('AAPL')).toBe('ded002b9745f12067a32dc9c2ec7c6b99e9fde142e179b5d032216b1a3ed7f24')
  })

  it('differs by value, tenant and key, is case-sensitive, and is hex', () => {
    const base = index('AAPL')
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(index('aapl')).not.toBe(base)
    expect(index('AAPL', 'instrument', 'ticker', 2)).not.toBe(base)
    expect(index('AAPL', 'instrument', 'ticker', 1, Buffer.alloc(32, 0x22))).not.toBe(base)
  })

  it('handles empty and very long values', () => {
    expect(index('')).toMatch(/^[0-9a-f]{64}$/)
    expect(index('X'.repeat(100_000))).toMatch(/^[0-9a-f]{64}$/)
  })

  it('only exists for the indexed column', () => {
    expect(() => index('AAPL', 'instrument', 'name')).toThrow(/no blind index/)
    expect(() => index('AAPL', 'txn', 'notes')).toThrow(/no blind index/)
  })

  it('does not collide when the tenant digits are shifted into the value', () => {
    expect(index('1:A', 'instrument', 'ticker', 1)).not.toBe(index('A', 'instrument', 'ticker', 11))
  })
})

describe('plainCipher (database without key slots)', () => {
  it('passes values through unchanged, including null and numbers', () => {
    expect(plainCipher.seal('txn', 'notes', 1, 'x')).toBe('x')
    expect(plainCipher.seal('instrument', 'is_employer_stock', 1, 1)).toBe(1)
    expect(plainCipher.seal('txn', 'notes', 1, null)).toBeNull()
    expect(plainCipher.open('txn', 'notes', 1, 'x')).toBe('x')
    expect(plainCipher.encrypting).toBe(false)
    expect(plainCipher.blindIndex('instrument', 'ticker', 1, 'AAPL')).toBeNull()
  })

  it('refuses to read ciphertext it cannot decrypt', () => {
    const sealed = sealField(DEK, KEY_ID, 'txn', 'notes', 1, 'x')
    expect(() => plainCipher.open('txn', 'notes', 1, sealed)).toThrow(/without key slots/)
  })

  it('refuses to store a value shaped like ciphertext, which could never be read back', () => {
    const lookalike = sealField(DEK, KEY_ID, 'txn', 'notes', 1, 'x')
    expect(() => plainCipher.seal('txn', 'notes', 1, lookalike)).toThrow(BadRequestError)
    expect(plainCipher.seal('txn', 'notes', 1, 'v1.looks.similar')).toBe('v1.looks.similar')
  })

  it('still rejects columns that are not meant to be encrypted (a store bug)', () => {
    expect(() => plainCipher.seal('txn', 'txn_date', 1, '2025-01-01')).toThrow(
      /not an encrypted column/,
    )
  })
})

describe('createFieldCipher over a keyring', () => {
  it('seals and opens through the held key', () => {
    const cipher = createFieldCipher(unlockedKeyring())
    const sealed = cipher.seal('txn', 'quantity', 9, '123.456') as string
    expect(isSealed(sealed)).toBe(true)
    expect(cipher.open('txn', 'quantity', 9, sealed)).toBe('123.456')
    expect(cipher.encrypting).toBe(true)
  })

  it('stringifies numbers when encrypting (integer columns)', () => {
    const cipher = createFieldCipher(unlockedKeyring())
    const sealed = cipher.seal('instrument', 'is_employer_stock', 1, 1)
    expect(cipher.open('instrument', 'is_employer_stock', 1, sealed)).toBe('1')
  })

  it('keeps NULL as NULL both ways', () => {
    const cipher = createFieldCipher(unlockedKeyring())
    expect(cipher.seal('txn', 'notes', 1, null)).toBeNull()
    expect(cipher.open('txn', 'notes', 1, null)).toBeNull()
  })

  it('treats plaintext in a protected database as an error, not data', () => {
    const cipher = createFieldCipher(unlockedKeyring())
    expect(() => cipher.open('txn', 'notes', 1, 'planted plaintext')).toThrow(
      /not in encrypted form/,
    )
    expect(() => cipher.open('instrument', 'is_employer_stock', 1, 1)).toThrow(
      /not in encrypted form/,
    )
  })

  it('raises the 423 when locked, for reads and writes alike', () => {
    const keyring = unlockedKeyring()
    const cipher = createFieldCipher(keyring)
    const sealed = cipher.seal('txn', 'notes', 1, 'x') as string
    keyring.lock()
    expect(() => cipher.seal('txn', 'notes', 1, 'x')).toThrowError(LockedError)
    expect(() => cipher.open('txn', 'notes', 1, sealed)).toThrowError(LockedError)
    expect(() => cipher.blindIndex('instrument', 'ticker', 1, 'AAPL')).toThrowError(LockedError)
  })

  it('decrypts again after an unlock with the same key, and fails closed with another', () => {
    const keyring = unlockedKeyring()
    const cipher = createFieldCipher(keyring)
    const sealed = cipher.seal('txn', 'notes', 1, 'persisted') as string
    keyring.lock()
    keyring.unlock(Buffer.from(DEK))
    expect(cipher.open('txn', 'notes', 1, sealed)).toBe('persisted')

    keyring.lock()
    keyring.unlock(Buffer.alloc(32, 0x33))
    expect(() => cipher.open('txn', 'notes', 1, sealed)).toThrow(/different key/)
  })

  it('passes plaintext through while the keyring is unprotected, and still refuses ciphertext', () => {
    const cipher = createFieldCipher(new Keyring({ protected: false }))
    expect(cipher.encrypting).toBe(false)
    expect(cipher.seal('txn', 'notes', 1, 'x')).toBe('x')
    expect(cipher.open('txn', 'notes', 1, 'x')).toBe('x')
    expect(cipher.blindIndex('instrument', 'ticker', 1, 'A')).toBeNull()

    const sealed = sealField(DEK, KEY_ID, 'txn', 'notes', 1, 'x')
    expect(() => cipher.open('txn', 'notes', 1, sealed)).toThrow(/without key slots/)
    expect(() => cipher.seal('txn', 'notes', 1, sealed)).toThrow(BadRequestError)
  })

  it('starts encrypting, without a restart, the moment the keyring is protected', () => {
    const keyring = new Keyring({ protected: false })
    const cipher = createFieldCipher(keyring)
    expect(cipher.seal('txn', 'notes', 1, 'before')).toBe('before')

    keyring.protect(Buffer.from(DEK))

    expect(cipher.encrypting).toBe(true)
    const sealed = cipher.seal('txn', 'notes', 1, 'after') as string
    expect(isSealed(sealed)).toBe(true)
    expect(cipher.open('txn', 'notes', 1, sealed)).toBe('after')
    expect(() => cipher.open('txn', 'notes', 1, 'before')).toThrow(/not in encrypted form/)
    expect(cipher.blindIndex('instrument', 'ticker', 1, 'A')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('cannot be protected twice', () => {
    const keyring = unlockedKeyring()
    expect(() => keyring.protect(Buffer.from(DEK))).toThrow(/already protected/)
  })

  it('rejects a column that is not encrypted', () => {
    const cipher = createFieldCipher(unlockedKeyring())
    expect(() => cipher.seal('txn', 'txn_date', 1, '2025-01-01')).toThrow(/not an encrypted column/)
    expect(() => cipher.open('txn', 'txn_date', 1, 'x')).toThrow(/not an encrypted column/)
  })

  it('computes the blind index from the held key', () => {
    const cipher = createFieldCipher(unlockedKeyring())
    expect(cipher.blindIndex('instrument', 'ticker', 1, 'AAPL')).toBe(
      blindIndex(DEK, 'instrument', 'ticker', 1, 'AAPL'),
    )
  })
})

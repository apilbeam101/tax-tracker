import { randomBytes } from 'node:crypto'
import type { Db } from '../db/database.ts'
import { ConflictError, NotFoundError } from '../errors.ts'
import { DecryptionError, fromBase64Url, KEY_LENGTH, open, seal, toBase64Url } from './aead.ts'
import {
  type Argon2idParams,
  DEFAULT_PASSPHRASE_KDF,
  deriveKekFromPassphrase,
  hkdf,
  type KdfParams,
  parseKdfParams,
} from './kdf.ts'
import { formatRecoveryKey, generateRecoveryKey, parseRecoveryKey } from './recovery.ts'

export type SlotType = 'passphrase' | 'recovery' | 'unattended'

const TENANT_ID = 1
const SALT_LENGTH = 32
const RECOVERY_KEK_INFO = 'tax-tracker recovery kek v1'
const KEY_ID_INFO = 'tax-tracker key id v1'

// The recovery key is 256 random bits, so HKDF is enough. Passphrase and unattended secrets are
// human- or operator-chosen strings and are stretched with argon2id.
const KDF_FOR_SLOT: Record<SlotType, KdfParams['kdf']> = {
  passphrase: 'argon2id',
  unattended: 'argon2id',
  recovery: 'hkdf-sha256',
}

interface SlotRow {
  slot_type: SlotType
  kdf_params: string
  salt: string
  wrapped_dek: string
  key_id: string
  created_at: string
  updated_at: string
}

// A slot that has been built (the slow argon2 work done) but not yet written. Callers that need
// the write to be atomic with other changes, such as the login hash, apply it inside their own
// transaction with applySlot().
export interface PreparedSlot {
  slotType: SlotType
  params: KdfParams
  salt: Buffer
  wrapped: Buffer
  keyId: string
}

export interface SlotInfo {
  slotType: SlotType
  keyId: string
  createdAt: string
  updatedAt: string
}

export interface KeySlotOptions {
  passphraseKdf?: Argon2idParams
}

export interface CreatedKeySlots {
  dek: Buffer
  keyId: string
  recoveryKey: string
}

// A short fingerprint of the DEK. It tags every slot and, later, every encrypted value, so a
// slot copied from another install or a rotated key is detected instead of silently misused.
// Changing this derivation makes every existing slot unreadable; a known-answer test pins it.
export function keyIdOf(dek: Buffer): string {
  return hkdf(dek, KEY_ID_INFO, Buffer.alloc(0), 4).toString('hex')
}

function wrapAad(slotType: SlotType, keyId: string): Buffer {
  return Buffer.from(`key_slot.${slotType}.${keyId}`, 'utf8')
}

function wipe(...buffers: Buffer[]): void {
  for (const b of buffers) b.fill(0)
}

// Fresh, non-pooled memory, so wiping it later does not depend on Node's shared Buffer pool.
function privateCopy(source: Buffer): Buffer {
  const copy = Buffer.alloc(source.length)
  source.copy(copy)
  return copy
}

function getSlot(db: Db, slotType: SlotType): SlotRow | undefined {
  return db
    .prepare(
      `SELECT slot_type, kdf_params, salt, wrapped_dek, key_id, created_at, updated_at
       FROM key_slot WHERE tenant_id = ? AND slot_type = ?`,
    )
    .get(TENANT_ID, slotType) as SlotRow | undefined
}

function validatedPassphraseKdf(options: KeySlotOptions): Argon2idParams {
  const params = options.passphraseKdf ?? DEFAULT_PASSPHRASE_KDF
  // Reject here what the reader would later reject, so a slot can never be written unreadable.
  parseKdfParams(JSON.stringify(params))
  return params
}

function audit(db: Db, action: string): void {
  db.prepare(
    'INSERT INTO audit_log (tenant_id, user_id, action, entity_type) VALUES (?, NULL, ?, ?)',
  ).run(TENANT_ID, action, 'key_slot')
}

function slotValues(r: PreparedSlot): [number, SlotType, string, string, string, string] {
  return [
    TENANT_ID,
    r.slotType,
    JSON.stringify(r.params),
    toBase64Url(r.salt),
    toBase64Url(r.wrapped),
    r.keyId,
  ]
}

function insertSlot(db: Db, r: PreparedSlot): void {
  db.prepare(
    `INSERT INTO key_slot (tenant_id, slot_type, kdf_params, salt, wrapped_dek, key_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(...slotValues(r))
}

// Replace the slot of this type, keeping created_at. Synchronous, so it can sit inside a
// caller's transaction; the slow part happens in the prepare*() functions beforehand.
export function applySlot(db: Db, r: PreparedSlot, action = `key_slot.${r.slotType}.set`): void {
  db.prepare(
    `INSERT INTO key_slot (tenant_id, slot_type, kdf_params, salt, wrapped_dek, key_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, slot_type) DO UPDATE SET
       kdf_params = excluded.kdf_params,
       salt = excluded.salt,
       wrapped_dek = excluded.wrapped_dek,
       key_id = excluded.key_id,
       updated_at = datetime('now')`,
  ).run(...slotValues(r))
  audit(db, action)
}

async function prepareArgon2Slot(
  slotType: 'passphrase' | 'unattended',
  dek: Buffer,
  secret: string,
  params: Argon2idParams,
): Promise<PreparedSlot> {
  const keyId = keyIdOf(dek)
  const salt = randomBytes(SALT_LENGTH)
  const kek = await deriveKekFromPassphrase(secret, salt, params)
  try {
    return { slotType, params, salt, wrapped: seal(kek, dek, wrapAad(slotType, keyId)), keyId }
  } finally {
    wipe(kek)
  }
}

export function preparePassphraseSlot(
  dek: Buffer,
  passphrase: string,
  options: KeySlotOptions = {},
): Promise<PreparedSlot> {
  return prepareArgon2Slot('passphrase', dek, passphrase, validatedPassphraseKdf(options))
}

export function prepareUnattendedSlot(dek: Buffer, key: string): Promise<PreparedSlot> {
  return prepareArgon2Slot('unattended', dek, key, DEFAULT_PASSPHRASE_KDF)
}

function prepareRecoverySlot(dek: Buffer, recoveryBytes: Buffer): PreparedSlot {
  const keyId = keyIdOf(dek)
  const salt = randomBytes(SALT_LENGTH)
  const kek = hkdf(recoveryBytes, RECOVERY_KEK_INFO, salt)
  try {
    return {
      slotType: 'recovery',
      params: { kdf: 'hkdf-sha256', info: RECOVERY_KEK_INFO },
      salt,
      wrapped: seal(kek, dek, wrapAad('recovery', keyId)),
      keyId,
    }
  } finally {
    wipe(kek)
  }
}

async function deriveKek(slot: SlotRow, secret: string | Buffer): Promise<Buffer> {
  const params = parseKdfParams(slot.kdf_params)
  if (params.kdf !== KDF_FOR_SLOT[slot.slot_type]) {
    throw new Error('Corrupt key slot: KDF does not match the slot type')
  }
  const salt = fromBase64Url(slot.salt)
  if (params.kdf === 'argon2id') {
    if (typeof secret !== 'string') throw new Error('Argon2id slots take a string secret')
    return deriveKekFromPassphrase(secret, salt, params)
  }
  if (typeof secret === 'string') throw new Error('HKDF slots take a binary secret')
  return hkdf(secret, params.info, salt)
}

// Returns null for any failure to open the slot (missing slot, wrong secret, tampered row), so
// callers cannot tell them apart; a structurally corrupt slot throws instead. A caller that has
// configured an unattended key and gets null for an existing slot should treat that as fatal
// rather than quietly staying locked.
async function unwrap(slot: SlotRow | undefined, secret: string | Buffer): Promise<Buffer | null> {
  if (!slot) return null
  const kek = await deriveKek(slot, secret)
  try {
    const opened = open(kek, fromBase64Url(slot.wrapped_dek), wrapAad(slot.slot_type, slot.key_id))
    const dek = privateCopy(opened)
    wipe(opened)
    if (dek.length !== KEY_LENGTH || keyIdOf(dek) !== slot.key_id) {
      wipe(dek)
      return null
    }
    return dek
  } catch (err) {
    if (err instanceof DecryptionError) return null
    throw err
  } finally {
    wipe(kek)
  }
}

function assertDekMatchesSlots(db: Db, dek: Buffer): void {
  const slot = getSlot(db, 'passphrase')
  if (!slot) throw new NotFoundError('No key slots exist yet')
  if (slot.key_id !== keyIdOf(dek)) throw new Error('DEK does not match the stored key slots')
}

// Any slot row means the database is protected. Checking a single slot type would let deleting one
// row quietly downgrade the app to "unprotected", so this fails closed.
export function hasKeySlots(db: Db): boolean {
  return (
    db.prepare('SELECT 1 AS present FROM key_slot WHERE tenant_id = ? LIMIT 1').get(TENANT_ID) !==
    undefined
  )
}

export function hasUnattendedSlot(db: Db): boolean {
  return getSlot(db, 'unattended') !== undefined
}

export function listSlots(db: Db): SlotInfo[] {
  const rows = db
    .prepare(
      'SELECT slot_type, key_id, created_at, updated_at FROM key_slot WHERE tenant_id = ? ORDER BY id',
    )
    .all(TENANT_ID) as Array<{
    slot_type: SlotType
    key_id: string
    created_at: string
    updated_at: string
  }>
  return rows.map((r) => ({
    slotType: r.slot_type,
    keyId: r.key_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

// Generates a fresh DEK and wraps it under the passphrase and a new recovery key. The recovery
// key is returned once, formatted for the user to write down; only its wrapping is stored.
// Uses SAVEPOINT rather than BEGIN so it also works inside a caller's transaction (the 2d
// upgrade), and a plain INSERT so a concurrent second call fails instead of overwriting the first.
export async function createKeySlots(
  db: Db,
  passphrase: string,
  options: KeySlotOptions = {},
): Promise<CreatedKeySlots> {
  if (hasKeySlots(db)) throw new ConflictError('Key slots already exist')

  const dek = randomBytes(KEY_LENGTH)
  const recoveryBytes = generateRecoveryKey()
  try {
    const passphraseSlot = await preparePassphraseSlot(dek, passphrase, options)
    const recoverySlot = prepareRecoverySlot(dek, recoveryBytes)

    db.exec('SAVEPOINT create_key_slots')
    try {
      insertSlot(db, passphraseSlot)
      insertSlot(db, recoverySlot)
      audit(db, 'key_slot.create')
      db.exec('RELEASE create_key_slots')
    } catch (err) {
      try {
        db.exec('ROLLBACK TO create_key_slots')
        db.exec('RELEASE create_key_slots')
      } catch {
        /* ignore secondary rollback failure */
      }
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
        throw new ConflictError('Key slots already exist')
      }
      throw err
    }
    return { dek, keyId: keyIdOf(dek), recoveryKey: formatRecoveryKey(recoveryBytes) }
  } catch (err) {
    wipe(dek)
    throw err
  } finally {
    wipe(recoveryBytes)
  }
}

export async function unlockWithPassphrase(db: Db, passphrase: string): Promise<Buffer | null> {
  return unwrap(getSlot(db, 'passphrase'), passphrase)
}

export async function unlockWithRecoveryKey(db: Db, recoveryKey: string): Promise<Buffer | null> {
  const bytes = parseRecoveryKey(recoveryKey)
  try {
    return await unwrap(getSlot(db, 'recovery'), bytes)
  } finally {
    wipe(bytes)
  }
}

export async function unlockWithUnattendedKey(db: Db, key: string): Promise<Buffer | null> {
  return unwrap(getSlot(db, 'unattended'), key)
}

// Rewraps only the passphrase slot with a fresh salt; no field data is touched. Callers that must
// also update the login hash atomically use preparePassphraseSlot() + applySlot() in their own
// transaction instead.
export async function changePassphrase(
  db: Db,
  dek: Buffer,
  newPassphrase: string,
  options: KeySlotOptions = {},
): Promise<void> {
  assertDekMatchesSlots(db, dek)
  applySlot(
    db,
    await preparePassphraseSlot(dek, newPassphrase, options),
    'key_slot.passphrase.change',
  )
}

// "Forgot passphrase": the recovery key unlocks the DEK, which is then wrapped under the new
// passphrase. Returns the unlocked DEK, or null if the recovery key is the wrong one.
export async function resetPassphraseWithRecoveryKey(
  db: Db,
  recoveryKey: string,
  newPassphrase: string,
  options: KeySlotOptions = {},
): Promise<Buffer | null> {
  const dek = await unlockWithRecoveryKey(db, recoveryKey)
  if (!dek) return null
  try {
    const slot = await preparePassphraseSlot(dek, newPassphrase, options)
    applySlot(db, slot, 'key_slot.passphrase.reset')
    return dek
  } catch (err) {
    wipe(dek)
    throw err
  }
}

// Replaces a lost or exposed recovery key. Requires the unlocked DEK, so it cannot be used to
// get in; the old recovery key stops working immediately.
export function rotateRecoveryKey(db: Db, dek: Buffer): string {
  assertDekMatchesSlots(db, dek)
  const bytes = generateRecoveryKey()
  try {
    applySlot(db, prepareRecoverySlot(dek, bytes), 'key_slot.recovery.rotate')
    return formatRecoveryKey(bytes)
  } finally {
    wipe(bytes)
  }
}

export async function setUnattendedKey(db: Db, dek: Buffer, key: string): Promise<void> {
  assertDekMatchesSlots(db, dek)
  applySlot(db, await prepareUnattendedSlot(dek, key), 'key_slot.unattended.set')
}

export function removeUnattendedKey(db: Db): boolean {
  const result = db
    .prepare('DELETE FROM key_slot WHERE tenant_id = ? AND slot_type = ?')
    .run(TENANT_ID, 'unattended')
  if (result.changes > 0) audit(db, 'key_slot.unattended.remove')
  return result.changes > 0
}

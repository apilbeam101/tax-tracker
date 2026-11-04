import { createHash, randomBytes } from 'node:crypto'
import { BadRequestError } from '../errors.ts'
import { KEY_LENGTH } from './aead.ts'

// Crockford base32: no I, L, O or U, so a hand-copied key is hard to misread.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CHECKSUM_BYTES = 2
const PAYLOAD_BYTES = KEY_LENGTH + CHECKSUM_BYTES
const ENCODED_CHARS = Math.ceil((PAYLOAD_BYTES * 8) / 5)
const GROUP_SIZE = 5

export class InvalidRecoveryKeyError extends BadRequestError {
  constructor() {
    super('That recovery key is not valid. Check it for typos and try again.')
  }
}

function checksum(key: Buffer): Buffer {
  return createHash('sha256')
    .update('tax-tracker recovery key v1')
    .update(key)
    .digest()
    .subarray(0, CHECKSUM_BYTES)
}

function encodeBase32(data: Buffer): string {
  let bits = 0
  let acc = 0
  let out = ''
  for (const byte of data) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
    acc &= (1 << bits) - 1
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31]
  return out
}

// Returns null on any non-canonical input, including non-zero trailing padding bits.
function decodeBase32(text: string, byteLength: number): Buffer | null {
  const out = Buffer.alloc(byteLength)
  let bits = 0
  let acc = 0
  let written = 0
  for (const ch of text) {
    const value = ALPHABET.indexOf(ch)
    if (value === -1) return null
    acc = (acc << 5) | value
    bits += 5
    if (bits >= 8) {
      if (written >= byteLength) return null
      out[written++] = (acc >>> (bits - 8)) & 255
      bits -= 8
    }
    acc &= (1 << bits) - 1
  }
  if (written !== byteLength || acc !== 0) return null
  return out
}

export function generateRecoveryKey(): Buffer {
  return randomBytes(KEY_LENGTH)
}

// 55 characters in 11 groups of 5; the last two bytes of the payload are a checksum.
export function formatRecoveryKey(key: Buffer): string {
  if (key.length !== KEY_LENGTH) throw new Error(`Recovery key must be ${KEY_LENGTH} bytes`)
  const payload = Buffer.concat([key, checksum(key)])
  const encoded = encodeBase32(payload)
  payload.fill(0)
  const groups: string[] = []
  for (let i = 0; i < encoded.length; i += GROUP_SIZE) groups.push(encoded.slice(i, i + GROUP_SIZE))
  return groups.join('-')
}

export function parseRecoveryKey(text: string): Buffer {
  const normalised = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (normalised.length !== ENCODED_CHARS) throw new InvalidRecoveryKeyError()
  const payload = decodeBase32(normalised, PAYLOAD_BYTES)
  if (!payload) throw new InvalidRecoveryKeyError()
  try {
    const key = payload.subarray(0, KEY_LENGTH)
    if (!checksum(key).equals(payload.subarray(KEY_LENGTH))) throw new InvalidRecoveryKeyError()
    const copy = Buffer.alloc(KEY_LENGTH)
    key.copy(copy)
    return copy
  } finally {
    payload.fill(0)
  }
}

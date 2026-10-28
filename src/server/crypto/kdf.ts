import { hkdfSync } from 'node:crypto'
import { Algorithm, hashRaw } from '@node-rs/argon2'
import { KEY_LENGTH } from './aead.ts'

export interface Argon2idParams {
  kdf: 'argon2id'
  memoryKiB: number
  timeCost: number
  parallelism: number
}

export interface HkdfParams {
  kdf: 'hkdf-sha256'
  info: string
}

export type KdfParams = Argon2idParams | HkdfParams

// Separate from the login password-verification hash on purpose: that hash is
// stored and can be attacked offline on its own, so the KEK must not be derivable from it.
export const DEFAULT_PASSPHRASE_KDF: Argon2idParams = {
  kdf: 'argon2id',
  memoryKiB: 65536,
  timeCost: 3,
  parallelism: 4,
}

// NFKC so the same passphrase typed on different platforms/keyboards derives the same key.
export async function deriveKekFromPassphrase(
  passphrase: string,
  salt: Buffer,
  params: Argon2idParams,
): Promise<Buffer> {
  return hashRaw(passphrase.normalize('NFKC'), {
    algorithm: Algorithm.Argon2id,
    memoryCost: params.memoryKiB,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
    outputLen: KEY_LENGTH,
    salt,
  })
}

export function hkdf(
  ikm: Buffer,
  info: string | Buffer,
  salt: Buffer = Buffer.alloc(0),
  length = KEY_LENGTH,
): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length))
}

function isPositiveInt(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max
}

export function parseKdfParams(json: string): KdfParams {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('Corrupt key slot: kdf_params is not valid JSON')
  }
  const p = raw as Record<string, unknown>
  if (
    p.kdf === 'argon2id' &&
    isPositiveInt(p.memoryKiB, 1_048_576) &&
    isPositiveInt(p.timeCost, 100) &&
    isPositiveInt(p.parallelism, 64)
  ) {
    return {
      kdf: 'argon2id',
      memoryKiB: p.memoryKiB,
      timeCost: p.timeCost,
      parallelism: p.parallelism,
    }
  }
  if (p.kdf === 'hkdf-sha256' && typeof p.info === 'string') {
    return { kdf: 'hkdf-sha256', info: p.info }
  }
  throw new Error('Corrupt key slot: unrecognised kdf_params')
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const KEY_LENGTH = 32
export const NONCE_LENGTH = 12
export const TAG_LENGTH = 16

export class DecryptionError extends Error {
  constructor() {
    super('Decryption failed')
    this.name = 'DecryptionError'
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_LENGTH) throw new Error(`AES-256-GCM key must be ${KEY_LENGTH} bytes`)
}

// Exposed so known-answer vectors can pin the nonce; production code calls seal().
export function sealWithNonce(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  assertKey(key)
  if (nonce.length !== NONCE_LENGTH) throw new Error(`Nonce must be ${NONCE_LENGTH} bytes`)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH })
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()])
}

// Output layout: nonce || ciphertext || tag. A fresh random 96-bit nonce per value.
export function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  return sealWithNonce(key, randomBytes(NONCE_LENGTH), plaintext, aad)
}

// Every failure (wrong key, tampered nonce/ciphertext/tag, wrong AAD, truncation)
// raises the same opaque error so callers cannot be used as a decryption oracle.
export function open(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  assertKey(key)
  if (sealed.length < NONCE_LENGTH + TAG_LENGTH) throw new DecryptionError()
  const nonce = sealed.subarray(0, NONCE_LENGTH)
  const tag = sealed.subarray(sealed.length - TAG_LENGTH)
  const ciphertext = sealed.subarray(NONCE_LENGTH, sealed.length - TAG_LENGTH)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH })
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new DecryptionError()
  }
}

export function toBase64Url(data: Buffer): string {
  return data.toString('base64url')
}

export function fromBase64Url(text: string): Buffer {
  return Buffer.from(text, 'base64url')
}

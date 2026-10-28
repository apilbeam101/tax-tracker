import { describe, expect, it } from 'vitest'
import { DecryptionError, NONCE_LENGTH, open, seal, sealWithNonce, TAG_LENGTH } from './aead.ts'

const key = Buffer.alloc(32, 0x42)
const aad = Buffer.from('txn.notes.17')
const plaintext = Buffer.from('a quantity of 123.456 shares')

describe('AES-256-GCM known answer', () => {
  it('matches NIST GCM test case 15 (AES-256, 96-bit IV, no AAD)', () => {
    const k = Buffer.from('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308', 'hex')
    const iv = Buffer.from('cafebabefacedbaddecaf888', 'hex')
    const p = Buffer.from(
      'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72' +
        '1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255',
      'hex',
    )
    const expectedCiphertext =
      '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa' +
      '8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad'
    const expectedTag = 'b094dac5d93471bdec1a502270e3cc6c'

    const sealed = sealWithNonce(k, iv, p, Buffer.alloc(0))
    expect(sealed.subarray(0, NONCE_LENGTH).toString('hex')).toBe(iv.toString('hex'))
    expect(sealed.subarray(NONCE_LENGTH, sealed.length - TAG_LENGTH).toString('hex')).toBe(
      expectedCiphertext,
    )
    expect(sealed.subarray(sealed.length - TAG_LENGTH).toString('hex')).toBe(expectedTag)
    expect(open(k, sealed, Buffer.alloc(0)).equals(p)).toBe(true)
  })
})

describe('seal / open', () => {
  it('round-trips, including empty plaintext', () => {
    expect(open(key, seal(key, plaintext, aad), aad).equals(plaintext)).toBe(true)
    expect(open(key, seal(key, Buffer.alloc(0), aad), aad).length).toBe(0)
  })

  it('uses a fresh nonce for every value', () => {
    const nonces = new Set<string>()
    for (let i = 0; i < 200; i++) {
      nonces.add(seal(key, plaintext, aad).subarray(0, NONCE_LENGTH).toString('hex'))
    }
    expect(nonces.size).toBe(200)
  })

  it('does not contain the plaintext in the output', () => {
    expect(seal(key, plaintext, aad).includes(plaintext)).toBe(false)
  })

  it.each([
    ['nonce', 0],
    ['ciphertext', NONCE_LENGTH + 1],
    ['tag', -1],
  ])('rejects a flipped bit in the %s', (_name, index) => {
    const sealed = seal(key, plaintext, aad)
    const i = index < 0 ? sealed.length + index : index
    sealed[i] = (sealed[i] ?? 0) ^ 0x01
    expect(() => open(key, sealed, aad)).toThrowError(DecryptionError)
  })

  it('rejects a different AAD (value moved to another row or column)', () => {
    const sealed = seal(key, plaintext, aad)
    expect(() => open(key, sealed, Buffer.from('txn.notes.18'))).toThrowError(DecryptionError)
    expect(() => open(key, sealed, Buffer.from('txn.quantity.17'))).toThrowError(DecryptionError)
  })

  it('rejects the wrong key', () => {
    const sealed = seal(key, plaintext, aad)
    expect(() => open(Buffer.alloc(32, 0x43), sealed, aad)).toThrowError(DecryptionError)
  })

  it('rejects truncated input without an out-of-range error', () => {
    expect(() => open(key, Buffer.alloc(NONCE_LENGTH + TAG_LENGTH - 1), aad)).toThrowError(
      DecryptionError,
    )
    expect(() => open(key, Buffer.alloc(0), aad)).toThrowError(DecryptionError)
  })

  it('rejects keys that are not 32 bytes', () => {
    expect(() => seal(Buffer.alloc(16), plaintext, aad)).toThrowError(/32 bytes/)
    expect(() => open(Buffer.alloc(31), Buffer.alloc(40), aad)).toThrowError(/32 bytes/)
  })

  it('gives the same opaque error for every failure kind', () => {
    const sealed = seal(key, plaintext, aad)
    const tampered = Buffer.from(sealed)
    tampered[NONCE_LENGTH] = (tampered[NONCE_LENGTH] ?? 0) ^ 0xff
    const messages = [
      () => open(Buffer.alloc(32, 1), sealed, aad),
      () => open(key, tampered, aad),
      () => open(key, sealed, Buffer.from('x')),
      () => open(key, Buffer.alloc(3), aad),
    ].map((fn) => {
      try {
        fn()
      } catch (err) {
        return (err as Error).message
      }
      return 'no error'
    })
    expect(new Set(messages)).toEqual(new Set(['Decryption failed']))
  })
})

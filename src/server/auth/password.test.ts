import { Algorithm, hash } from '@node-rs/argon2'
import { beforeAll, describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password.ts'

const COMPOSED = 'café au lait passphrase'
const DECOMPOSED = 'café au lait passphrase'

let normalisedHash: string
let legacyRawHash: string

beforeAll(async () => {
  normalisedHash = await hashPassword(DECOMPOSED)
  // Hashes created before normalisation was added were made from the raw typed string.
  legacyRawHash = await hash(DECOMPOSED, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  })
})

describe('password hashing and Unicode normalisation', () => {
  it('uses different bytes for the two forms, so the test below means something', () => {
    expect(COMPOSED).not.toBe(DECOMPOSED)
    expect(COMPOSED.normalize('NFKC')).toBe(DECOMPOSED.normalize('NFKC'))
  })

  it('a new hash accepts either form of the same passphrase', async () => {
    expect(await verifyPassword(normalisedHash, COMPOSED)).toBe(true)
    expect(await verifyPassword(normalisedHash, DECOMPOSED)).toBe(true)
  })

  it('a legacy hash of the raw string still verifies that exact string', async () => {
    expect(await verifyPassword(legacyRawHash, DECOMPOSED)).toBe(true)
  })

  it('rejects a different passphrase', async () => {
    expect(await verifyPassword(normalisedHash, 'a different passphrase')).toBe(false)
    expect(await verifyPassword(legacyRawHash, 'a different passphrase')).toBe(false)
  })
})

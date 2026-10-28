import { argon2Sync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type Argon2idParams, deriveKekFromPassphrase, hkdf, parseKdfParams } from './kdf.ts'

const FAST: Argon2idParams = { kdf: 'argon2id', memoryKiB: 64, timeCost: 1, parallelism: 1 }
const salt = Buffer.alloc(32, 9)

describe('hkdf', () => {
  it('matches RFC 5869 test case 1', () => {
    const okm = hkdf(
      Buffer.alloc(22, 0x0b),
      Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'),
      Buffer.from('000102030405060708090a0b0c', 'hex'),
      42,
    )
    expect(okm.toString('hex')).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    )
  })

  it('gives independent keys for different info strings', () => {
    const ikm = Buffer.alloc(32, 1)
    expect(hkdf(ikm, 'a').equals(hkdf(ikm, 'b'))).toBe(false)
  })
})

describe('deriveKekFromPassphrase', () => {
  it('is deterministic for the same passphrase, salt and params', async () => {
    const a = await deriveKekFromPassphrase('correct horse', salt, FAST)
    const b = await deriveKekFromPassphrase('correct horse', salt, FAST)
    expect(a.equals(b)).toBe(true)
    expect(a.length).toBe(32)
  })

  it('differs by passphrase, salt and cost parameters', async () => {
    const base = await deriveKekFromPassphrase('correct horse', salt, FAST)
    expect((await deriveKekFromPassphrase('correct horsf', salt, FAST)).equals(base)).toBe(false)
    expect(
      (await deriveKekFromPassphrase('correct horse', Buffer.alloc(32, 8), FAST)).equals(base),
    ).toBe(false)
    expect(
      (await deriveKekFromPassphrase('correct horse', salt, { ...FAST, timeCost: 2 })).equals(base),
    ).toBe(false)
  })

  const KAT: Argon2idParams = { kdf: 'argon2id', memoryKiB: 64, timeCost: 2, parallelism: 3 }

  it('derives the exact KEK installed databases depend on (pinned)', async () => {
    const kek = await deriveKekFromPassphrase('correct horse battery', salt, KAT)
    expect(kek.toString('hex')).toBe(
      'caaa02808921a52514a27fa6ca297cc289d9e56ac8ea7242c241446cf096ea4b',
    )
  })

  it('agrees with Node’s own argon2id, so the cost parameters are mapped correctly', async () => {
    const expected = argon2Sync('argon2id', {
      message: 'correct horse battery',
      nonce: salt,
      parallelism: KAT.parallelism,
      tagLength: 32,
      memory: KAT.memoryKiB,
      passes: KAT.timeCost,
    })
    const kek = await deriveKekFromPassphrase('correct horse battery', salt, KAT)
    expect(kek.equals(expected)).toBe(true)
  })

  it('pins the NFKC-normalised result for both Unicode forms', async () => {
    const golden = '23121105a73557aac52e106fc661c847709f235ca28e21d79a880ef369e838ad'
    expect((await deriveKekFromPassphrase('café', salt, KAT)).toString('hex')).toBe(golden)
    expect((await deriveKekFromPassphrase('café', salt, KAT)).toString('hex')).toBe(golden)
  })

  it('treats canonically equivalent Unicode as the same passphrase', async () => {
    const composed = 'café ordering'
    const decomposed = 'café ordering'
    expect(composed).not.toBe(decomposed)
    const a = await deriveKekFromPassphrase(composed, salt, FAST)
    const b = await deriveKekFromPassphrase(decomposed, salt, FAST)
    expect(a.equals(b)).toBe(true)
  })
})

describe('parseKdfParams', () => {
  it('round-trips valid argon2id and hkdf params', () => {
    expect(parseKdfParams(JSON.stringify(FAST))).toEqual(FAST)
    expect(parseKdfParams('{"kdf":"hkdf-sha256","info":"x"}')).toEqual({
      kdf: 'hkdf-sha256',
      info: 'x',
    })
  })

  it.each([
    'not json',
    '{}',
    '{"kdf":"pbkdf2"}',
    '{"kdf":"argon2id","memoryKiB":0,"timeCost":1,"parallelism":1}',
    '{"kdf":"argon2id","memoryKiB":64,"timeCost":1.5,"parallelism":1}',
    '{"kdf":"argon2id","memoryKiB":64,"timeCost":1,"parallelism":"4"}',
    '{"kdf":"argon2id","memoryKiB":99999999999,"timeCost":1,"parallelism":1}',
    '{"kdf":"hkdf-sha256"}',
  ])('rejects %s', (json) => {
    expect(() => parseKdfParams(json)).toThrowError(/Corrupt key slot/)
  })
})

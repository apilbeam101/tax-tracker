import { describe, expect, it } from 'vitest'
import {
  formatRecoveryKey,
  generateRecoveryKey,
  InvalidRecoveryKeyError,
  parseRecoveryKey,
} from './recovery.ts'

const FIXED = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 255))
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

describe('recovery key format', () => {
  it('is 11 dash-separated groups of 5 Crockford base32 characters', () => {
    const text = formatRecoveryKey(generateRecoveryKey())
    expect(text).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/)
  })

  it('round-trips random keys', () => {
    for (let i = 0; i < 50; i++) {
      const key = generateRecoveryKey()
      expect(parseRecoveryKey(formatRecoveryKey(key)).equals(key)).toBe(true)
    }
  })

  it('generates different keys each time', () => {
    expect(generateRecoveryKey().equals(generateRecoveryKey())).toBe(false)
  })

  it('encodes a fixed key exactly as written-down recovery keys will be (pinned)', () => {
    expect(formatRecoveryKey(FIXED)).toBe(
      '0C512-60Z4R-PK8ET-29585-EQK5D-HSQN0-C8HYB-9V95B-PAWW1-HYETQ-E8N9G',
    )
  })

  it('round-trips a fixed key through its text form', () => {
    const text = formatRecoveryKey(FIXED)
    expect(parseRecoveryKey(text).equals(FIXED)).toBe(true)
    expect(formatRecoveryKey(parseRecoveryKey(text))).toBe(text)
  })

  it('tolerates case, spacing, missing dashes and look-alike characters', () => {
    const text = formatRecoveryKey(FIXED)
    expect(parseRecoveryKey(text.toLowerCase()).equals(FIXED)).toBe(true)
    expect(parseRecoveryKey(text.replace(/-/g, ' ')).equals(FIXED)).toBe(true)
    expect(parseRecoveryKey(` ${text.replace(/-/g, '')}\n`).equals(FIXED)).toBe(true)
    const swapped = text.replace(/0/g, 'O').replace(/1/g, 'l')
    expect(parseRecoveryKey(swapped).equals(FIXED)).toBe(true)
  })
})

describe('recovery key checksum', () => {
  const text = formatRecoveryKey(FIXED)
  const chars = text.replace(/-/g, '')

  it('rejects every single-character substitution (for this fixed key)', () => {
    for (let i = 0; i < chars.length; i++) {
      for (const replacement of ALPHABET) {
        if (replacement === chars[i]) continue
        const mutated = chars.slice(0, i) + replacement + chars.slice(i + 1)
        expect(() => parseRecoveryKey(mutated), `position ${i} -> ${replacement}`).toThrowError(
          InvalidRecoveryKeyError,
        )
      }
    }
  })

  it('rejects a swap of two adjacent different characters', () => {
    for (let i = 0; i < chars.length - 1; i++) {
      if (chars[i] === chars[i + 1]) continue
      const swapped = chars.slice(0, i) + chars[i + 1] + chars[i] + chars.slice(i + 2)
      expect(() => parseRecoveryKey(swapped), `swap at ${i}`).toThrowError(InvalidRecoveryKeyError)
    }
  })

  it.each([
    ['empty', ''],
    ['too short', 'ABCDE-FGHJK'],
    ['too long', `${chars}0`],
    ['an excluded letter (U)', `U${chars.slice(1)}`],
    ['punctuation', `!${chars.slice(1)}`],
  ])('rejects %s', (_name, input) => {
    expect(() => parseRecoveryKey(input)).toThrowError(InvalidRecoveryKeyError)
  })

  it('rejects non-zero padding bits in the final character', () => {
    const last = chars[chars.length - 1] as string
    const flipped = ALPHABET[ALPHABET.indexOf(last) ^ 1] as string
    expect(() => parseRecoveryKey(chars.slice(0, -1) + flipped)).toThrowError(
      InvalidRecoveryKeyError,
    )
  })

  it('is a client error, not an internal one', () => {
    expect.assertions(1)
    try {
      parseRecoveryKey('nope')
    } catch (err) {
      expect((err as InvalidRecoveryKeyError).statusCode).toBe(400)
    }
  })
})

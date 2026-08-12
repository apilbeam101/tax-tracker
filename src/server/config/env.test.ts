import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildConfig } from './env.ts'

const ENV_KEYS = [
  'HOST',
  'PORT',
  'DB_PATH',
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
  'TIINGO_API_KEY',
  'ALPHA_VANTAGE_API_KEY',
  'FX_RATE_POLICY',
  'NODE_ENV',
] as const

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.SESSION_SECRET = 'test-session-secret'
  process.env.ENCRYPTION_KEY = 'test-encryption-key'
  for (const key of ENV_KEYS) {
    if (key !== 'SESSION_SECRET' && key !== 'ENCRYPTION_KEY') delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('buildConfig', () => {
  it('builds a valid config from minimal required env vars', () => {
    const config = buildConfig()
    expect(config).toEqual({
      host: '127.0.0.1',
      port: 3000,
      dbPath: './data/taxtracker.db',
      sessionSecret: 'test-session-secret',
      encryptionKey: 'test-encryption-key',
      tiingoApiKey: '',
      alphaVantageApiKey: '',
      fxRatePolicy: 'hmrc-monthly',
      isProduction: false,
    })
  })

  it('reports every missing/invalid var in a single error, not just the first', () => {
    delete process.env.SESSION_SECRET
    delete process.env.ENCRYPTION_KEY
    process.env.PORT = 'not-a-number'
    process.env.FX_RATE_POLICY = 'bogus'

    let message = ''
    try {
      buildConfig()
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('SESSION_SECRET')
    expect(message).toContain('ENCRYPTION_KEY')
    expect(message).toContain('PORT')
    expect(message).toContain('FX_RATE_POLICY')
  })

  it.each(['0', '65536', '-1', 'abc', '3.5'])('rejects an invalid PORT value: %s', (raw) => {
    process.env.PORT = raw
    expect(() => buildConfig()).toThrowError(/PORT must be an integer between 1 and 65535/)
  })

  it.each(['hmrc-monthly', 'daily-spot'])('accepts FX_RATE_POLICY: %s', (policy) => {
    process.env.FX_RATE_POLICY = policy
    expect(buildConfig().fxRatePolicy).toBe(policy)
  })

  it('rejects an unknown FX_RATE_POLICY', () => {
    process.env.FX_RATE_POLICY = 'bogus'
    expect(() => buildConfig()).toThrowError(/FX_RATE_POLICY must be one of/)
  })
})

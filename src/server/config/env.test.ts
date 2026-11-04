import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildConfig } from './env.ts'

const ENV_KEYS = [
  'HOST',
  'PORT',
  'DB_PATH',
  'DATA_DIR',
  'SESSION_SECRET',
  'SESSION_SECRET_FILE',
  'ENCRYPTION_KEY',
  'ENCRYPTION_KEY_FILE',
  'TIINGO_API_KEY',
  'TIINGO_API_KEY_FILE',
  'ALPHA_VANTAGE_API_KEY',
  'ALPHA_VANTAGE_API_KEY_FILE',
  'FX_RATE_POLICY',
  'SECURE_COOKIES',
  'TRUST_PROXY',
  'LOG_LEVEL',
  'GIT_COMMIT',
  'AUTO_CONFIG',
  'BACKUP_SCHEDULE',
  'RESTORE_RESTART',
] as const

const SESSION = 'a'.repeat(64)
const ENCRYPTION = 'b'.repeat(64)

let saved: Record<string, string | undefined>
let tmp: string

beforeEach(() => {
  saved = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.SESSION_SECRET = SESSION
  process.env.ENCRYPTION_KEY = ENCRYPTION
  process.env.DB_PATH = './data/taxtracker.db'
  tmp = mkdtempSync(join(tmpdir(), 'tt-env-'))
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(tmp, { recursive: true, force: true })
})

function errorOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return (err as Error).message
  }
  return ''
}

describe('buildConfig', () => {
  it('builds a valid config from minimal required env vars', () => {
    expect(buildConfig()).toEqual({
      host: '127.0.0.1',
      port: 3000,
      dbPath: resolve('./data/taxtracker.db'),
      dataDir: resolve('./data'),
      dataDirSource: 'DB_PATH',
      sessionSecret: SESSION,
      encryptionKey: ENCRYPTION,
      tiingoApiKey: '',
      alphaVantageApiKey: '',
      fxRatePolicy: 'hmrc-monthly',
      secureCookies: 'auto',
      trustProxy: false,
      backupSchedule: 'off',
      restoreRestart: 'manual',
      logLevel: 'info',
      gitCommit: 'unknown',
    })
  })

  it('takes the commit from GIT_COMMIT', () => {
    process.env.GIT_COMMIT = 'abc1234'
    expect(buildConfig().gitCommit).toBe('abc1234')
  })

  it('treats empty SECURE_COOKIES and LOG_LEVEL as unset, as templated compose files produce', () => {
    process.env.SECURE_COOKIES = ''
    process.env.LOG_LEVEL = ''
    const config = buildConfig()
    expect(config.secureCookies).toBe('auto')
    expect(config.logLevel).toBe('info')
  })

  it('reports every missing/invalid var in a single error, not just the first', () => {
    delete process.env.SESSION_SECRET
    process.env.ENCRYPTION_KEY = 'short'
    process.env.PORT = 'not-a-number'
    process.env.FX_RATE_POLICY = 'bogus'
    process.env.SECURE_COOKIES = 'maybe'

    const message = errorOf(() => buildConfig())
    expect(message).toContain('SESSION_SECRET')
    expect(message).toContain('ENCRYPTION_KEY')
    expect(message).toContain('PORT')
    expect(message).toContain('FX_RATE_POLICY')
    expect(message).toContain('SECURE_COOKIES')
  })

  it.each(['65536', '-1', 'abc', '3.5'])('rejects an invalid PORT value: %s', (raw) => {
    process.env.PORT = raw
    expect(() => buildConfig()).toThrowError(/PORT must be an integer between 0 and 65535/)
  })

  it('defaults BACKUP_SCHEDULE to daily in self-configured mode and off otherwise', () => {
    expect(buildConfig().backupSchedule).toBe('off')
    process.env.AUTO_CONFIG = 'true'
    expect(buildConfig().backupSchedule).toBe('daily')
    process.env.BACKUP_SCHEDULE = 'off'
    expect(buildConfig().backupSchedule).toBe('off')
    process.env.BACKUP_SCHEDULE = 'weekly'
    expect(() => buildConfig()).toThrowError(/BACKUP_SCHEDULE must be one of/)
  })

  it('validates RESTORE_RESTART', () => {
    process.env.RESTORE_RESTART = 'exit'
    expect(buildConfig().restoreRestart).toBe('exit')
    process.env.RESTORE_RESTART = 'reboot'
    expect(() => buildConfig()).toThrowError(/RESTORE_RESTART must be one of/)
  })

  it('accepts PORT 0, which asks the OS for a free port', () => {
    process.env.PORT = '0'
    expect(buildConfig().port).toBe(0)
  })

  it.each(['hmrc-monthly', 'daily-spot'])('accepts FX_RATE_POLICY: %s', (policy) => {
    process.env.FX_RATE_POLICY = policy
    expect(buildConfig().fxRatePolicy).toBe(policy)
  })

  it('rejects an unknown FX_RATE_POLICY', () => {
    process.env.FX_RATE_POLICY = 'bogus'
    expect(() => buildConfig()).toThrowError(/FX_RATE_POLICY must be one of/)
  })

  it('treats ENCRYPTION_KEY as optional', () => {
    delete process.env.ENCRYPTION_KEY
    expect(buildConfig().encryptionKey).toBeUndefined()
  })

  it.each([
    ['auto', 'auto'],
    ['true', true],
    ['false', false],
  ])('parses SECURE_COOKIES=%s', (raw, expected) => {
    process.env.SECURE_COOKIES = raw
    expect(buildConfig().secureCookies).toBe(expected)
  })

  it.each([
    [undefined, false],
    ['false', false],
    ['true', true],
    ['10.0.0.0/8', '10.0.0.0/8'],
    ['127.0.0.1, ::1', '127.0.0.1, ::1'],
    ['loopback,uniquelocal', 'loopback,uniquelocal'],
  ])('parses TRUST_PROXY=%s', (raw, expected) => {
    if (raw !== undefined) process.env.TRUST_PROXY = raw
    expect(buildConfig().trustProxy).toBe(expected)
  })

  it.each(['1', '2', 'True', 'yes', '10.0.0.0/33', '10.0.0.0/8/1', 'loopback,nope'])(
    'rejects TRUST_PROXY=%s (hop counts trust nothing in Fastify; others crash boot)',
    (raw) => {
      process.env.TRUST_PROXY = raw
      expect(() => buildConfig()).toThrowError(/TRUST_PROXY must be/)
    },
  )

  it('rejects an unknown LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'loud'
    expect(() => buildConfig()).toThrowError(/LOG_LEVEL must be one of/)
  })
})

describe('secret validation', () => {
  it.each([
    'CHANGE_ME_generate_a_random_32_byte_hex_string',
    'change_me',
    `CHANGEME${'x'.repeat(60)}`,
  ])('rejects placeholder %s', (value) => {
    process.env.SESSION_SECRET = value
    expect(() => buildConfig()).toThrowError(/SESSION_SECRET is still a placeholder/)
  })

  it('rejects a hex secret shorter than 64 characters', () => {
    process.env.ENCRYPTION_KEY = 'ab'.repeat(20)
    expect(() => buildConfig()).toThrowError(/ENCRYPTION_KEY is too short/)
  })

  it('rejects a non-hex secret shorter than 32 characters', () => {
    process.env.SESSION_SECRET = 'z'.repeat(31)
    expect(() => buildConfig()).toThrowError(/SESSION_SECRET is too short/)
  })

  it('accepts a non-hex secret of 32 characters', () => {
    process.env.SESSION_SECRET = 'z'.repeat(32)
    expect(buildConfig().sessionSecret).toBe('z'.repeat(32))
  })
})

describe('_FILE secret variants', () => {
  it('reads a secret from SESSION_SECRET_FILE and trims the trailing newline', () => {
    const file = join(tmp, 'session')
    writeFileSync(file, `${'c'.repeat(64)}\n`)
    delete process.env.SESSION_SECRET
    process.env.SESSION_SECRET_FILE = file
    expect(buildConfig().sessionSecret).toBe('c'.repeat(64))
  })

  it('reads optional API keys from _FILE variants', () => {
    const file = join(tmp, 'tiingo')
    writeFileSync(file, 'tiingo-key\n')
    process.env.TIINGO_API_KEY_FILE = file
    expect(buildConfig().tiingoApiKey).toBe('tiingo-key')
  })

  it('validates the strength of a secret read from a file', () => {
    const file = join(tmp, 'enc')
    writeFileSync(file, 'tooshort')
    delete process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY_FILE = file
    expect(() => buildConfig()).toThrowError(/ENCRYPTION_KEY is too short/)
  })

  it('reports an unreadable file without also claiming the var is missing', () => {
    delete process.env.SESSION_SECRET
    process.env.SESSION_SECRET_FILE = join(tmp, 'does-not-exist')
    const message = errorOf(() => buildConfig())
    expect(message).toContain('SESSION_SECRET_FILE could not be read')
    expect(message).not.toContain('Missing required environment variable: SESSION_SECRET')
  })

  it('reports an empty file as empty, not as a missing or absent secret', () => {
    const file = join(tmp, 'enc')
    writeFileSync(file, '\n')
    delete process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY_FILE = file
    expect(() => buildConfig()).toThrowError(/ENCRYPTION_KEY_FILE is empty/)

    delete process.env.SESSION_SECRET
    process.env.SESSION_SECRET_FILE = file
    expect(errorOf(() => buildConfig())).not.toContain('Missing required')
  })

  it('rejects setting both the direct var and its _FILE variant', () => {
    const file = join(tmp, 'session')
    writeFileSync(file, 'c'.repeat(64))
    process.env.SESSION_SECRET_FILE = file
    expect(() => buildConfig()).toThrowError(/SESSION_SECRET and SESSION_SECRET_FILE are both set/)
  })
})

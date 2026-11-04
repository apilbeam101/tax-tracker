import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './env.ts'
import {
  CONFIG_FILENAME,
  createExclusive,
  ensureConfigFile,
  readConfigFile,
  updateConfigSettings,
} from './file.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-cfgfile-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (content: unknown) =>
  writeFileSync(
    join(dir, CONFIG_FILENAME),
    typeof content === 'string' ? content : JSON.stringify(content),
  )

describe('ensureConfigFile', () => {
  it('generates a strong session secret on first run and reuses it afterwards', () => {
    const first = ensureConfigFile(dir, { needSessionSecret: true })
    expect(first.created).toBe(true)
    expect(first.values.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/)

    const second = ensureConfigFile(dir, { needSessionSecret: true })
    expect(second.created).toBe(false)
    expect(second.values.SESSION_SECRET).toBe(first.values.SESSION_SECRET)
  })

  it('creates the data directory when it does not exist', () => {
    const nested = join(dir, 'a', 'b')
    ensureConfigFile(nested, { needSessionSecret: true })
    expect(existsSync(join(nested, CONFIG_FILENAME))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('is readable by the owner only', () => {
    ensureConfigFile(dir, { needSessionSecret: true })
    expect(statSync(join(dir, CONFIG_FILENAME)).mode & 0o777).toBe(0o600)
  })

  it('leaves no temporary file behind', () => {
    ensureConfigFile(dir, { needSessionSecret: true })
    expect(readdirSync(dir)).toEqual([CONFIG_FILENAME])
  })

  it('writes nothing when the environment supplies the session secret', () => {
    const result = ensureConfigFile(dir, { needSessionSecret: false })
    expect(result.values).toEqual({})
    expect(readdirSync(dir)).toEqual([])
  })

  it('keeps existing settings when it has to add the session secret', () => {
    write({ FX_RATE_POLICY: 'daily-spot' })
    const result = ensureConfigFile(dir, { needSessionSecret: true })
    expect(result.values.FX_RATE_POLICY).toBe('daily-spot')
    expect(readConfigFile(dir)?.SESSION_SECRET).toBe(result.values.SESSION_SECRET)
  })

  it('hands every later start the secret the first one generated', () => {
    const secrets = new Set<string>()
    for (let i = 0; i < 8; i++) {
      secrets.add(
        ensureConfigFile(dir, { needSessionSecret: true }).values.SESSION_SECRET as string,
      )
    }
    expect(secrets.size).toBe(1)
    expect(readdirSync(dir)).toEqual([CONFIG_FILENAME])
  })

  it('never overwrites a file that appears while it is creating one', () => {
    write({ SESSION_SECRET: 'winner'.repeat(11) })
    const values = createExclusive(dir, { SESSION_SECRET: 'loser'.repeat(13) })
    expect(values.SESSION_SECRET).toBe('winner'.repeat(11))
    expect(readConfigFile(dir)?.SESSION_SECRET).toBe('winner'.repeat(11))
    expect(readdirSync(dir)).toEqual([CONFIG_FILENAME])
  })

  it('reads a file saved with a byte-order mark', () => {
    write(`﻿${JSON.stringify({ FX_RATE_POLICY: 'daily-spot' })}`)
    expect(readConfigFile(dir)).toEqual({ FX_RATE_POLICY: 'daily-spot' })
  })

  it('replaces a blank session secret rather than trusting it', () => {
    write({ SESSION_SECRET: '   ' })
    const result = ensureConfigFile(dir, { needSessionSecret: true })
    expect(result.values.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/)
    expect(readConfigFile(dir)?.SESSION_SECRET).toBe(result.values.SESSION_SECRET)
  })

  it.each([
    ['ENCRYPTION_KEY', { ENCRYPTION_KEY: 'x'.repeat(64) }],
    ['TIINGO_API_KEY', { TIINGO_API_KEY: 'abc' }],
    ['ALPHA_VANTAGE_API_KEY', { ALPHA_VANTAGE_API_KEY: 'abc' }],
    ['DB_PATH', { DB_PATH: '/elsewhere' }],
  ])('refuses a file holding %s', (name, content) => {
    write(content)
    expect(() => ensureConfigFile(dir, { needSessionSecret: true })).toThrow(
      new RegExp(`"${name}".*does not belong`),
    )
  })

  it('refuses malformed content', () => {
    write('{ not json')
    expect(() => readConfigFile(dir)).toThrow(/not valid JSON/)
    write('[]')
    expect(() => readConfigFile(dir)).toThrow(/JSON object/)
    write({ PORT: 3000 })
    expect(() => readConfigFile(dir)).toThrow(/must be a string/)
  })
})

describe('loadConfig', () => {
  const base = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    DATA_DIR: dir,
    ...extra,
  })

  it('ignores config.json in env-supplied mode, and still requires SESSION_SECRET', () => {
    write({ SESSION_SECRET: 'f'.repeat(64) })
    expect(() => loadConfig(base())).toThrow(/SESSION_SECRET/)
    const config = loadConfig(base({ SESSION_SECRET: 'e'.repeat(64) }))
    expect(config.configMode).toBe('env-supplied')
    expect(config.sessionSecret).toBe('e'.repeat(64))
    expect(config.configFile).toBeUndefined()
  })

  it('generates and reuses the secret in self-configured mode', () => {
    const first = loadConfig(base({ AUTO_CONFIG: 'true' }))
    const second = loadConfig(base({ AUTO_CONFIG: 'true' }))
    expect(first.configMode).toBe('self-configured')
    expect(first.configFile).toBe(join(dir, CONFIG_FILENAME))
    expect(first.sessionSecret).toHaveLength(64)
    expect(second.sessionSecret).toBe(first.sessionSecret)
  })

  it('never puts key material or API keys in the file', () => {
    loadConfig(
      base({
        AUTO_CONFIG: 'true',
        ENCRYPTION_KEY: 'k'.repeat(64),
        TIINGO_API_KEY: 'tiingo-from-env',
      }),
    )
    const text = readFileSync(join(dir, CONFIG_FILENAME), 'utf8')
    expect(text).not.toContain('k'.repeat(64))
    expect(text).not.toContain('tiingo-from-env')
    expect(Object.keys(JSON.parse(text))).toEqual(['SESSION_SECRET'])
  })

  it('takes settings from the file, with the environment overriding them', () => {
    write({ SESSION_SECRET: 'f'.repeat(64), FX_RATE_POLICY: 'daily-spot', LOG_LEVEL: 'warn' })
    const fromFile = loadConfig(base({ AUTO_CONFIG: 'true' }))
    expect(fromFile.fxRatePolicy).toBe('daily-spot')
    expect(fromFile.logLevel).toBe('warn')
    expect(fromFile.sessionSecret).toBe('f'.repeat(64))

    const overridden = loadConfig(
      base({
        AUTO_CONFIG: 'true',
        FX_RATE_POLICY: 'hmrc-monthly',
        SESSION_SECRET: 'e'.repeat(64),
      }),
    )
    expect(overridden.fxRatePolicy).toBe('hmrc-monthly')
    expect(overridden.sessionSecret).toBe('e'.repeat(64))
  })

  it('does not generate a file when the environment supplies the secret', () => {
    loadConfig(base({ AUTO_CONFIG: 'true', SESSION_SECRET: 'e'.repeat(64) }))
    expect(existsSync(join(dir, CONFIG_FILENAME))).toBe(false)
  })

  it('lets SESSION_SECRET_FILE win over a secret in config.json', () => {
    write({ SESSION_SECRET: 'f'.repeat(64) })
    const secretFile = join(dir, 'secret.txt')
    writeFileSync(secretFile, `${'d'.repeat(64)}\n`)
    const config = loadConfig(base({ AUTO_CONFIG: 'true', SESSION_SECRET_FILE: secretFile }))
    expect(config.sessionSecret).toBe('d'.repeat(64))
  })

  it('rejects an AUTO_CONFIG value that is not true or false', () => {
    expect(() => loadConfig(base({ AUTO_CONFIG: 'yes' }))).toThrow(/AUTO_CONFIG/)
  })
})

describe('updateConfigSettings', () => {
  it('adds a setting and keeps the session secret', () => {
    write({ SESSION_SECRET: 's'.repeat(64) })
    updateConfigSettings(dir, { FX_RATE_POLICY: 'daily-spot' })
    expect(readConfigFile(dir)).toEqual({
      SESSION_SECRET: 's'.repeat(64),
      FX_RATE_POLICY: 'daily-spot',
    })
  })

  it('creates the file when there is none', () => {
    updateConfigSettings(dir, { PORT: '8080' })
    expect(readConfigFile(dir)).toEqual({ PORT: '8080' })
  })

  it('refuses names outside the allowlist, so key material cannot be routed into the file', () => {
    expect(() => updateConfigSettings(dir, { ENCRYPTION_KEY: 'k'.repeat(64) } as never)).toThrow(
      /not a setting that belongs/,
    )
    expect(existsSync(join(dir, CONFIG_FILENAME))).toBe(false)
  })

  it('does not quote file content when the JSON is invalid', () => {
    write('{ "SESSION_SECRET": abcdef0123')
    expect(() => readConfigFile(dir)).toThrow(/is not valid JSON$/)
  })
})

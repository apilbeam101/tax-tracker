import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_FILENAME, readConfigFile } from './config/file.ts'
import { runInit } from './init.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-init-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('runInit', () => {
  it('creates the config file once and reports where everything lives', () => {
    const first = runInit({ DATA_DIR: dir })
    expect(first).toMatchObject({
      dataDir: dir,
      dataDirSource: 'DATA_DIR',
      dbPath: join(dir, 'taxtracker.db'),
      configFile: join(dir, CONFIG_FILENAME),
      sessionSecret: 'generated',
    })
    const secret = readConfigFile(dir)?.SESSION_SECRET

    expect(runInit({ DATA_DIR: dir }).sessionSecret).toBe('already in config file')
    expect(readConfigFile(dir)?.SESSION_SECRET).toBe(secret)
  })

  it('does not echo the secret in its report', () => {
    const report = runInit({ DATA_DIR: dir })
    expect(JSON.stringify(report)).not.toContain(readConfigFile(dir)?.SESSION_SECRET as string)
  })

  it('leaves the config file alone when the environment supplies the secret', () => {
    const report = runInit({ DATA_DIR: dir, SESSION_SECRET: 'e'.repeat(64) })
    expect(report.sessionSecret).toBe('supplied by environment')
    expect(readConfigFile(dir)).toBeUndefined()
  })
})

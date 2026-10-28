import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packageRoot, resolveDataPaths } from './paths.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tt-paths-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('packageRoot', () => {
  it('finds the nearest package.json above the module, from any depth', () => {
    const deep = join(tmp, 'dist', 'server', 'config')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(tmp, 'package.json'), '{}')
    expect(packageRoot(pathToFileURL(join(deep, 'paths.js')).href)).toBe(tmp)
  })

  it('prefers the nearest package.json when several exist', () => {
    const pkg = join(tmp, 'node_modules', 'pkg')
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    writeFileSync(join(tmp, 'package.json'), '{}')
    writeFileSync(join(pkg, 'package.json'), '{}')
    expect(packageRoot(pathToFileURL(join(pkg, 'lib', 'x.js')).href)).toBe(pkg)
  })

  it('resolves this repository root by default, independent of cwd', () => {
    expect(packageRoot()).toBe(resolve(import.meta.dirname, '..', '..', '..'))
  })
})

describe('resolveDataPaths', () => {
  const ctx = (env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = 'linux') => ({
    env,
    cwd: tmp,
    platform,
    home: join(tmp, 'home'),
  })

  function seedLegacyDb(): void {
    mkdirSync(join(tmp, 'data'))
    writeFileSync(join(tmp, 'data', 'taxtracker.db'), '')
  }

  it('DB_PATH wins over DATA_DIR and an existing ./data', () => {
    seedLegacyDb()
    expect(resolveDataPaths(ctx({ DB_PATH: 'custom/x.db', DATA_DIR: 'other' }))).toEqual({
      dbPath: join(tmp, 'custom', 'x.db'),
      dataDir: join(tmp, 'custom'),
      source: 'DB_PATH',
    })
  })

  it('DATA_DIR wins over an existing ./data', () => {
    seedLegacyDb()
    const r = resolveDataPaths(ctx({ DATA_DIR: 'elsewhere' }))
    expect(r.source).toBe('DATA_DIR')
    expect(r.dbPath).toBe(join(tmp, 'elsewhere', 'taxtracker.db'))
  })

  it('keeps using ./data when it already contains taxtracker.db', () => {
    seedLegacyDb()
    expect(resolveDataPaths(ctx())).toEqual({
      dbPath: join(tmp, 'data', 'taxtracker.db'),
      dataDir: join(tmp, 'data'),
      source: 'legacy ./data',
    })
  })

  it('ignores an empty ./data directory', () => {
    mkdirSync(join(tmp, 'data'))
    expect(resolveDataPaths(ctx()).source).toBe('OS default')
  })

  it('uses XDG_DATA_HOME on Linux, else ~/.local/share', () => {
    expect(resolveDataPaths(ctx({ XDG_DATA_HOME: join(tmp, 'xdg') })).dataDir).toBe(
      join(tmp, 'xdg', 'tax-tracker'),
    )
    expect(resolveDataPaths(ctx()).dataDir).toBe(
      join(tmp, 'home', '.local', 'share', 'tax-tracker'),
    )
  })

  it('uses Application Support on macOS', () => {
    expect(resolveDataPaths(ctx({}, 'darwin')).dataDir).toBe(
      join(tmp, 'home', 'Library', 'Application Support', 'tax-tracker'),
    )
  })

  it('uses APPDATA on Windows, falling back to ~/AppData/Roaming', () => {
    expect(resolveDataPaths(ctx({ APPDATA: join(tmp, 'roaming') }, 'win32')).dataDir).toBe(
      join(tmp, 'roaming', 'tax-tracker'),
    )
    expect(resolveDataPaths(ctx({}, 'win32')).dataDir).toBe(
      join(tmp, 'home', 'AppData', 'Roaming', 'tax-tracker'),
    )
  })
})

import { randomBytes } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const CONFIG_FILENAME = 'config.json'

// The only names the file may carry. Key material (ENCRYPTION_KEY) and API keys are deliberately
// absent: they come from the environment or, for API keys, the encrypted app_secret table.
const SETTINGS = [
  'HOST',
  'PORT',
  'FX_RATE_POLICY',
  'LOG_LEVEL',
  'SECURE_COOKIES',
  'TRUST_PROXY',
] as const
const ALLOWED = new Set<string>(['SESSION_SECRET', ...SETTINGS])

export type ConfigFileValues = Record<string, string>

export function configFilePath(dataDir: string): string {
  return join(dataDir, CONFIG_FILENAME)
}

function parse(path: string, raw: string): ConfigFileValues {
  let json: unknown
  try {
    // Windows editors (Notepad, PowerShell 5) like to prepend a byte-order mark.
    json = JSON.parse(raw.replace(/^﻿/, ''))
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`)
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error(`${path} must hold a JSON object`)
  }
  const values: ConfigFileValues = {}
  for (const [name, value] of Object.entries(json)) {
    if (!ALLOWED.has(name)) {
      throw new Error(
        `${path} holds "${name}", which does not belong in the config file. Allowed: ${[...ALLOWED].join(', ')}. Key material and API keys are never stored here.`,
      )
    }
    if (typeof value !== 'string') throw new Error(`${path}: "${name}" must be a string`)
    values[name] = value
  }
  return values
}

export function readConfigFile(dataDir: string): ConfigFileValues | undefined {
  const path = configFilePath(dataDir)
  if (!existsSync(path)) return undefined
  return parse(path, readFileSync(path, 'utf8'))
}

function writeTemp(dataDir: string, values: ConfigFileValues): string {
  const tmp = join(
    dataDir,
    `.${CONFIG_FILENAME}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  )
  try {
    writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  return tmp
}

// Creates the file only if it does not exist yet: a hard link fails when the target is there, so
// two first starts racing on one data directory cannot overwrite each other's secret.
export function createExclusive(dataDir: string, values: ConfigFileValues): ConfigFileValues {
  const path = configFilePath(dataDir)
  const tmp = writeTemp(dataDir, values)
  try {
    try {
      linkSync(tmp, path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST')
        return parse(path, readFileSync(path, 'utf8'))
      // Some filesystems (network shares, certain bind mounts) have no hard links.
      if (existsSync(path)) return parse(path, readFileSync(path, 'utf8'))
      renameSync(tmp, path)
    }
    return values
  } finally {
    rmSync(tmp, { force: true })
  }
}

export interface EnsureOptions {
  /** False when the environment already supplies SESSION_SECRET: nothing is generated. */
  needSessionSecret: boolean
}

export interface EnsureResult {
  values: ConfigFileValues
  path: string
  created: boolean
}

// Self-configured mode: reads <dataDir>/config.json, generating the session secret on first run.
// Never writes anything else, and never reads or writes key material.
export function ensureConfigFile(dataDir: string, options: EnsureOptions): EnsureResult {
  const path = configFilePath(dataDir)
  const existing = readConfigFile(dataDir)
  if (existing?.SESSION_SECRET?.trim() || !options.needSessionSecret) {
    return { values: existing ?? {}, path, created: false }
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const generated = randomBytes(32).toString('hex')
  if (!existing) {
    const values = createExclusive(dataDir, { SESSION_SECRET: generated })
    return { values, path, created: values.SESSION_SECRET === generated }
  }

  const values = { ...existing, SESSION_SECRET: generated }
  const tmp = writeTemp(dataDir, values)
  try {
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
  return { values, path, created: false }
}

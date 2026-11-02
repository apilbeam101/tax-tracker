import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { isAbsolute, relative, resolve } from 'node:path'
import { buildConfig } from '../config/env.ts'
import { readConfigFile } from '../config/file.ts'
import { readSecret } from '../config/secrets.ts'
import {
  hasUnattendedSlot,
  isEncryptedDatabase,
  listSlots,
  unlockWithUnattendedKey,
} from '../crypto/keyslots.ts'
import { dataPaths, errorMessage, openExistingDb, settingsWithFile } from './util.ts'

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface Check {
  name: string
  status: CheckStatus
  detail: string
}

const MIN_NODE_MAJOR = 24

function check(name: string, status: CheckStatus, detail: string): Check {
  return { name, status, detail }
}

export function checkNode(version: string = process.versions.node): Check {
  const major = Number(version.split('.')[0])
  return major >= MIN_NODE_MAJOR
    ? check('node', 'ok', `Node ${version}`)
    : check('node', 'fail', `Node ${version} is too old; ${MIN_NODE_MAJOR} or newer is required`)
}

export function checkDataDir(dataDir: string, platform: NodeJS.Platform = process.platform): Check {
  if (!existsSync(dataDir)) {
    return check(
      'data directory',
      'ok',
      `${dataDir} does not exist yet; it is created on first start`,
    )
  }
  try {
    accessSync(dataDir, constants.R_OK | constants.W_OK)
  } catch {
    return check('data directory', 'fail', `${dataDir} is not readable and writable by this user`)
  }
  if (platform !== 'win32' && (statSync(dataDir).mode & 0o077) !== 0) {
    return check(
      'data directory',
      'warn',
      `${dataDir} is accessible to other users; restrict it with chmod 700`,
    )
  }
  return check('data directory', 'ok', dataDir)
}

export function checkConfigFile(dataDir: string): Check {
  try {
    const values = readConfigFile(dataDir)
    if (!values) return check('config file', 'ok', 'none (environment-supplied or not created yet)')
    return check('config file', 'ok', `${Object.keys(values).length} setting(s), no key material`)
  } catch (err) {
    return check('config file', 'fail', errorMessage(err))
  }
}

// A throwaway value stands in for the session secret that first start would generate, so a fresh
// self-configured install is not reported as misconfigured.
const PLACEHOLDER_SESSION_SECRET = '0'.repeat(64)

export function checkSecrets(env: NodeJS.ProcessEnv, dataDir: string): Check {
  try {
    const settings = settingsWithFile(env, dataDir)
    const selfConfigured = settings.AUTO_CONFIG === 'true'
    if (selfConfigured && !settings.SESSION_SECRET && !settings.SESSION_SECRET_FILE) {
      settings.SESSION_SECRET = PLACEHOLDER_SESSION_SECRET
    }
    buildConfig(settings)
    return check('settings', 'ok', 'secrets and settings are valid')
  } catch (err) {
    return check('settings', 'fail', errorMessage(err))
  }
}

export function checkUnattendedKeyLocation(env: NodeJS.ProcessEnv, dataDir: string): Check {
  const file = env.ENCRYPTION_KEY_FILE
  if (!file) return check('unattended key location', 'ok', 'no key file configured')
  const rel = relative(resolve(dataDir), resolve(file))
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  return inside
    ? check(
        'unattended key location',
        'fail',
        'ENCRYPTION_KEY_FILE is inside the data directory, so a backup or volume snapshot carries the key that opens it',
      )
    : check('unattended key location', 'ok', 'outside the data directory')
}

export function checkDatabase(dbPath: string): Check[] {
  if (!existsSync(dbPath)) {
    return [check('database', 'ok', 'not created yet; it is created on first start')]
  }
  let db: ReturnType<typeof openExistingDb>
  try {
    db = openExistingDb(dbPath, { readOnly: true })
  } catch (err) {
    return [check('database', 'fail', errorMessage(err))]
  }
  try {
    const result = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    const checks = [
      result.integrity_check === 'ok'
        ? check('database integrity', 'ok', 'integrity_check passed')
        : check('database integrity', 'fail', `integrity_check: ${result.integrity_check}`),
    ]
    checks.push(checkKeySlots(db))
    return checks
  } catch (err) {
    return [check('database', 'fail', errorMessage(err))]
  } finally {
    db.close()
  }
}

function checkKeySlots(db: ReturnType<typeof openExistingDb>): Check {
  if (!isEncryptedDatabase(db)) return check('key slots', 'ok', 'none (database not encrypted)')

  const slots = listSlots(db)
  const types = slots.map((s) => s.slotType)
  const missing = (['passphrase', 'recovery'] as const).filter((t) => !types.includes(t))
  if (missing.length > 0) {
    return check('key slots', 'fail', `missing slot(s): ${missing.join(', ')}`)
  }
  if (new Set(slots.map((s) => s.keyId)).size > 1) {
    return check('key slots', 'fail', 'slots disagree on the key id; the database may be damaged')
  }
  return check(
    'key slots',
    'ok',
    `${types.join(', ')}${hasUnattendedSlot(db) ? ' (unattended unlock available)' : ''}`,
  )
}

export function checkPort(host: string, port: number): Promise<Check> {
  return new Promise((resolvePromise) => {
    const server = createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      resolvePromise(
        err.code === 'EADDRINUSE'
          ? check('port', 'warn', `${host}:${port} is in use (the app may already be running)`)
          : check('port', 'fail', `${host}:${port}: ${err.message}`),
      )
    })
    server.listen({ host, port }, () => {
      server.close(() => resolvePromise(check('port', 'ok', `${host}:${port} is free`)))
    })
  })
}

export async function checkUnattendedKey(
  env: NodeJS.ProcessEnv,
  dbPath: string,
): Promise<Check | undefined> {
  const errors: string[] = []
  const key = readSecret('ENCRYPTION_KEY', env, errors)
  if (!key || errors.length > 0 || !existsSync(dbPath)) return undefined
  const db = openExistingDb(dbPath, { readOnly: true })
  try {
    if (!isEncryptedDatabase(db)) return undefined
    if (!hasUnattendedSlot(db)) {
      return check(
        'unattended key',
        'warn',
        'ENCRYPTION_KEY is set but no unattended slot exists, so it is ignored and the app starts locked',
      )
    }
    const dek = await unlockWithUnattendedKey(db, key)
    if (!dek) {
      return check(
        'unattended key',
        'fail',
        'ENCRYPTION_KEY does not open the unattended slot; the app will refuse to start',
      )
    }
    dek.fill(0)
    return check('unattended key', 'ok', 'opens the unattended slot')
  } finally {
    db.close()
  }
}

export async function runDoctor(env: NodeJS.ProcessEnv = process.env): Promise<Check[]> {
  const { dataDir, dbPath } = dataPaths(env)
  const checks = [checkNode(), checkDataDir(dataDir), checkConfigFile(dataDir)]

  // An unreadable config file is reported above; the remaining checks carry on without it.
  let settings: NodeJS.ProcessEnv = env
  try {
    settings = settingsWithFile(env, dataDir)
  } catch {
    /* already reported by checkConfigFile */
  }
  checks.push(checkSecrets(env, dataDir), checkUnattendedKeyLocation(env, dataDir))
  checks.push(...checkDatabase(dbPath))
  try {
    const unattended = await checkUnattendedKey(env, dbPath)
    if (unattended) checks.push(unattended)
  } catch (err) {
    checks.push(check('unattended key', 'fail', errorMessage(err)))
  }
  const port = Number(settings.PORT ?? 3000)
  if (Number.isInteger(port) && port > 0) {
    checks.push(await checkPort(settings.HOST ?? '127.0.0.1', port))
  }
  return checks
}

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `[${c.status.padEnd(4)}] ${c.name}: ${c.detail}`).join('\n')
}

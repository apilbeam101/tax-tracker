import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import fastifyCsrfProtection from '@fastify/csrf-protection'
import fastifyRateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import { type Mock, vi } from 'vitest'
import { hashPassword } from './auth/password.ts'
import type { Keyring } from './crypto/keyring.ts'
import { createKeySlots, setUnattendedKey } from './crypto/keyslots.ts'
import type { SessionTracker } from './crypto/session-tracker.ts'
import { createTestDb } from './db/testdb.ts'
import { errorHandler } from './errors.ts'
import { registerLockState } from './lock.ts'
import { registerRepositories } from './repositories/register.ts'
import { apiRoutes } from './routes/api.ts'
import { authRoutes } from './routes/auth.ts'
import type { ApiKeyName } from './services/api-keys.ts'
import { registerSession } from './session.ts'

// Test support: the real lock-state, store and route wiring on an in-memory database, with a
// cookie-and-CSRF-aware client. Only the FX and price services and the static files are stubbed.

export const FAST = {
  passphraseKdf: { kdf: 'argon2id', memoryKiB: 64, timeCost: 1, parallelism: 1 },
} as const
export const PASSPHRASE = 'a reasonably long passphrase'
export const NEW_PASSPHRASE = 'a different long passphrase'
export const UNATTENDED_KEY = 'a-deployment-supplied-key-of-32-chars-or-more'
export const HOUR = 60 * 60 * 1000
export const tick = () => new Promise((resolve) => setImmediate(resolve))

let passphraseHash: string | undefined

async function hashOfPassphrase(): Promise<string> {
  passphraseHash ??= await hashPassword(PASSPHRASE)
  return passphraseHash
}

export interface Harness {
  app: FastifyInstance
  db: DatabaseSync
  keyring: Keyring
  tracker: SessionTracker
  clock: { now: number }
  startupTasks: Mock<() => void>
  /** Temporary data directory (safety copies and backups are written under it). */
  dataDir: string
  dispose: () => Promise<void>
}

export interface BuildOptions {
  slots: boolean
  unattendedKey?: string
  bootKey?: string
  startupTasks?: Mock<() => void>
  apiKeysFromEnv?: Partial<Record<ApiKeyName, string>>
  configMode?: 'env-supplied' | 'self-configured'
}

export async function build(
  options: BuildOptions,
): Promise<{ h: Harness; dek?: Buffer | undefined; recoveryKey?: string | undefined }> {
  const db = createTestDb()
  db.prepare('INSERT INTO user (tenant_id, username, password_hash) VALUES (1, ?, ?)').run(
    'admin',
    await hashOfPassphrase(),
  )
  let dek: Buffer | undefined
  let recoveryKey: string | undefined
  if (options.slots) {
    const created = await createKeySlots(db, PASSPHRASE, FAST)
    dek = created.dek
    recoveryKey = created.recoveryKey
    if (options.unattendedKey) await setUnattendedKey(db, dek, options.unattendedKey)
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'tt-harness-'))
  const app = Fastify()
  app.setErrorHandler(errorHandler)
  await app.register(fastifyRateLimit, { global: true, max: 200, timeWindow: '1 minute' })
  await registerSession(app, { secret: 's'.repeat(64), secureCookies: false })
  await app.register(fastifyCsrfProtection, { sessionPlugin: '@fastify/session' })

  app.decorate('db', db)
  app.decorate('runtime', {
    dataDir,
    unattendedKey: options.unattendedKey,
    passphraseKdf: FAST.passphraseKdf,
    configMode: options.configMode ?? 'self-configured',
    apiKeysFromEnv: options.apiKeysFromEnv,
  })
  app.decorate('fx', {} as never)
  app.decorate('priceService', {} as never)

  const clock = { now: 1_000_000 }
  const startupTasks = options.startupTasks ?? vi.fn()
  const lockState = registerLockState(app, {
    db,
    encryptionKey: options.bootKey ?? options.unattendedKey,
    startupTasks,
    now: () => clock.now,
  })
  // Same order as buildApp(): keyring, then the stores built on it, then boot.
  registerRepositories(app, db)
  await lockState.boot()

  app.get('/health', async () => ({ status: 'ok' }))
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(apiRoutes, { prefix: '/api' })
  await app.ready()

  return {
    h: {
      app,
      db,
      keyring: app.keyring,
      tracker: app.sessionTracker,
      clock,
      startupTasks,
      dataDir,
      dispose: async () => {
        await app.close()
        rmSync(dataDir, { recursive: true, force: true })
      },
    },
    dek,
    recoveryKey,
  }
}

// A tiny cookie-and-CSRF-aware client, one per browser session.
export class Client {
  #cookie = ''
  #csrf = ''
  constructor(private readonly app: FastifyInstance) {}

  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
    const headers: Record<string, string> = {}
    if (this.#cookie) headers.cookie = this.#cookie
    if (method !== 'GET') {
      // The token is bound to the session, and signing in replaces the session.
      await this.#fetchCsrf()
      headers['csrf-token'] = this.#csrf
    }
    const res = await this.app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    })
    this.#absorbCookies(res.headers['set-cookie'])
    return res
  }

  /** POSTs a raw file body, as the restore upload does. */
  async upload(url: string, body: Buffer, withCsrf = true) {
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' }
    if (this.#cookie) headers.cookie = this.#cookie
    if (withCsrf) {
      await this.#fetchCsrf()
      headers['csrf-token'] = this.#csrf
    }
    const res = await this.app.inject({ method: 'POST', url, headers, payload: body })
    this.#absorbCookies(res.headers['set-cookie'])
    return res
  }

  /** Like request(), but never sends the CSRF token. */
  async requestWithoutCsrf(method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
    return this.app.inject({
      method,
      url,
      headers: this.#cookie ? { cookie: this.#cookie } : {},
      ...(payload === undefined ? {} : { payload: payload as object }),
    })
  }

  async #fetchCsrf() {
    const res = await this.app.inject({
      method: 'GET',
      url: '/api/auth/csrf',
      headers: this.#cookie ? { cookie: this.#cookie } : {},
    })
    this.#absorbCookies(res.headers['set-cookie'])
    this.#csrf = (res.json() as { csrfToken: string }).csrfToken
  }

  #absorbCookies(header: string | string[] | undefined) {
    if (!header) return
    const pairs = (Array.isArray(header) ? header : [header]).map((c) => c.split(';')[0] as string)
    const jar = new Map(
      this.#cookie
        .split('; ')
        .filter(Boolean)
        .map((p) => p.split('=') as [string, string]),
    )
    for (const pair of pairs) {
      const [name, ...value] = pair.split('=')
      jar.set(name as string, value.join('='))
    }
    this.#cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  login(password = PASSPHRASE) {
    return this.request('POST', '/api/auth/login', { username: 'admin', password })
  }
  logout() {
    return this.request('POST', '/api/auth/logout')
  }
  me() {
    return this.request('GET', '/api/me')
  }
  status() {
    return this.request('GET', '/api/auth/status')
  }
}

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import fastifyCsrfProtection from '@fastify/csrf-protection'
import fastifyRateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from 'vitest'
import { hashPassword, verifyPassword } from './auth/password.ts'
import { Keyring } from './crypto/keyring.ts'
import {
  createKeySlots,
  hasKeySlots,
  setUnattendedKey,
  unlockWithPassphrase,
} from './crypto/keyslots.ts'
import { formatRecoveryKey } from './crypto/recovery.ts'
import type { SessionTracker } from './crypto/session-tracker.ts'
import { errorHandler, LockedError } from './errors.ts'
import { registerLockState, unlockAtBoot } from './lock.ts'
import { registerRepositories } from './repositories/register.ts'
import { apiRoutes } from './routes/api.ts'
import { authRoutes } from './routes/auth.ts'
import { registerSession } from './session.ts'

const MIGRATIONS_DIR = join(import.meta.dirname, 'db', 'migrations')
const FAST = {
  passphraseKdf: { kdf: 'argon2id', memoryKiB: 64, timeCost: 1, parallelism: 1 },
} as const
const PASSPHRASE = 'a reasonably long passphrase'
const NEW_PASSPHRASE = 'a different long passphrase'
const HOUR = 60 * 60 * 1000
const tick = () => new Promise((resolve) => setImmediate(resolve))

let passphraseHash: string

beforeAll(async () => {
  passphraseHash = await hashPassword(PASSPHRASE)
})

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'))
  }
  db.prepare('INSERT INTO user (tenant_id, username, password_hash) VALUES (1, ?, ?)').run(
    'admin',
    passphraseHash,
  )
  return db
}

interface Harness {
  app: FastifyInstance
  db: DatabaseSync
  keyring: Keyring
  tracker: SessionTracker
  clock: { now: number }
  startupTasks: Mock<() => void>
}

const UNATTENDED_KEY = 'a-deployment-supplied-key-of-32-chars-or-more'

// Uses the same registerLockState() as buildApp(), so the wiring under test is the wiring that
// runs; only the stores and static files are stubbed out.
async function build(options: {
  slots: boolean
  unattendedKey?: string
  bootKey?: string
  startupTasks?: Mock<() => void>
}): Promise<{ h: Harness; dek?: Buffer | undefined; recoveryKey?: string | undefined }> {
  const db = setupDb()
  let dek: Buffer | undefined
  let recoveryKey: string | undefined
  if (options.slots) {
    const created = await createKeySlots(db, PASSPHRASE, FAST)
    dek = created.dek
    recoveryKey = created.recoveryKey
    if (options.unattendedKey) await setUnattendedKey(db, dek, options.unattendedKey)
  }

  const app = Fastify()
  app.setErrorHandler(errorHandler)
  await app.register(fastifyRateLimit, { global: true, max: 200, timeWindow: '1 minute' })
  await registerSession(app, { secret: 's'.repeat(64), secureCookies: false })
  await app.register(fastifyCsrfProtection, { sessionPlugin: '@fastify/session' })

  app.decorate('db', db)
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
    h: { app, db, keyring: app.keyring, tracker: app.sessionTracker, clock, startupTasks },
    dek,
    recoveryKey,
  }
}

// A tiny cookie-and-CSRF-aware client, one per browser session.
class Client {
  #cookie = ''
  #csrf = ''
  constructor(private readonly app: FastifyInstance) {}

  async request(method: 'GET' | 'POST', url: string, payload?: unknown) {
    const headers: Record<string, string> = {}
    if (this.#cookie) headers.cookie = this.#cookie
    if (method === 'POST') {
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

let current: Harness | undefined

afterEach(async () => {
  await current?.app.close()
  current = undefined
})

describe('database with no key slots (not yet encrypted)', () => {
  it('behaves as before: no lock, login works, and the startup work runs at boot', async () => {
    const { h } = await build({ slots: false })
    current = h
    const client = new Client(h.app)

    expect(h.startupTasks).toHaveBeenCalledTimes(1)
    expect((await client.status()).json()).toMatchObject({ locked: false, unlockMode: 'none' })
    expect((await client.me()).statusCode).toBe(401)
    expect((await client.login()).statusCode).toBe(200)
    expect((await client.me()).statusCode).toBe(200)
    expect(h.tracker.size).toBe(1)
    await client.logout()
    expect(h.tracker.size).toBe(0)
    expect(h.keyring.state).toBe('unprotected')
    expect(h.startupTasks).toHaveBeenCalledTimes(1)
  })

  it('fails closed: any key_slot row keeps the database protected', async () => {
    const { h } = await build({ slots: true })
    current = h
    h.db.exec("DELETE FROM key_slot WHERE slot_type = 'passphrase'")

    expect(hasKeySlots(h.db)).toBe(true)
    const res = await new Client(h.app).login()
    expect(res.statusCode).toBe(423)
    expect(res.json()).toMatchObject({ code: 'UNLOCK_FAILED' })
  })
})

describe('locked state', () => {
  it('answers 423 with a stable code on API routes, with or without a session cookie', async () => {
    const { h } = await build({ slots: true })
    current = h
    const res = await new Client(h.app).me()
    expect(res.statusCode).toBe(423)
    expect(res.json()).toMatchObject({ code: 'LOCKED' })
    expect(res.json().message).toBe(res.json().error)
  })

  it('still serves /health and /api/auth/*', async () => {
    const { h } = await build({ slots: true })
    current = h
    const client = new Client(h.app)
    expect((await client.request('GET', '/health')).statusCode).toBe(200)
    expect((await client.request('GET', '/api/auth/csrf')).statusCode).toBe(200)
    expect((await client.status()).json()).toMatchObject({
      locked: true,
      authenticated: false,
      unlockMode: 'passphrase',
    })
  })

  it('does not parse or validate a request body for a locked API route', async () => {
    const { h } = await build({ slots: true })
    current = h
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/instruments',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })
    expect(res.statusCode).toBe(423)
  })
})

describe('unlocking by signing in', () => {
  it('unlocks with the passphrase and runs the unlock hook once', async () => {
    const { h } = await build({ slots: true })
    current = h
    const client = new Client(h.app)

    expect((await client.login()).statusCode).toBe(200)
    await tick()
    expect(h.keyring.state).toBe('unlocked')
    expect(h.startupTasks).toHaveBeenCalledTimes(1)
    expect((await client.me()).statusCode).toBe(200)
    expect((await client.status()).json()).toMatchObject({ locked: false, authenticated: true })
  })

  it('stays locked and issues no session on a wrong passphrase', async () => {
    const { h } = await build({ slots: true })
    current = h
    const client = new Client(h.app)

    const res = await client.login('not the passphrase')
    expect(res.statusCode).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(h.keyring.state).toBe('locked')
    expect(h.tracker.size).toBe(0)
  })

  it('reports UNLOCK_FAILED when the login hash is right but the slot will not open', async () => {
    const { h } = await build({ slots: true })
    current = h
    h.db.exec(
      "UPDATE key_slot SET salt = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE slot_type = 'passphrase'",
    )
    const res = await new Client(h.app).login()
    expect(res.statusCode).toBe(423)
    expect(res.json()).toMatchObject({ code: 'UNLOCK_FAILED' })
    expect(h.keyring.state).toBe('locked')
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('a second sign-in while unlocked just proves the password', async () => {
    const { h } = await build({ slots: true })
    current = h
    await new Client(h.app).login()
    const second = new Client(h.app)
    expect((await second.login()).statusCode).toBe(200)
    expect((await second.login('not the passphrase')).statusCode).toBe(401)
    expect(h.tracker.size).toBe(2)
  })
})

describe('re-locking', () => {
  it('logging out of the last session wipes the key and locks', async () => {
    const { h } = await build({ slots: true })
    current = h
    const client = new Client(h.app)
    await client.login()

    let held: Buffer | undefined
    h.keyring.withDek((dek) => {
      held = dek
    })
    expect((await client.logout()).statusCode).toBe(200)

    expect(h.keyring.state).toBe('locked')
    expect(held?.equals(Buffer.alloc(32, 0))).toBe(true)
    expect((await client.me()).statusCode).toBe(423)
  })

  it('stays unlocked until the last of several sessions ends', async () => {
    const { h } = await build({ slots: true })
    current = h
    const a = new Client(h.app)
    const b = new Client(h.app)
    await a.login()
    await b.login()

    await a.logout()
    expect(h.keyring.state).toBe('unlocked')
    expect((await b.me()).statusCode).toBe(200)

    await b.logout()
    expect(h.keyring.state).toBe('locked')
  })

  it('locks when the only session goes idle past the timeout', async () => {
    const { h } = await build({ slots: true })
    current = h
    const client = new Client(h.app)
    await client.login()

    h.clock.now += 8 * HOUR + 1
    h.tracker.sweep()

    expect(h.keyring.state).toBe('locked')
    expect((await client.me()).statusCode).toBe(423)
  })

  it('ends an idle session at the next request while another session keeps the data unlocked', async () => {
    const { h } = await build({ slots: true })
    current = h
    const idle = new Client(h.app)
    const active = new Client(h.app)
    await idle.login()
    h.clock.now += 5 * HOUR
    await active.login()
    h.clock.now += 4 * HOUR

    expect((await idle.me()).statusCode).toBe(401)
    expect(h.keyring.state).toBe('unlocked')
    expect((await active.me()).statusCode).toBe(200)
  })

  it('unlocks again on the next sign-in but runs the startup work only once per process', async () => {
    const { h } = await build({ slots: true })
    current = h
    const client = new Client(h.app)
    await client.login()
    await client.logout()
    expect(h.keyring.state).toBe('locked')
    await client.login()
    await tick()
    expect(h.keyring.state).toBe('unlocked')
    expect(h.startupTasks).toHaveBeenCalledTimes(1)
  })

  it('does not lock the key out from under a session that is just starting', async () => {
    const { h } = await build({ slots: true })
    current = h
    const first = new Client(h.app)
    await first.login()
    const second = new Client(h.app)
    // Both clients sign in while the other is mid-flight; whichever finishes, the key is held.
    const [a, b] = await Promise.all([first.login(), second.login()])
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)
    expect(h.keyring.state).toBe('unlocked')
    expect((await second.me()).statusCode).toBe(200)
  })

  it('signing in twice with one browser leaves no phantom session holding the key', async () => {
    const { h } = await build({ slots: true })
    current = h
    const client = new Client(h.app)
    await client.login()
    await client.login()
    expect(h.tracker.size).toBe(1)

    await client.logout()
    expect(h.tracker.size).toBe(0)
    expect(h.keyring.state).toBe('locked')
  })

  it('the sweeper locks a key that is held with no session to justify it', async () => {
    const { h, dek } = await build({ slots: true })
    current = h
    h.keyring.unlock(Buffer.from(dek as Buffer))
    expect(h.keyring.state).toBe('unlocked')
    h.tracker.sweep()
    expect(h.keyring.state).toBe('locked')
  })

  it('reports a revoked or idle session as signed out in /status', async () => {
    const { h } = await build({ slots: true })
    current = h
    const client = new Client(h.app)
    await client.login()
    h.clock.now += 8 * HOUR + 1
    expect((await client.status()).json()).toMatchObject({ authenticated: false, user: null })
  })
})

describe('unattended mode', () => {
  it('unlocks at boot, runs the startup work without anyone signing in, and ignores logout', async () => {
    const { h } = await build({ slots: true, unattendedKey: UNATTENDED_KEY })
    current = h
    await tick()
    const client = new Client(h.app)

    expect(h.keyring.state).toBe('unlocked')
    expect(h.startupTasks).toHaveBeenCalledTimes(1)
    expect((await client.status()).json()).toMatchObject({
      locked: false,
      unlockMode: 'unattended',
    })
    expect((await client.me()).statusCode).toBe(401)
    expect((await client.login()).statusCode).toBe(200)
    expect((await client.me()).statusCode).toBe(200)
    await client.logout()
    expect(h.keyring.state).toBe('unlocked')
    expect(h.startupTasks).toHaveBeenCalledTimes(1)
  })

  it('still expires sessions, so idle ones stop working', async () => {
    const { h } = await build({ slots: true, unattendedKey: UNATTENDED_KEY })
    current = h
    const client = new Client(h.app)
    await client.login()
    h.clock.now += 8 * HOUR + 1
    expect((await client.me()).statusCode).toBe(401)
    expect(h.keyring.state).toBe('unlocked')
  })

  it('refuses to boot when the configured key does not open the unattended slot', async () => {
    await expect(
      build({
        slots: true,
        unattendedKey: UNATTENDED_KEY,
        bootKey: 'the-wrong-key-the-wrong-key-the-wrong',
      }),
    ).rejects.toThrow(/does not open the unattended key slot/)
  })
})

describe('startup work', () => {
  it('is retried on the next unlock if it fails, and not repeated once it succeeds', async () => {
    const startupTasks = vi.fn<() => void>().mockImplementationOnce(() => {
      throw new Error('recalc failed')
    })
    const { h } = await build({ slots: true, startupTasks })
    current = h
    const client = new Client(h.app)

    await client.login()
    await tick()
    expect(startupTasks).toHaveBeenCalledTimes(1)

    await client.logout()
    await client.login()
    await tick()
    expect(startupTasks).toHaveBeenCalledTimes(2)

    await client.logout()
    await client.login()
    await tick()
    expect(startupTasks).toHaveBeenCalledTimes(2)
  })
})

describe('error codes', () => {
  it('a LockedError raised anywhere carries the stable LOCKED code', async () => {
    const app = Fastify()
    app.setErrorHandler(errorHandler)
    app.get('/boom', async () => {
      throw new LockedError()
    })
    const res = await app.inject({ method: 'GET', url: '/boom' })
    await app.close()
    expect(res.statusCode).toBe(423)
    expect(res.json()).toMatchObject({ code: 'LOCKED', error: expect.any(String) })
  })
})

describe('revoking other sessions on credential change', () => {
  it('a recovery reset signs out every other session', async () => {
    const { h, recoveryKey } = await build({ slots: true })
    current = h
    const attacker = new Client(h.app)
    await attacker.login()

    const owner = new Client(h.app)
    const res = await owner.request('POST', '/api/auth/recover', {
      recoveryKey,
      newPassphrase: NEW_PASSPHRASE,
    })
    expect(res.statusCode).toBe(200)

    expect((await attacker.me()).statusCode).toBe(401)
    expect((await owner.me()).statusCode).toBe(200)
    expect(h.keyring.state).toBe('unlocked')
  })

  it('a passphrase change signs out every other session but not the one that changed it', async () => {
    const { h } = await build({ slots: true })
    current = h
    const other = new Client(h.app)
    const owner = new Client(h.app)
    await other.login()
    await owner.login()

    const res = await owner.request('POST', '/api/auth/change-passphrase', {
      currentPassword: PASSPHRASE,
      newPassphrase: NEW_PASSPHRASE,
    })
    expect(res.statusCode).toBe(200)

    expect((await other.me()).statusCode).toBe(401)
    expect((await owner.me()).statusCode).toBe(200)
  })

  it('does the same on a database with no key slots', async () => {
    const { h } = await build({ slots: false })
    current = h
    const other = new Client(h.app)
    const owner = new Client(h.app)
    await other.login()
    await owner.login()
    await owner.request('POST', '/api/auth/change-passphrase', {
      currentPassword: PASSPHRASE,
      newPassphrase: NEW_PASSPHRASE,
    })
    expect((await other.me()).statusCode).toBe(401)
    expect((await owner.me()).statusCode).toBe(200)
  })
})

describe('rate limiting on the recovery routes', () => {
  it('stops guessing recovery keys after five attempts', async () => {
    const { h } = await build({ slots: true })
    current = h
    const client = new Client(h.app)
    const wrong = formatRecoveryKey(Buffer.alloc(32, 5))
    const codes: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await client.request('POST', '/api/auth/recover', {
        recoveryKey: wrong,
        newPassphrase: NEW_PASSPHRASE,
      })
      codes.push(res.statusCode)
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429])
  })
})

describe('forgotten passphrase', () => {
  it('unlocks with the recovery key, sets a new passphrase everywhere and signs in', async () => {
    const { h, dek, recoveryKey } = await build({ slots: true })
    current = h
    const client = new Client(h.app)

    const res = await client.request('POST', '/api/auth/recover', {
      recoveryKey,
      newPassphrase: NEW_PASSPHRASE,
    })
    expect(res.statusCode).toBe(200)
    expect(h.keyring.state).toBe('unlocked')
    expect((await client.me()).statusCode).toBe(200)

    const row = h.db.prepare('SELECT password_hash FROM user').get() as { password_hash: string }
    expect(await verifyPassword(row.password_hash, NEW_PASSPHRASE)).toBe(true)
    expect(await verifyPassword(row.password_hash, PASSPHRASE)).toBe(false)
    expect((await unlockWithPassphrase(h.db, NEW_PASSPHRASE))?.equals(dek as Buffer)).toBe(true)
    expect(await unlockWithPassphrase(h.db, PASSPHRASE)).toBeNull()
  })

  it('rejects a well-formed wrong recovery key without changing anything', async () => {
    const { h } = await build({ slots: true })
    current = h
    const wrong = formatRecoveryKey(Buffer.alloc(32, 5))
    const res = await new Client(h.app).request('POST', '/api/auth/recover', {
      recoveryKey: wrong,
      newPassphrase: NEW_PASSPHRASE,
    })
    expect(res.statusCode).toBe(401)
    expect(h.keyring.state).toBe('locked')
    expect(await unlockWithPassphrase(h.db, PASSPHRASE)).not.toBeNull()
  })

  it('reports a mistyped recovery key as a client error', async () => {
    const { h, recoveryKey } = await build({ slots: true })
    current = h
    const mistyped = (recoveryKey?.[0] === '0' ? '1' : '0') + (recoveryKey as string).slice(1)
    const res = await new Client(h.app).request('POST', '/api/auth/recover', {
      recoveryKey: mistyped,
      newPassphrase: NEW_PASSPHRASE,
    })
    expect(res.statusCode).toBe(400)
    expect(h.keyring.state).toBe('locked')
  })

  it('refuses when there are no key slots', async () => {
    const { h } = await build({ slots: false })
    current = h
    const res = await new Client(h.app).request('POST', '/api/auth/recover', {
      recoveryKey: 'x',
      newPassphrase: NEW_PASSPHRASE,
    })
    expect(res.statusCode).toBe(409)
  })

  it('rolls the slot back if the login hash cannot be updated', async () => {
    const { h, recoveryKey } = await build({ slots: true })
    current = h
    h.db.exec(
      "CREATE TRIGGER no_hash_update BEFORE UPDATE ON user BEGIN SELECT RAISE(ABORT, 'boom'); END",
    )
    const res = await new Client(h.app).request('POST', '/api/auth/recover', {
      recoveryKey,
      newPassphrase: NEW_PASSPHRASE,
    })
    expect(res.statusCode).toBe(500)
    expect(h.db.isTransaction).toBe(false)
    expect(await unlockWithPassphrase(h.db, PASSPHRASE)).not.toBeNull()
    expect(await unlockWithPassphrase(h.db, NEW_PASSPHRASE)).toBeNull()
  })
})

describe('changing the passphrase while signed in', () => {
  it('updates the login hash and the passphrase slot together', async () => {
    const { h, dek } = await build({ slots: true })
    current = h
    const client = new Client(h.app)
    await client.login()

    const res = await client.request('POST', '/api/auth/change-passphrase', {
      currentPassword: PASSPHRASE,
      newPassphrase: NEW_PASSPHRASE,
    })
    expect(res.statusCode).toBe(200)

    const row = h.db.prepare('SELECT password_hash FROM user').get() as { password_hash: string }
    expect(await verifyPassword(row.password_hash, NEW_PASSPHRASE)).toBe(true)
    expect((await unlockWithPassphrase(h.db, NEW_PASSPHRASE))?.equals(dek as Buffer)).toBe(true)
    expect(await unlockWithPassphrase(h.db, PASSPHRASE)).toBeNull()
  })

  it('rejects a wrong current passphrase and changes nothing', async () => {
    const { h } = await build({ slots: true })
    current = h
    const client = new Client(h.app)
    await client.login()
    const res = await client.request('POST', '/api/auth/change-passphrase', {
      currentPassword: 'definitely not it',
      newPassphrase: NEW_PASSPHRASE,
    })
    expect(res.statusCode).toBe(401)
    expect(await unlockWithPassphrase(h.db, PASSPHRASE)).not.toBeNull()
  })

  it('leaves both the hash and the slot unchanged if the slot write fails', async () => {
    const { h } = await build({ slots: true })
    current = h
    const client = new Client(h.app)
    await client.login()
    h.db.exec(
      "CREATE TRIGGER no_slot_update BEFORE UPDATE ON key_slot BEGIN SELECT RAISE(ABORT, 'boom'); END",
    )

    const res = await client.request('POST', '/api/auth/change-passphrase', {
      currentPassword: PASSPHRASE,
      newPassphrase: NEW_PASSPHRASE,
    })
    expect(res.statusCode).toBe(500)
    expect(h.db.isTransaction).toBe(false)

    const row = h.db.prepare('SELECT password_hash FROM user').get() as { password_hash: string }
    expect(await verifyPassword(row.password_hash, PASSPHRASE)).toBe(true)
    expect(await verifyPassword(row.password_hash, NEW_PASSPHRASE)).toBe(false)
    expect(await unlockWithPassphrase(h.db, PASSPHRASE)).not.toBeNull()
  })

  it('requires a signed-in session', async () => {
    const { h } = await build({ slots: false })
    current = h
    const res = await new Client(h.app).request('POST', '/api/auth/change-passphrase', {
      currentPassword: PASSPHRASE,
      newPassphrase: NEW_PASSPHRASE,
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('unlockAtBoot', () => {
  async function bootDb() {
    const db = setupDb()
    const { dek } = await createKeySlots(db, PASSPHRASE, FAST)
    return { db, dek }
  }

  it('leaves a database without key slots unprotected', async () => {
    const keyring = new Keyring({ protected: false })
    const mode = await unlockAtBoot({
      db: setupDb(),
      keyring,
      encryptionKey: undefined,
      warn: vi.fn(),
    })
    expect(mode).toBe('unprotected')
  })

  it('starts locked when no unattended key is configured', async () => {
    const { db } = await bootDb()
    const keyring = new Keyring({ protected: true })
    const mode = await unlockAtBoot({ db, keyring, encryptionKey: undefined, warn: vi.fn() })
    expect(mode).toBe('passphrase')
    expect(keyring.state).toBe('locked')
  })

  it('unlocks permanently when the unattended key opens its slot', async () => {
    const { db, dek } = await bootDb()
    const key = 'a-deployment-supplied-key-of-32-chars-or-more'
    await setUnattendedKey(db, dek, key)
    const keyring = new Keyring({ protected: true })

    const mode = await unlockAtBoot({ db, keyring, encryptionKey: key, warn: vi.fn() })

    expect(mode).toBe('unattended')
    expect(keyring.state).toBe('unlocked')
    expect(keyring.isPermanent).toBe(true)
    expect(keyring.withDek((held) => held.equals(dek))).toBe(true)
  })

  it('refuses to start when the unattended key is wrong, rather than silently staying locked', async () => {
    const { db, dek } = await bootDb()
    await setUnattendedKey(db, dek, 'a-deployment-supplied-key-of-32-chars-or-more')
    const keyring = new Keyring({ protected: true })
    await expect(
      unlockAtBoot({
        db,
        keyring,
        encryptionKey: 'the-wrong-key-the-wrong-key-the-wrong',
        warn: vi.fn(),
      }),
    ).rejects.toThrow(/does not open the unattended key slot/)
    expect(keyring.state).toBe('locked')
  })

  it('warns and starts locked when a key is configured but no unattended slot exists', async () => {
    const { db } = await bootDb()
    const warn = vi.fn()
    const keyring = new Keyring({ protected: true })
    const mode = await unlockAtBoot({
      db,
      keyring,
      encryptionKey: 'a-deployment-supplied-key-of-32-chars-or-more',
      warn,
    })
    expect(mode).toBe('passphrase')
    expect(keyring.state).toBe('locked')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no unattended key slot'))
  })
})

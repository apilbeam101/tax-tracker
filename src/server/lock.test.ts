import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyPassword } from './auth/password.ts'
import { Keyring } from './crypto/keyring.ts'
import {
  createKeySlots,
  hasKeySlots,
  setUnattendedKey,
  unlockWithPassphrase,
} from './crypto/keyslots.ts'
import { formatRecoveryKey } from './crypto/recovery.ts'
import { createTestDb } from './db/testdb.ts'
import { errorHandler, LockedError } from './errors.ts'
import { unlockAtBoot } from './lock.ts'
import {
  build,
  Client,
  FAST,
  type Harness,
  HOUR,
  NEW_PASSPHRASE,
  PASSPHRASE,
  tick,
  UNATTENDED_KEY,
} from './test-harness.ts'

let current: Harness | undefined

afterEach(async () => {
  await current?.dispose()
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
    const db = createTestDb()
    const { dek } = await createKeySlots(db, PASSPHRASE, FAST)
    return { db, dek }
  }

  it('leaves a database without key slots unprotected', async () => {
    const keyring = new Keyring({ protected: false })
    const mode = await unlockAtBoot({
      db: createTestDb(),
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

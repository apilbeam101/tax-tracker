import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { backup } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { hasKeySlots, hasUnattendedSlot, unlockWithRecoveryKey } from './crypto/keyslots.ts'
import { formatRecoveryKey } from './crypto/recovery.ts'
import { build, Client, type Harness, PASSPHRASE, UNATTENDED_KEY } from './test-harness.ts'

let current: Harness | undefined

afterEach(async () => {
  await current?.dispose()
  current = undefined
})

// A database with no user yet, as a fresh install has.
async function freshInstall(options: { unattendedKey?: string } = {}) {
  const { h } = await build({ slots: false, ...options })
  current = h
  h.db.exec('DELETE FROM user')
  return h
}

const userCount = (h: Harness) =>
  (h.db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n

describe('first-run setup', () => {
  it('creates the user and key slots, signs in, and returns the recovery key once', async () => {
    const h = await freshInstall()
    const client = new Client(h.app)

    const res = await client.request('POST', '/api/auth/setup', { password: PASSPHRASE })
    expect(res.statusCode).toBe(201)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = res.json() as { recoveryKey: string; user: { username: string } }
    expect(body.user.username).toBe('admin')
    expect(body.recoveryKey).toMatch(/\S{8,}/)

    expect(hasKeySlots(h.db)).toBe(true)
    expect(hasUnattendedSlot(h.db)).toBe(false)
    expect(h.keyring.isProtected).toBe(true)
    expect(h.keyring.isLocked).toBe(false)
    expect((await client.me()).statusCode).toBe(200)
    expect((await client.status()).json()).toMatchObject({
      setupRequired: false,
      authenticated: true,
      locked: false,
      upgrade: 'confirm',
    })

    const dek = await unlockWithRecoveryKey(h.db, body.recoveryKey)
    expect(dek).not.toBeNull()
    dek?.fill(0)
  })

  it('treats the recovery key as unconfirmed until it is typed back', async () => {
    const h = await freshInstall()
    const client = new Client(h.app)
    const { recoveryKey } = (
      await client.request('POST', '/api/auth/setup', { password: PASSPHRASE })
    ).json() as { recoveryKey: string }

    const wrong = await client.request('POST', '/api/auth/upgrade/confirm', {
      recoveryKey: formatRecoveryKey(Buffer.alloc(32, 9)),
    })
    expect(wrong.statusCode).toBe(401)
    expect((await client.status()).json()).toMatchObject({ upgrade: 'confirm' })

    const ok = await client.request('POST', '/api/auth/upgrade/confirm', { recoveryKey })
    expect(ok.statusCode).toBe(200)
    expect((await client.status()).json()).toMatchObject({ upgrade: 'none' })
  })

  it('encrypts what is stored afterwards and unlocks again with the passphrase', async () => {
    const h = await freshInstall()
    const client = new Client(h.app)
    await client.request('POST', '/api/auth/setup', { password: PASSPHRASE })
    h.app.instruments.create(
      1,
      { ticker: 'SETUPTK', name: 'Fresh Install Marker Ltd', currency: 'GBP' },
      1,
    )

    const copy = join(h.dataDir, 'copy.db')
    await backup(h.db, copy)
    const bytes = readFileSync(copy).toString('latin1')
    rmSync(copy, { force: true })
    expect(bytes).not.toContain('SETUPTK')
    expect(bytes).not.toContain('Fresh Install Marker Ltd')

    await client.logout()
    expect(h.keyring.isLocked).toBe(true)
    expect((await new Client(h.app).me()).statusCode).toBe(423)

    const again = new Client(h.app)
    expect((await again.login()).statusCode).toBe(200)
    expect(h.app.instruments.getByTicker(1, 'SETUPTK')?.name).toBe('Fresh Install Marker Ltd')
  })

  it('refuses a second setup', async () => {
    const h = await freshInstall()
    await new Client(h.app).request('POST', '/api/auth/setup', { password: PASSPHRASE })
    const second = await new Client(h.app).request('POST', '/api/auth/setup', {
      password: 'another long passphrase',
    })
    expect(second.statusCode).toBe(409)
    expect(userCount(h)).toBe(1)
  })

  it('lets only one of two simultaneous setups win', async () => {
    const h = await freshInstall()
    const results = await Promise.all([
      new Client(h.app).request('POST', '/api/auth/setup', { password: PASSPHRASE }),
      new Client(h.app).request('POST', '/api/auth/setup', { password: PASSPHRASE }),
    ])
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409])
    expect(userCount(h)).toBe(1)
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM key_slot').get() as { n: number }).n).toBe(2)
  })

  it('only creates the user, and leaves the upgrade to the sign-in, when the database already holds data', async () => {
    const h = await freshInstall()
    h.app.instruments.create(
      1,
      { ticker: 'IMPORTED', name: 'Imported Before Setup', currency: 'GBP' },
      1,
    )
    const client = new Client(h.app)

    const res = await client.request('POST', '/api/auth/setup', { password: PASSPHRASE })
    expect(res.statusCode).toBe(201)
    expect((res.json() as { recoveryKey: unknown }).recoveryKey).toBeNull()
    expect(hasKeySlots(h.db)).toBe(false)
    expect(h.keyring.isProtected).toBe(false)
    expect(h.app.instruments.getByTicker(1, 'IMPORTED')?.name).toBe('Imported Before Setup')
    expect((await client.status()).json()).toMatchObject({
      authenticated: true,
      upgrade: 'available',
    })

    const upgrade = await client.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE })
    expect(upgrade.statusCode).toBe(200)
    expect(hasKeySlots(h.db)).toBe(true)
    expect(h.app.instruments.getByTicker(1, 'IMPORTED')?.name).toBe('Imported Before Setup')
  })

  it('answers 409 when key slots exist but there is no user', async () => {
    const { h } = await build({ slots: true })
    current = h
    h.db.exec('DELETE FROM user')
    const res = await new Client(h.app).request('POST', '/api/auth/setup', { password: PASSPHRASE })
    expect(res.statusCode).toBe(409)
    expect(userCount(h)).toBe(0)
  })

  it('does not delete an unrelated safety copy when the new recovery key is confirmed', async () => {
    const h = await freshInstall()
    const backups = join(h.dataDir, 'backups')
    mkdirSync(backups, { recursive: true })
    const oldCopy = join(backups, 'taxtracker-2026-01-01T00-00-00-abc123-pre-encryption.db')
    writeFileSync(oldCopy, "someone else's only copy")

    const client = new Client(h.app)
    const { recoveryKey } = (
      await client.request('POST', '/api/auth/setup', { password: PASSPHRASE })
    ).json() as { recoveryKey: string }
    const confirm = await client.request('POST', '/api/auth/upgrade/confirm', { recoveryKey })

    expect((confirm.json() as { removed: string[] }).removed).toEqual([])
    expect(existsSync(oldCopy)).toBe(true)
  })

  it('rejects a short passphrase without creating anything', async () => {
    const h = await freshInstall()
    const res = await new Client(h.app).request('POST', '/api/auth/setup', { password: 'short' })
    expect(res.statusCode).toBe(400)
    expect(userCount(h)).toBe(0)
    expect(hasKeySlots(h.db)).toBe(false)
  })

  it('reports whether an unattended key is available before anyone has signed in', async () => {
    const withKey = await freshInstall({ unattendedKey: UNATTENDED_KEY })
    expect((await new Client(withKey.app).status()).json()).toMatchObject({
      setupRequired: true,
      unattendedKeyAvailable: true,
    })
    await withKey.dispose()
    current = undefined

    const without = await freshInstall()
    expect((await new Client(without.app).status()).json()).toMatchObject({
      unattendedKeyAvailable: false,
    })
  })

  it('creates the unattended slot only when asked, and keeps the key unlocked', async () => {
    const asked = await freshInstall({ unattendedKey: UNATTENDED_KEY })
    const res = await new Client(asked.app).request('POST', '/api/auth/setup', {
      password: PASSPHRASE,
      unattended: true,
    })
    expect(res.statusCode).toBe(201)
    expect(hasUnattendedSlot(asked.db)).toBe(true)
    expect(asked.keyring.isPermanent).toBe(true)
    await asked.dispose()
    current = undefined

    const notAsked = await freshInstall({ unattendedKey: UNATTENDED_KEY })
    await new Client(notAsked.app).request('POST', '/api/auth/setup', { password: PASSPHRASE })
    expect(hasUnattendedSlot(notAsked.db)).toBe(false)
    expect(notAsked.keyring.isPermanent).toBe(false)
  })

  it('refuses the unattended slot when the server has no ENCRYPTION_KEY, and creates nothing', async () => {
    const h = await freshInstall()
    const res = await new Client(h.app).request('POST', '/api/auth/setup', {
      password: PASSPHRASE,
      unattended: true,
    })
    expect(res.statusCode).toBe(409)
    expect(userCount(h)).toBe(0)
    expect(hasKeySlots(h.db)).toBe(false)
  })
})

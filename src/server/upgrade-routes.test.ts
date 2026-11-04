import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isSealed } from './crypto/fields.ts'
import { hasKeySlots, unlockWithPassphrase } from './crypto/keyslots.ts'
import { formatRecoveryKey } from './crypto/recovery.ts'
import { build, Client, type Harness, NEW_PASSPHRASE, PASSPHRASE } from './test-harness.ts'

let current: Harness | undefined

afterEach(async () => {
  await current?.dispose()
  current = undefined
})

async function unencryptedApp(options: { unattendedKey?: string } = {}) {
  const { h } = await build({ slots: false, ...options })
  current = h
  h.app.instruments.create(
    1,
    { ticker: 'UPGR', name: 'Upgrade Subject Ltd', currency: 'GBP', notes: 'a-private-note' },
    1,
  )
  const client = new Client(h.app)
  await client.login()
  return { h, client }
}

const backupDirOf = (h: Harness) => join(h.dataDir, 'backups')
const safetyCopies = (h: Harness) =>
  existsSync(backupDirOf(h))
    ? readdirSync(backupDirOf(h)).filter((f) => f.endsWith('-pre-encryption.db'))
    : []

describe('offering the upgrade', () => {
  it('is offered to a signed-in user of an unencrypted database, and to nobody else', async () => {
    const { h, client } = await unencryptedApp()
    expect((await client.status()).json()).toMatchObject({ upgrade: 'available', locked: false })
    expect((await new Client(h.app).status()).json()).toMatchObject({ upgrade: 'none' })
  })

  it('is not offered before the first user exists', async () => {
    const { h } = await build({ slots: false })
    current = h
    h.db.exec('DELETE FROM user')
    expect((await new Client(h.app).status()).json()).toMatchObject({
      setupRequired: true,
      upgrade: 'none',
    })
  })

  it('requires a signed-in session', async () => {
    const { h } = await unencryptedApp()
    const res = await new Client(h.app).request('POST', '/api/auth/upgrade', {
      passphrase: PASSPHRASE,
    })
    expect(res.statusCode).toBe(401)
    expect(hasKeySlots(h.db)).toBe(false)
  })
})

describe('upgrading from the app', () => {
  it('encrypts the data, returns the recovery key once and keeps the user signed in', async () => {
    const { h, client } = await unencryptedApp()
    const otherSession = new Client(h.app)
    await otherSession.login()
    mkdirSync(h.dataDir, { recursive: true })
    writeFileSync(join(h.dataDir, 'taxtracker.db.bak-20260101'), 'an old plaintext copy')

    const res = await client.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      recoveryKey: string
      safetyCopy: string
      plaintextCopies: Array<{ name: string }>
      scrubbed: boolean
    }
    expect(body.recoveryKey).toMatch(/^([0-9A-Z]{5}-){10}[0-9A-Z]{5}$/)
    expect(body.safetyCopy).toMatch(/-pre-encryption\.db$/)
    expect(body.plaintextCopies.map((c) => c.name)).toEqual(['taxtracker.db.bak-20260101'])
    expect(body.scrubbed).toBe(true)

    expect(h.keyring.state).toBe('unlocked')
    expect(h.keyring.isProtected).toBe(true)
    expect((await client.me()).statusCode).toBe(200)
    expect((await client.status()).json()).toMatchObject({
      unlockMode: 'passphrase',
      locked: false,
      upgrade: 'confirm',
    })
    // Sessions opened before the data key existed are not carried over.
    expect((await otherSession.me()).statusCode).toBe(401)

    const raw = h.db.prepare('SELECT ticker, notes FROM instrument').get() as Record<
      string,
      unknown
    >
    expect(isSealed(raw.ticker)).toBe(true)
    expect(isSealed(raw.notes)).toBe(true)
    expect(h.app.instruments.getByTicker(1, 'UPGR')?.name).toBe('Upgrade Subject Ltd')
  })

  it('rejects a wrong passphrase without changing anything', async () => {
    const { h, client } = await unencryptedApp()
    const res = await client.request('POST', '/api/auth/upgrade', {
      passphrase: 'not the passphrase',
    })
    expect(res.statusCode).toBe(401)
    expect(hasKeySlots(h.db)).toBe(false)
    expect(h.keyring.isProtected).toBe(false)
    expect(safetyCopies(h)).toEqual([])
  })

  it('cannot be run twice, and says so with a code the client can act on', async () => {
    const { client } = await unencryptedApp()
    await client.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE })
    const again = await client.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: 'ALREADY_ENCRYPTED' })
  })

  it('also reports the code when a simultaneous upgrade won the race', async () => {
    const { h, client } = await unencryptedApp()
    const second = new Client(h.app)
    await second.login()
    const results = await Promise.all([
      client.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE }),
      second.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE }),
    ])
    const loser = results.find((r) => r.statusCode === 409)
    expect(loser?.json()).toMatchObject({ code: 'ALREADY_ENCRYPTED' })
  })

  it('aborts, changing nothing, if the passphrase was changed while it was running', async () => {
    const { h, client } = await unencryptedApp()
    // Stands in for another tab changing the passphrase between the check and the commit.
    h.db.exec(
      `CREATE TRIGGER passphrase_changed AFTER UPDATE ON instrument
       BEGIN UPDATE user SET password_hash = 'a-different-hash'; END`,
    )

    const res = await client.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/passphrase changed/i)
    expect(hasKeySlots(h.db)).toBe(false)
    expect(h.keyring.isProtected).toBe(false)
    expect(safetyCopies(h)).toEqual([])
    expect(h.db.prepare('SELECT password_hash FROM user').get()).not.toEqual({
      password_hash: 'a-different-hash',
    })
  })

  it('lets only one of two simultaneous upgrades through, leaving one safety copy', async () => {
    const { h, client } = await unencryptedApp()
    const second = new Client(h.app)
    await second.login()

    const [a, b] = await Promise.all([
      client.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE }),
      second.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE }),
    ])

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
    expect(safetyCopies(h)).toHaveLength(1)
    expect(h.keyring.state).toBe('unlocked')
    expect(h.app.instruments.getByTicker(1, 'UPGR')?.name).toBe('Upgrade Subject Ltd')
  })

  it('leaves the data, the keyring and the status untouched if the upgrade fails', async () => {
    const { h, client } = await unencryptedApp()
    h.db.exec(
      "CREATE TRIGGER boom BEFORE UPDATE ON instrument BEGIN SELECT RAISE(ABORT, 'boom'); END",
    )

    const res = await client.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE })

    expect(res.statusCode).toBe(500)
    expect(hasKeySlots(h.db)).toBe(false)
    expect(h.keyring.isProtected).toBe(false)
    expect(h.app.instruments.getByTicker(1, 'UPGR')?.name).toBe('Upgrade Subject Ltd')
    expect(safetyCopies(h)).toEqual([])
    expect((await client.status()).json()).toMatchObject({ upgrade: 'available' })
  })

  it('then behaves like any encrypted database: locks on logout, unlocks on sign-in', async () => {
    const { h, client } = await unencryptedApp()
    await client.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE })
    await client.logout()
    expect(h.keyring.state).toBe('locked')
    expect((await client.me()).statusCode).toBe(423)

    expect((await client.login()).statusCode).toBe(200)
    expect(h.keyring.state).toBe('unlocked')
    expect(h.app.instruments.list(1).map((i) => i.ticker)).toEqual(['UPGR'])
    expect(await unlockWithPassphrase(h.db, PASSPHRASE)).not.toBeNull()
  })
})

describe('an ENCRYPTION_KEY configured on the server', () => {
  const KEY = 'a-deployment-supplied-key-of-32-chars-or-more'

  it('is offered as an option, never applied on its own', async () => {
    const { h, client } = await unencryptedApp({ unattendedKey: KEY })
    expect((await client.status()).json()).toMatchObject({ unattendedKeyAvailable: true })

    const res = await client.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE })

    expect(res.statusCode).toBe(200)
    expect((res.json() as { unattended: boolean }).unattended).toBe(false)
    expect(h.keyring.isPermanent).toBe(false)
    expect(
      h.db.prepare("SELECT 1 FROM key_slot WHERE slot_type = 'unattended'").get(),
    ).toBeUndefined()
    await client.logout()
    expect(h.keyring.state).toBe('locked')
  })

  it('creates the unattended slot and keeps the key unlocked when the user opts in', async () => {
    const { h, client } = await unencryptedApp({ unattendedKey: KEY })

    const res = await client.request('POST', '/api/auth/upgrade', {
      passphrase: PASSPHRASE,
      unattended: true,
    })

    expect(res.statusCode).toBe(200)
    expect((res.json() as { unattended: boolean }).unattended).toBe(true)
    expect(h.keyring.isPermanent).toBe(true)
    expect(
      h.db.prepare("SELECT 1 FROM key_slot WHERE slot_type = 'unattended'").get(),
    ).toBeDefined()
    expect((await client.status()).json()).toMatchObject({ unlockMode: 'unattended' })
  })

  it('refuses the option when the server has no key, and changes nothing', async () => {
    const { h, client } = await unencryptedApp()
    expect((await client.status()).json()).toMatchObject({ unattendedKeyAvailable: false })

    const res = await client.request('POST', '/api/auth/upgrade', {
      passphrase: PASSPHRASE,
      unattended: true,
    })

    expect(res.statusCode).toBe(409)
    expect(hasKeySlots(h.db)).toBe(false)
    expect(safetyCopies(h)).toEqual([])
  })
})

describe('keeping the recovery key off the cache', () => {
  it('marks the responses that carry it no-store', async () => {
    const { client } = await unencryptedApp()
    const upgrade = await client.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE })
    expect(upgrade.headers['cache-control']).toBe('no-store')
    const rotate = await client.request('POST', '/api/auth/recovery-key/rotate', {
      currentPassword: PASSPHRASE,
    })
    expect(rotate.headers['cache-control']).toBe('no-store')
  })
})

describe('confirming the recovery key', () => {
  it('stays pending after a reload even if the safety copy file is gone', async () => {
    const { h, client } = await unencryptedApp()
    await client.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE })
    for (const name of safetyCopies(h)) rmSync(join(backupDirOf(h), name))

    expect((await client.status()).json()).toMatchObject({ upgrade: 'confirm' })
  })

  async function upgraded() {
    const { h, client } = await unencryptedApp()
    const res = await client.request('POST', '/api/auth/upgrade', { passphrase: PASSPHRASE })
    return { h, client, recoveryKey: (res.json() as { recoveryKey: string }).recoveryKey }
  }

  it('removes the plaintext safety copy only once the right key is typed back', async () => {
    const { h, client, recoveryKey } = await upgraded()
    expect(safetyCopies(h)).toHaveLength(1)

    const wrong = await client.request('POST', '/api/auth/upgrade/confirm', {
      recoveryKey: formatRecoveryKey(Buffer.alloc(32, 9)),
    })
    expect(wrong.statusCode).toBe(401)
    const mistyped = await client.request('POST', '/api/auth/upgrade/confirm', {
      recoveryKey: `${recoveryKey.slice(0, -1)}${recoveryKey.endsWith('0') ? '1' : '0'}`,
    })
    expect(mistyped.statusCode).toBe(400)
    expect(safetyCopies(h)).toHaveLength(1)

    const ok = await client.request('POST', '/api/auth/upgrade/confirm', { recoveryKey })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { removed: string[] }).removed).toHaveLength(1)
    expect(safetyCopies(h)).toEqual([])
    expect((await client.status()).json()).toMatchObject({ upgrade: 'none' })
  })

  it('is refused on a database that is not encrypted', async () => {
    const { client } = await unencryptedApp()
    const res = await client.request('POST', '/api/auth/upgrade/confirm', {
      recoveryKey: formatRecoveryKey(Buffer.alloc(32, 9)),
    })
    expect(res.statusCode).toBe(409)
  })

  it('offers a fresh recovery key to someone who did not save the first, which invalidates it', async () => {
    const { h, client, recoveryKey } = await upgraded()

    const wrongPassphrase = await client.request('POST', '/api/auth/recovery-key/rotate', {
      currentPassword: NEW_PASSPHRASE,
    })
    expect(wrongPassphrase.statusCode).toBe(401)

    const rotated = await client.request('POST', '/api/auth/recovery-key/rotate', {
      currentPassword: PASSPHRASE,
    })
    expect(rotated.statusCode).toBe(200)
    const fresh = (rotated.json() as { recoveryKey: string }).recoveryKey
    expect(fresh).not.toBe(recoveryKey)

    expect(
      (await client.request('POST', '/api/auth/upgrade/confirm', { recoveryKey })).statusCode,
    ).toBe(401)
    expect(
      (await client.request('POST', '/api/auth/upgrade/confirm', { recoveryKey: fresh }))
        .statusCode,
    ).toBe(200)
    expect(safetyCopies(h)).toEqual([])
  })

  it('rotation is refused on a database that is not encrypted', async () => {
    const { client } = await unencryptedApp()
    const res = await client.request('POST', '/api/auth/recovery-key/rotate', {
      currentPassword: PASSPHRASE,
    })
    expect(res.statusCode).toBe(409)
  })
})

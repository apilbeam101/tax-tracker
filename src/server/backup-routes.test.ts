import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadFixture, TICKER } from './repositories/sqlite/fixture.ts'
import { build, Client, type Harness } from './test-harness.ts'

let current: Harness | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await current?.dispose()
  current = undefined
})

async function signedIn(slots = true) {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const { h } = await build({ slots })
  current = h
  const client = new Client(h.app)
  await client.login()
  return { h, client }
}

function load(h: Harness) {
  return loadFixture({
    db: h.db,
    cipher: undefined as never,
    instruments: h.app.instruments,
    transactions: h.app.transactions,
    cgtDisposals: h.app.cgtDisposals,
    s104Pools: h.app.s104Pools,
    prices: h.app.prices,
    vestSchedules: h.app.vestSchedules,
    appSecrets: h.app.appSecrets,
  })
}

describe('backups', () => {
  it('requires a signed-in session', async () => {
    const { h } = await build({ slots: false })
    current = h
    const res = await h.app.inject({ method: 'GET', url: '/api/backup' })
    expect(res.statusCode).toBe(401)
  })

  it('creates, lists and downloads a backup, and refuses names it did not list', async () => {
    const { h, client } = await signedIn()

    const created = await client.request('POST', '/api/backup')
    expect(created.statusCode).toBe(200)
    const { name } = created.json() as { name: string }

    const listing = (await client.request('GET', '/api/backup')).json() as {
      backups: Array<{ name: string; reason: string }>
      restorePending: boolean
    }
    expect(listing.backups.map((b) => b.name)).toEqual([name])
    expect(listing.backups[0]?.reason).toBe('manual')
    expect(listing.restorePending).toBe(false)

    const download = await client.request('GET', `/api/backup/${name}`)
    expect(download.statusCode).toBe(200)
    expect(download.rawPayload.subarray(0, 15).toString()).toBe('SQLite format 3')

    expect((await client.request('GET', '/api/backup/nope.db')).statusCode).toBe(404)
    expect((await client.request('GET', '/api/backup/..%2Ftaxtracker.db')).statusCode).toBe(404)
    expect(existsSync(join(h.dataDir, 'backups', name))).toBe(true)
  })

  it('stages an uploaded backup, can cancel it, and rejects things that are not backups', async () => {
    const { h, client } = await signedIn()
    const { name } = (await client.request('POST', '/api/backup')).json() as { name: string }
    const file = readFileSync(join(h.dataDir, 'backups', name))

    const staged = await client.upload('/api/backup/restore', file)
    expect(staged.statusCode).toBe(200)
    expect(staged.json()).toEqual({
      staged: true,
      protected: true,
      sameKeys: null,
      restarting: false,
    })
    expect(existsSync(join(h.dataDir, 'restore-pending.db'))).toBe(true)
    expect(
      ((await client.request('GET', '/api/backup')).json() as { restorePending: boolean })
        .restorePending,
    ).toBe(true)

    expect((await client.request('DELETE', '/api/backup/restore')).json()).toEqual({
      cancelled: true,
    })
    expect(existsSync(join(h.dataDir, 'restore-pending.db'))).toBe(false)

    const junk = await client.upload('/api/backup/restore', Buffer.from('definitely not sqlite'))
    expect(junk.statusCode).toBe(400)
    expect(junk.json().message).toMatch(/not a SQLite database/)
    expect(existsSync(join(h.dataDir, 'restore-pending.db'))).toBe(false)
  })

  it('exits after staging when the deployment restarts it on exit, and not otherwise', async () => {
    const { h, client } = await signedIn()
    const { name } = (await client.request('POST', '/api/backup')).json() as { name: string }
    const file = readFileSync(join(h.dataDir, 'backups', name))
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      await client.upload('/api/backup/restore', file)
      await vi.advanceTimersByTimeAsync(500)
      expect(exit).not.toHaveBeenCalled()

      h.app.runtime.restoreRestart = 'exit'
      const staged = await client.upload('/api/backup/restore', file)
      expect(staged.json().restarting).toBe(true)
      await vi.advanceTimersByTimeAsync(500)
      expect(exit).toHaveBeenCalledWith(0)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('unencrypted copies', () => {
    function plaintextFile(path: string) {
      const db = new DatabaseSync(path)
      db.exec('CREATE TABLE t (x)')
      db.close()
    }
    const copies = async (client: Client) =>
      (
        (await client.request('GET', '/api/backup')).json() as {
          plaintextCopies: Array<{ name: string; location: string }>
        }
      ).plaintextCopies

    it('lists leftover plaintext copies, deletes only listed ones, and leaves the upgrade safety copy to its own flow', async () => {
      const { h, client } = await signedIn()
      // An upgrade has just run and its recovery key is not confirmed yet.
      h.db
        .prepare(
          "INSERT INTO audit_log (tenant_id, action, entity_type) VALUES (1, 'database.encrypted', 'database')",
        )
        .run()
      mkdirSync(join(h.dataDir, 'backups'), { recursive: true })
      plaintextFile(join(h.dataDir, 'backups', 'taxtracker-old.db'))
      plaintextFile(join(h.dataDir, 'backups', 'taxtracker-x-pre-encryption.db'))
      plaintextFile(join(h.dataDir, 'taxtracker.db.bak-1'))
      writeFileSync(join(h.dataDir, 'ghostfolio-export-1.json'), '{}')
      writeFileSync(join(h.dataDir, 'unrelated.txt'), 'keep')

      const found = await copies(client)
      expect(found.map((c) => c.name).sort()).toEqual([
        'ghostfolio-export-1.json',
        'taxtracker-old.db',
        'taxtracker.db.bak-1',
      ])

      const res = await client.request('POST', '/api/backup/plaintext-copies/delete', {
        copies: [
          { name: 'taxtracker-old.db', location: 'backups' },
          { name: 'unrelated.txt', location: 'data' },
          { name: 'taxtracker-x-pre-encryption.db', location: 'backups' },
          { name: '../taxtracker.db', location: 'backups' },
        ],
      })
      expect(res.statusCode).toBe(200)
      expect(existsSync(join(h.dataDir, 'backups', 'taxtracker-old.db'))).toBe(false)
      expect(existsSync(join(h.dataDir, 'unrelated.txt'))).toBe(true)
      expect(existsSync(join(h.dataDir, 'backups', 'taxtracker-x-pre-encryption.db'))).toBe(true)
      expect((await copies(client)).map((c) => c.name)).not.toContain('taxtracker-old.db')
    })

    it('stays quiet, and deletes nothing, while the database itself is not encrypted', async () => {
      const { h, client } = await signedIn(false)
      const made = (await client.request('POST', '/api/backup')).json() as { name: string }
      mkdirSync(join(h.dataDir, 'backups'), { recursive: true })
      plaintextFile(join(h.dataDir, 'backups', 'taxtracker-old.db'))
      expect(await copies(client)).toEqual([])

      // Every backup of an unprotected database is plaintext, so none may be deletable.
      const res = await client.request('POST', '/api/backup/plaintext-copies/delete', {
        copies: [
          { name: made.name, location: 'backups' },
          { name: 'taxtracker-old.db', location: 'backups' },
        ],
      })
      expect(res.statusCode).toBe(409)
      expect(existsSync(join(h.dataDir, 'backups', made.name))).toBe(true)
      expect(existsSync(join(h.dataDir, 'backups', 'taxtracker-old.db'))).toBe(true)
    })

    it('never offers a file it could not open, and leaves unselected copies alone', async () => {
      const { h, client } = await signedIn()
      mkdirSync(join(h.dataDir, 'backups'), { recursive: true })
      // What a damaged encrypted database kept by a restore looks like.
      writeFileSync(
        join(h.dataDir, 'backups', 'taxtracker-1-raw-pre-restore.db'),
        'damaged beyond opening',
      )
      plaintextFile(join(h.dataDir, 'backups', 'taxtracker-old.db'))
      writeFileSync(join(h.dataDir, 'ghostfolio-export-1.json'), '{}')

      const listing = (await client.request('GET', '/api/backup')).json() as {
        plaintextCopies: Array<{ name: string }>
        unreadableCopies: Array<{ name: string }>
      }
      expect(listing.unreadableCopies.map((c) => c.name)).toEqual([
        'taxtracker-1-raw-pre-restore.db',
      ])
      expect(listing.plaintextCopies.map((c) => c.name)).not.toContain(
        'taxtracker-1-raw-pre-restore.db',
      )

      const res = await client.request('POST', '/api/backup/plaintext-copies/delete', {
        copies: [
          { name: 'taxtracker-1-raw-pre-restore.db', location: 'backups' },
          { name: 'taxtracker-old.db', location: 'backups' },
        ],
      })
      expect(res.json().removed).toBe(1)
      expect(existsSync(join(h.dataDir, 'backups', 'taxtracker-1-raw-pre-restore.db'))).toBe(true)
      expect(existsSync(join(h.dataDir, 'backups', 'taxtracker-old.db'))).toBe(false)
      expect(existsSync(join(h.dataDir, 'ghostfolio-export-1.json'))).toBe(true)
    })

    it('holds the upgrade safety copy back only while its recovery key is unconfirmed', async () => {
      const { h, client } = await signedIn()
      mkdirSync(join(h.dataDir, 'backups'), { recursive: true })
      plaintextFile(join(h.dataDir, 'backups', 'taxtracker-x-pre-encryption.db'))
      // The harness records no 'database.encrypted' event, so the key counts as confirmed.
      expect((await copies(client)).map((c) => c.name)).toContain('taxtracker-x-pre-encryption.db')

      h.db
        .prepare(
          "INSERT INTO audit_log (tenant_id, action, entity_type) VALUES (1, 'database.encrypted', 'database')",
        )
        .run()
      expect((await copies(client)).map((c) => c.name)).not.toContain(
        'taxtracker-x-pre-encryption.db',
      )
    })
  })

  it('refuses an upload without the CSRF token', async () => {
    const { client } = await signedIn()
    const res = await client.upload('/api/backup/restore', Buffer.from('x'), false)
    expect(res.statusCode).toBe(403)
  })
})

describe('archive export and import', () => {
  const exportBody = { passphrase: 'export passphrase 1' }

  it('exports encrypted by default and only exports plaintext when confirmed', async () => {
    const { h, client } = await signedIn()
    load(h)

    expect((await client.request('POST', '/api/export/archive', {})).statusCode).toBe(400)
    expect(
      (await client.request('POST', '/api/export/archive', { passphrase: 'short' })).statusCode,
    ).toBe(400)
    expect(
      (await client.request('POST', '/api/export/archive', { plaintext: true })).statusCode,
    ).toBe(400)

    const sealed = await client.request('POST', '/api/export/archive', exportBody)
    expect(sealed.statusCode).toBe(200)
    expect(sealed.headers['content-disposition']).toMatch(/tax-tracker-archive-.*\.json/)
    expect(sealed.body).not.toContain(TICKER)
    expect(JSON.parse(sealed.body)).toMatchObject({ encrypted: true, formatVersion: 1 })

    const plain = await client.request('POST', '/api/export/archive', {
      plaintext: true,
      confirmPlaintext: true,
    })
    expect(plain.body).toContain(TICKER)
  })

  it('imports into an empty database and recomputes the disposals', async () => {
    const source = await signedIn()
    load(source.h)
    const archive = (await source.client.request('POST', '/api/export/archive', exportBody)).body
    const disposals = source.h.app.cgtDisposals.list(1).length
    expect(disposals).toBeGreaterThan(0)
    await source.h.dispose()
    current = undefined

    const target = await signedIn()
    const wrong = await target.client.request('POST', '/api/import/archive', {
      archive,
      passphrase: 'not the passphrase!!',
      mode: 'into-empty',
    })
    expect(wrong.statusCode).toBe(400)

    const res = await target.client.request('POST', '/api/import/archive', {
      archive,
      passphrase: exportBody.passphrase,
      mode: 'into-empty',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().instruments).toBe(2)
    expect(target.h.app.instruments.list(1).map((i) => i.ticker)).toContain(TICKER)
    expect(target.h.app.cgtDisposals.list(1)).toHaveLength(disposals)

    const again = await target.client.request('POST', '/api/import/archive', {
      archive,
      passphrase: exportBody.passphrase,
      mode: 'into-empty',
    })
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('NOT_EMPTY')
  })

  it('replace needs confirmation, takes a backup first, and refuses an unreadable archive before touching the data', async () => {
    const { h, client } = await signedIn()
    load(h)
    const archive = (await client.request('POST', '/api/export/archive', exportBody)).body
    const before = h.app.transactions.list(1).length

    const unconfirmed = await client.request('POST', '/api/import/archive', {
      archive,
      passphrase: exportBody.passphrase,
      mode: 'replace',
    })
    expect(unconfirmed.statusCode).toBe(400)

    const bad = await client.request('POST', '/api/import/archive', {
      archive: 'not an archive',
      mode: 'replace',
      confirmReplace: true,
    })
    expect(bad.statusCode).toBe(400)
    expect(h.app.transactions.list(1)).toHaveLength(before)

    const ok = await client.request('POST', '/api/import/archive', {
      archive,
      passphrase: exportBody.passphrase,
      mode: 'replace',
      confirmReplace: true,
    })
    expect(ok.statusCode).toBe(200)
    expect(h.app.transactions.list(1)).toHaveLength(before)
    const listing = (await client.request('GET', '/api/backup')).json() as {
      backups: Array<{ reason: string }>
    }
    expect(listing.backups.map((b) => b.reason)).toContain('pre-import')
  })
})

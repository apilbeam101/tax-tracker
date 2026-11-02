import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFieldCipher, plainCipher } from '../../crypto/fields.ts'
import type { Argon2idParams } from '../../crypto/kdf.ts'
import { Keyring } from '../../crypto/keyring.ts'
import { createKeySlots, setUnattendedKey } from '../../crypto/keyslots.ts'
import { initDb } from '../../db/database.ts'
import { listMigrationFiles, MIGRATIONS_DIR } from '../../db/migration-files.ts'
import { createFxRateStore } from '../../repositories/sqlite/FxRateStore.ts'
import { loadFixture, storesOn } from '../../repositories/sqlite/fixture.ts'
import { runTaxEngineForInstrument } from '../tax/engine.ts'
import {
  type ArchiveStores,
  buildArchive,
  encryptArchive,
  importArchive,
  parseArchive,
} from './archive.ts'
import { backupPath, createBackup, listBackups, pruneBackups } from './backups.ts'
import {
  applyPendingRestore,
  cancelPendingRestore,
  pendingRestorePath,
  stageRestore,
  validateBackupFile,
} from './restore.ts'
import { startBackupSchedule } from './scheduler.ts'
import { isServerRunning, serverLockIsFresh, waitForLockRelease } from './server-lock.ts'

const FAST_KDF: Argon2idParams = { kdf: 'argon2id', memoryKiB: 64, timeCost: 1, parallelism: 1 }

let dir: string
let dbPath: string

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  dir = mkdtempSync(join(tmpdir(), 'tt-backup-'))
  dbPath = join(dir, 'taxtracker.db')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

async function freshDb(path = dbPath) {
  return initDb(path)
}

describe('createBackup', () => {
  it('writes a verified single-file snapshot that includes committed WAL content', async () => {
    const db = await freshDb()
    db.exec("INSERT INTO instrument (tenant_id, ticker, name) VALUES (1, 'TST', 'Test')")

    const info = await createBackup(db, dir, 'manual')
    expect(info.name).toMatch(/^taxtracker-.*-manual\.db$/)
    expect(readdirSync(join(dir, 'backups'))).toEqual([info.name])

    const copy = new DatabaseSync(join(dir, 'backups', info.name), { readOnly: true })
    try {
      expect(copy.prepare('SELECT COUNT(*) AS n FROM instrument').get()).toEqual({ n: 1 })
    } finally {
      copy.close()
    }
    db.close()
  })

  it('finishes with a consistent snapshot while another connection keeps writing', async () => {
    const db = await freshDb()
    db.exec('CREATE TABLE bulk (id INTEGER PRIMARY KEY, a TEXT, b TEXT)')
    const fill = db.prepare('INSERT INTO bulk (a, b) VALUES (?, ?)')
    db.exec('BEGIN')
    for (let i = 0; i < 6000; i++) fill.run('x'.repeat(200), `row ${i}`)
    db.exec('COMMIT')

    // Another process, as the offline CLI against a running server would be, writing as fast as
    // it can for the whole time the backup runs.
    const script = `
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(process.argv[1])
      db.exec('PRAGMA busy_timeout = 5000')
      const insert = db.prepare('INSERT INTO bulk (a, b) VALUES (?, ?)')
      let n = 0
      const stop = Date.now() + 15000
      while (Date.now() < stop) { try { insert.run('y'.repeat(200), 'live ' + n++) } catch {} }
    `
    const writer = spawn(process.execPath, ['-e', script, dbPath], { stdio: 'ignore' })
    try {
      // Wait until the writer has really started, rather than for a fixed time.
      const count = () => (db.prepare('SELECT COUNT(*) AS n FROM bulk').get() as { n: number }).n
      for (let waited = 0; count() <= 6000 && waited < 10_000; waited += 50) {
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(count()).toBeGreaterThan(6000)
      const started = Date.now()
      const info = await createBackup(db, dir, 'manual')
      expect(Date.now() - started).toBeLessThan(25_000)

      const copy = new DatabaseSync(join(dir, 'backups', info.name), { readOnly: true })
      try {
        const rows = copy.prepare('SELECT COUNT(*) AS n FROM bulk').get() as { n: number }
        expect(rows.n).toBeGreaterThan(6000)
        expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      } finally {
        copy.close()
      }
    } finally {
      writer.kill()
      await new Promise((r) => setTimeout(r, 300))
    }
    db.close()
  }, 40_000)

  it('prunes only manual and scheduled backups and keeps those taken before a change', async () => {
    const db = await freshDb()
    await createBackup(db, dir, 'pre-restore')
    await createBackup(db, dir, 'pre-migration')
    for (let i = 0; i < 4; i++) {
      await createBackup(db, dir, 'manual', { keep: 100 })
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(pruneBackups(dir, 2)).toHaveLength(2)
    const reasons = listBackups(dir).map((b) => b.reason)
    expect(reasons.filter((r) => r === 'manual')).toHaveLength(2)
    expect(reasons).toContain('pre-restore')
    expect(reasons).toContain('pre-migration')
    db.close()
  })

  it('does not list the upgrade safety copy and only resolves listed names', async () => {
    const db = await freshDb()
    const info = await createBackup(db, dir, 'manual')
    writeFileSync(join(dir, 'backups', 'taxtracker-x-pre-encryption.db'), 'plaintext copy')
    writeFileSync(join(dir, 'secret.db'), 'x')

    expect(listBackups(dir).map((b) => b.name)).toEqual([info.name])
    expect(backupPath(dir, info.name)).toBeDefined()
    expect(backupPath(dir, 'taxtracker-x-pre-encryption.db')).toBeUndefined()
    expect(backupPath(dir, '../secret.db')).toBeUndefined()
    expect(backupPath(dir, '..\\secret.db')).toBeUndefined()
    expect(backupPath(dir, 'taxtracker-missing.db')).toBeUndefined()
    db.close()
  })
})

describe('pre-migration backup', () => {
  function applyOldMigrations(path: string, count: number): void {
    const db = new DatabaseSync(path)
    db.exec(
      "CREATE TABLE _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    for (const file of listMigrationFiles().slice(0, count)) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file)
    }
    db.close()
  }

  it('snapshots an existing database before applying a pending migration', async () => {
    applyOldMigrations(dbPath, listMigrationFiles().length - 1)
    const db = await freshDb()
    const backups = listBackups(dir)
    expect(backups.map((b) => b.reason)).toEqual(['pre-migration'])

    const copy = new DatabaseSync(join(dir, 'backups', backups[0]!.name), { readOnly: true })
    try {
      const applied = copy.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }
      expect(applied.n).toBe(listMigrationFiles().length - 1)
    } finally {
      copy.close()
    }
    db.close()
  })

  it('takes none for a brand-new database or when nothing is pending', async () => {
    ;(await freshDb()).close()
    expect(listBackups(dir)).toEqual([])
    ;(await freshDb()).close()
    expect(listBackups(dir)).toEqual([])
  })
})

const withAccount = (db: DatabaseSync) =>
  db
    .prepare('INSERT INTO "user" (tenant_id, username, password_hash) VALUES (1, ?, ?)')
    .run('a', 'x')

describe('scheduler', () => {
  it('waits for first-run setup: with no account yet there is nothing to protect', async () => {
    const db = await freshDb()
    const scheduler = startBackupSchedule({ db, dataDir: dir, schedule: 'daily', warn: vi.fn() })
    expect(await scheduler.runIfDue()).toBeUndefined()
    expect(listBackups(dir)).toEqual([])
    withAccount(db)
    expect(await scheduler.runIfDue()).toMatch(/-scheduled\.db$/)
    scheduler.stop()
    db.close()
  })

  it('takes a scheduled backup only when none was taken in the last day', async () => {
    const db = await freshDb()
    withAccount(db)
    const warn = vi.fn()
    const scheduler = startBackupSchedule({ db, dataDir: dir, schedule: 'daily', warn })
    try {
      expect(await scheduler.runIfDue()).toMatch(/-scheduled\.db$/)
      expect(await scheduler.runIfDue()).toBeUndefined()

      const [only] = listBackups(dir)
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
      utimesSync(join(dir, 'backups', only!.name), old, old)
      expect(await scheduler.runIfDue()).toMatch(/-scheduled\.db$/)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      scheduler.stop()
      db.close()
    }
  })

  it('does nothing when switched off', async () => {
    const db = await freshDb()
    const scheduler = startBackupSchedule({ db, dataDir: dir, schedule: 'off', warn: vi.fn() })
    expect(await scheduler.runIfDue()).toBeUndefined()
    expect(listBackups(dir)).toEqual([])
    db.close()
  })
})

describe('restore', () => {
  async function protectedBackup(path: string): Promise<void> {
    const db = await freshDb(path)
    const { dek } = await createKeySlots(db, 'a reasonably long passphrase', {
      passphraseKdf: FAST_KDF,
    })
    dek.fill(0)
    db.close()
  }

  it('swaps a staged backup in, keeps the previous database and drops its sidecar files', async () => {
    const live = await freshDb()
    live.exec("INSERT INTO instrument (tenant_id, ticker, name) VALUES (1, 'LIVE', 'Live')")
    live.close()

    const otherPath = join(dir, 'other', 'other.db')
    mkdirSync(join(dir, 'other'))
    const other = await freshDb(otherPath)
    other.exec("INSERT INTO instrument (tenant_id, ticker, name) VALUES (1, 'OLD', 'Old')")
    other.close()

    await stageRestore(dbPath, otherPath)
    expect(existsSync(pendingRestorePath(dir))).toBe(true)

    const result = await applyPendingRestore(dbPath, () => {})
    expect(result).toMatchObject({ applied: true })
    expect(existsSync(pendingRestorePath(dir))).toBe(false)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)

    const restored = new DatabaseSync(dbPath, { readOnly: true })
    expect(restored.prepare('SELECT ticker FROM instrument').all()).toEqual([{ ticker: 'OLD' }])
    restored.close()

    const safety = listBackups(dir).find((b) => b.reason === 'pre-restore')
    const kept = new DatabaseSync(join(dir, 'backups', safety!.name), { readOnly: true })
    expect(kept.prepare('SELECT ticker FROM instrument').all()).toEqual([{ ticker: 'LIVE' }])
    kept.close()
  })

  it('applies a staged restore when the database is opened', async () => {
    const live = await freshDb()
    live.close()
    const otherPath = join(dir, 'o.db')
    const other = await freshDb(otherPath)
    other.exec("INSERT INTO instrument (tenant_id, ticker, name) VALUES (1, 'OLD', 'Old')")
    other.close()

    await stageRestore(dbPath, otherPath)
    const db = await initDb(dbPath)
    expect(db.prepare('SELECT ticker FROM instrument').all()).toEqual([{ ticker: 'OLD' }])
    db.close()
  })

  it('rejects files that are not usable backups', async () => {
    const junk = join(dir, 'junk.db')
    writeFileSync(junk, 'this is not sqlite at all')
    expect(() => validateBackupFile(junk)).toThrow(/not a SQLite database/)

    const plain = join(dir, 'plain.db')
    const plainDb = new DatabaseSync(plain)
    plainDb.exec('CREATE TABLE t (x)')
    plainDb.close()
    expect(() => validateBackupFile(plain)).toThrow(/not a Tax Tracker backup/)

    const newer = join(dir, 'newer.db')
    const future = await freshDb(newer)
    future.exec("INSERT INTO _migrations (filename) VALUES ('999_future.sql')")
    future.close()
    expect(() => validateBackupFile(newer)).toThrow(/newer version/)

    const damaged = join(dir, 'damaged.db')
    await protectedBackup(damaged)
    const d = new DatabaseSync(damaged)
    d.exec("DELETE FROM key_slot WHERE slot_type = 'recovery'")
    d.close()
    expect(() => validateBackupFile(damaged)).toThrow(/damaged key slots/)
  })

  it('refuses to replace protected data with a backup that has no key slots', async () => {
    await protectedBackup(dbPath)
    const unprotected = join(dir, 'u.db')
    ;(await freshDb(unprotected)).close()
    await expect(stageRestore(dbPath, unprotected)).rejects.toThrow(/no key slots/)
    expect(existsSync(pendingRestorePath(dir))).toBe(false)
  })

  it('accepts an unprotected backup over an unprotected database', async () => {
    ;(await freshDb()).close()
    const older = join(dir, 'older.db')
    ;(await freshDb(older)).close()
    expect(await stageRestore(dbPath, older)).toEqual({
      protected: false,
      keyId: null,
      sameKeys: null,
    })
    expect(cancelPendingRestore(dir)).toBe(true)
    expect(existsSync(pendingRestorePath(dir))).toBe(false)
  })

  it('keeps a staged file that no longer validates instead of swapping it in', async () => {
    const live = await freshDb()
    live.exec("INSERT INTO instrument (tenant_id, ticker, name) VALUES (1, 'LIVE', 'Live')")
    live.close()
    writeFileSync(pendingRestorePath(dir), 'garbage')

    const log = vi.fn()
    expect(await applyPendingRestore(dbPath, log)).toMatchObject({ applied: false })
    expect(
      listBackups(dir)
        .map((b) => b.name)
        .some((n) => n.endsWith('-rejected-restore.db')),
    ).toBe(true)
    expect(log).toHaveBeenCalled()

    const still = new DatabaseSync(dbPath, { readOnly: true })
    expect(still.prepare('SELECT ticker FROM instrument').all()).toEqual([{ ticker: 'LIVE' }])
    still.close()
  })
})

describe('server lock', () => {
  const lock = () => join(dir, 'server.lock')
  const write = (held: object) => writeFileSync(lock(), JSON.stringify(held))
  const age = (ms: number) => {
    const when = new Date(Date.now() - ms)
    utimesSync(lock(), when, when)
  }

  it('has nothing to report without a lock file', async () => {
    expect(serverLockIsFresh(dir)).toBe(false)
    expect(await isServerRunning(dir)).toBe(false)
  })

  it('treats a recently refreshed lock from another host as a running server, even with the same process id', async () => {
    write({ id: 'x', pid: process.pid, host: 'some-other-container' })
    expect(serverLockIsFresh(dir)).toBe(true)
    expect(await isServerRunning(dir)).toBe(true)
  })

  it('knows at once that a previous run on this machine is gone', () => {
    write({ id: 'x', pid: 2 ** 22 + 12345, host: hostname() })
    expect(serverLockIsFresh(dir)).toBe(false)
    write({ id: 'x', pid: process.pid, host: hostname() })
    expect(serverLockIsFresh(dir)).toBe(false)
    write({ id: 'x', pid: process.ppid, host: hostname() })
    expect(serverLockIsFresh(dir)).toBe(true)
  })

  it('lets a lock that is no longer refreshed expire', async () => {
    write({ id: 'x', pid: 1, host: 'elsewhere' })
    age(10 * 60 * 1000 + 1000)
    expect(serverLockIsFresh(dir)).toBe(false)
    expect(await isServerRunning(dir)).toBe(false)
  })

  it('does not trust a lock that only looks stale by this machine clock', async () => {
    write({ id: 'x', pid: 1, host: 'elsewhere' })
    age(60_000)
    expect(serverLockIsFresh(dir)).toBe(false)

    const beat = setTimeout(() => {
      const now = new Date()
      utimesSync(lock(), now, now)
    }, 20)
    expect(await isServerRunning(dir, { settleMs: 100 })).toBe(true)
    clearTimeout(beat)

    age(60_000)
    expect(await isServerRunning(dir, { settleMs: 50 })).toBe(false)
  })

  it('makes a starting server wait for a fresh lock to go, and give up if it does not', async () => {
    write({ id: 'x', pid: 1, host: 'elsewhere' })
    expect(await waitForLockRelease(dir, { timeoutMs: 150, pollMs: 20 })).toBe(false)
    setTimeout(() => age(60_000), 40)
    expect(await waitForLockRelease(dir, { timeoutMs: 1000, pollMs: 20 })).toBe(true)
  })
})

describe('archive', () => {
  function stores(
    db: DatabaseSync,
    encrypted = false,
  ): ArchiveStores & ReturnType<typeof storesOn> {
    let cipher = plainCipher
    if (encrypted) {
      const keyring = new Keyring({ protected: true })
      keyring.unlock(Buffer.alloc(32, 7))
      cipher = createFieldCipher(keyring)
    }
    return { ...storesOn(db, cipher), fxRates: createFxRateStore(db) }
  }

  const strip = <T extends object>(rows: T[]) =>
    rows.map((r) => {
      // Ids are reassigned on import; everything else must come back exactly.
      // Ids and when a row was written are reassigned on import; everything else comes back exactly.
      const {
        id,
        txnId,
        createdAt,
        updatedAt,
        fetchedAt,
        importSource,
        tenantId,
        instrumentId,
        ...rest
      } = r as Record<string, unknown>
      return rest
    })

  async function source() {
    const db = await initDb(':memory:')
    const s = stores(db)
    loadFixture(s)
    db.exec(
      "INSERT INTO fx_rate (from_currency, to_currency, rate_date, rate, rate_type, source) VALUES ('USD','GBP','2024-05-01','0.8','hmrc-monthly','test')",
    )
    return s
  }

  it('round trips through an encrypted archive into a database that encrypts, with identical disposals', async () => {
    const a = await source()
    const archive = buildArchive(a, '1.2.3')
    const sealed = await encryptArchive(archive, 'export passphrase 1', FAST_KDF)
    expect(JSON.stringify(sealed)).not.toContain('ZQXTECH')

    const parsed = await parseArchive(JSON.stringify(sealed), 'export passphrase 1')
    const db = await initDb(':memory:')
    const b = stores(db, true)
    const summary = importArchive(b, parsed, 'into-empty', 1)
    expect(summary.transactions).toBe(archive.data.transactions.length)

    for (const inst of b.instruments.list(1)) {
      runTaxEngineForInstrument(1, inst.id, b.transactions, b.cgtDisposals, b.s104Pools)
    }

    expect(strip(b.instruments.list(1))).toEqual(strip(a.instruments.list(1)))
    expect(strip(b.transactions.list(1))).toEqual(strip(a.transactions.list(1)))
    expect(strip(b.vestSchedules.list(1))).toEqual(strip(a.vestSchedules.list(1)))
    expect(strip(b.cgtDisposals.list(1))).toEqual(strip(a.cgtDisposals.list(1)))
    expect(b.cgtDisposals.list(1).length).toBeGreaterThan(0)
    const price = (s: typeof a) =>
      s.instruments.list(1).flatMap((i) => s.prices.listRange(i.id, '0', '9'))
    expect(strip(price(b))).toEqual(strip(price(a)))
    expect(b.fxRates.get('USD', 'GBP', '2024-05-01', 'hmrc-monthly')?.rate).toBe('0.8')
  })

  it('carries a projection-to-transaction link across the id remapping', async () => {
    const a = await source()
    const vest = a.vestSchedules.list(1)[0]!
    const txn = a.transactions.list(1)[1]!
    a.vestSchedules.setRealisedTxn(1, vest.id, txn.id)

    const parsed = await parseArchive(JSON.stringify(buildArchive(a, 'x')))
    const b = stores(await initDb(':memory:'))
    importArchive(b, parsed, 'into-empty', 1)

    const linked = b.vestSchedules.list(1)[0]!
    const target = b.transactions.getById(1, linked.realisedTxnId!)
    expect(target?.txnDate).toBe(txn.txnDate)
    expect(target?.quantity).toBe(txn.quantity)
  })

  it('needs the right passphrase and refuses short ones', async () => {
    const a = await source()
    const sealed = JSON.stringify(
      await encryptArchive(buildArchive(a, 'x'), 'export passphrase 1', FAST_KDF),
    )
    await expect(parseArchive(sealed)).rejects.toMatchObject({
      code: 'ARCHIVE_PASSPHRASE_REQUIRED',
    })
    await expect(parseArchive(sealed, 'wrong passphrase!!')).rejects.toThrow(
      /Wrong export passphrase/,
    )
    await expect(encryptArchive(buildArchive(a, 'x'), 'short', FAST_KDF)).rejects.toThrow(
      /at least/,
    )

    const tampered = JSON.parse(sealed)
    tampered.payload = `${tampered.payload.slice(0, -4)}AAAA`
    await expect(parseArchive(JSON.stringify(tampered), 'export passphrase 1')).rejects.toThrow()
  })

  it('rejects files that are not archives or are from a newer format', async () => {
    await expect(parseArchive('not json')).rejects.toThrow(/not valid JSON/)
    await expect(parseArchive('{"format":"other"}')).rejects.toThrow(/not a Tax Tracker archive/)
    await expect(
      parseArchive(JSON.stringify({ format: 'tax-tracker-archive', formatVersion: 99, data: {} })),
    ).rejects.toThrow(/newer/)
  })

  it('refuses into-empty over existing data and leaves it untouched', async () => {
    const a = await source()
    const parsed = await parseArchive(JSON.stringify(buildArchive(a, 'x')))
    const before = a.transactions.list(1).length
    expect(() => importArchive(a, parsed, 'into-empty', 1)).toThrow(/already holds/)
    expect(a.transactions.list(1)).toHaveLength(before)
  })

  it('replace swaps the portfolio, and rolls back completely if the archive is bad', async () => {
    const a = await source()
    const good = await parseArchive(JSON.stringify(buildArchive(a, 'x')))
    const target = stores(await initDb(':memory:'))
    loadFixture(target)
    const before = strip(target.transactions.list(1))

    const broken = structuredClone(good)
    broken.data.transactions[3]!.instrumentId = 9999
    expect(() => importArchive(target, broken, 'replace', 1)).toThrow(/missing instrument/)
    expect(strip(target.transactions.list(1))).toEqual(before)
    expect(target.instruments.list(1)).toHaveLength(2)

    importArchive(target, good, 'replace', 1)
    expect(target.instruments.list(1)).toHaveLength(2)
    expect(target.transactions.list(1)).toHaveLength(good.data.transactions.length)
  })

  it('refuses a tax year row naming an unknown column', async () => {
    const a = await source()
    const parsed = await parseArchive(JSON.stringify(buildArchive(a, 'x')))
    parsed.data.taxYearConfig = [{ tax_year: '2030-31', 'x) VALUES (1); --': '1' }]
    const target = stores(await initDb(':memory:'))
    expect(() => importArchive(target, parsed, 'into-empty', 1)).toThrow(/invalid tax year/)
    expect(target.instruments.list(1)).toHaveLength(0)
  })

  it('adds a missing tax year but never changes one the database already has', async () => {
    const a = await source()
    const parsed = await parseArchive(JSON.stringify(buildArchive(a, 'x')))
    const existing = parsed.data.taxYearConfig[0]!
    const original = existing.cgt_basic_rate
    existing.cgt_basic_rate = '0'
    parsed.data.taxYearConfig.push({ ...existing, tax_year: '2099-00', cgt_basic_rate: '0.5' })

    const target = stores(await initDb(':memory:'))
    importArchive(target, parsed, 'into-empty', 1)
    const rate = (year: string) =>
      (
        target.db
          .prepare('SELECT cgt_basic_rate AS r FROM tax_year_config WHERE tax_year = ?')
          .get(year) as { r: string } | undefined
      )?.r
    expect(rate(existing.tax_year as string)).toBe(original)
    expect(rate('2099-00')).toBe('0.5')
  })

  it('refuses archive values that would later break the tax engine', async () => {
    const a = await source()
    const good = JSON.stringify(buildArchive(a, 'x'))
    const mutate = (change: (data: ReturnType<typeof buildArchive>['data']) => void) => {
      const archive = JSON.parse(good)
      change(archive.data)
      return parseArchive(JSON.stringify(archive))
    }
    await expect(mutate((d) => (d.transactions[0]!.totalGbp = 'abc'))).rejects.toThrow(/totalGbp/)
    await expect(
      mutate((d) => ((d.transactions[0] as never as { txnType: string }).txnType = 'NOPE')),
    ).rejects.toThrow(/txnType/)
    await expect(mutate((d) => (d.transactions[0]!.txnDate = '01/02/2024'))).rejects.toThrow(
      /txnDate/,
    )
    await expect(mutate((d) => d.instruments.push(null as never))).rejects.toThrow(/instruments #3/)
    await expect(
      mutate(
        (d) =>
          ((d.instruments[0] as never as { isEmployerStock: unknown }).isEmployerStock = 'yes'),
      ),
    ).rejects.toThrow(/isEmployerStock/)
    await expect(mutate((d) => (d.prices[0]!.closePrice = '1e9999'))).rejects.toThrow(/closePrice/)
    await expect(mutate(() => {})).resolves.toBeDefined()
  })

  it('caps the key-derivation cost an archive may ask for', async () => {
    const a = await source()
    const sealed = JSON.parse(
      JSON.stringify(await encryptArchive(buildArchive(a, 'x'), 'export passphrase 1', FAST_KDF)),
    )
    const huge = { ...sealed, kdf: { ...sealed.kdf, memoryKiB: 1_000_000 } }
    await expect(parseArchive(JSON.stringify(huge), 'export passphrase 1')).rejects.toThrow(
      /damaged/,
    )
    const shortSalt = { ...sealed, salt: 'AAAA' }
    await expect(parseArchive(JSON.stringify(shortSalt), 'export passphrase 1')).rejects.toThrow(
      /damaged/,
    )
  })
})

describe('restore hardening', () => {
  async function protectedAt(path: string, options: { unattended?: string; user?: boolean } = {}) {
    const db = await freshDb(path)
    if (options.user !== false) {
      db.prepare('INSERT INTO "user" (tenant_id, username, password_hash) VALUES (1, ?, ?)').run(
        'a',
        'x',
      )
    }
    const { dek } = await createKeySlots(db, 'a reasonably long passphrase', {
      passphraseKdf: FAST_KDF,
    })
    if (options.unattended) await setUnattendedKey(db, dek, options.unattended)
    dek.fill(0)
    db.close()
  }

  it('restores over a live database that cannot be opened', async () => {
    writeFileSync(dbPath, 'this live file is damaged beyond opening')
    const good = join(dir, 'good.db')
    const g = await freshDb(good)
    g.exec("INSERT INTO instrument (tenant_id, ticker, name) VALUES (1, 'GOOD', 'Good')")
    g.close()

    await stageRestore(dbPath, good)
    const result = await applyPendingRestore(dbPath, () => {})
    expect(result).toMatchObject({ applied: true })
    const restored = new DatabaseSync(dbPath, { readOnly: true })
    expect(restored.prepare('SELECT ticker FROM instrument').all()).toEqual([{ ticker: 'GOOD' }])
    restored.close()
    expect(readdirSync(join(dir, 'backups')).some((f) => f.endsWith('raw-pre-restore.db'))).toBe(
      true,
    )
  })

  it('refuses a backup the deployment key cannot open, at staging and again at boot', async () => {
    const backup = join(dir, 'backup.db')
    await protectedAt(backup, { unattended: 'k'.repeat(40) })
    ;(await freshDb()).close()

    await expect(stageRestore(dbPath, backup, { encryptionKey: 'x'.repeat(40) })).rejects.toThrow(
      /does not open the backup's unattended/,
    )
    expect(existsSync(pendingRestorePath(dir))).toBe(false)
    await expect(
      stageRestore(dbPath, backup, { encryptionKey: 'k'.repeat(40) }),
    ).resolves.toMatchObject({ protected: true })

    const log = vi.fn()
    const result = await applyPendingRestore(dbPath, log, { encryptionKey: 'x'.repeat(40) })
    expect(result).toMatchObject({ applied: false })
    const untouched = new DatabaseSync(dbPath, { readOnly: true })
    expect(untouched.prepare('SELECT COUNT(*) AS n FROM key_slot').get()).toEqual({ n: 0 })
    untouched.close()
  })

  it('says whether a backup shares its keys with the running database', async () => {
    await protectedAt(dbPath)
    const same = join(dir, 'same.db')
    const live = new DatabaseSync(dbPath)
    const { backup } = await import('node:sqlite')
    await backup(live, same)
    live.close()
    expect(await stageRestore(dbPath, same)).toMatchObject({ protected: true, sameKeys: true })

    // Cancelled first: a staged file in this folder would be applied when the next database opens.
    cancelPendingRestore(dir)
    const other = join(dir, 'other.db')
    await protectedAt(other)
    expect(await stageRestore(dbPath, other)).toMatchObject({ sameKeys: false })
  })

  it('refuses protected data with no account to sign in to', async () => {
    const orphan = join(dir, 'orphan.db')
    await protectedAt(orphan, { user: false })
    await expect(stageRestore(dbPath, orphan)).rejects.toThrow(/no account/)
  })

  it('refuses a source that still has a write-ahead log beside it', async () => {
    const source = join(dir, 'wal.db')
    ;(await freshDb(source)).close()
    writeFileSync(`${source}-wal`, 'pending frames')
    await expect(stageRestore(dbPath, source)).rejects.toThrow(/write-ahead log/)
  })

  async function stagedOver(live: string, ticker: string) {
    const liveDb = await freshDb()
    liveDb.exec(`INSERT INTO instrument (tenant_id, ticker, name) VALUES (1, '${live}', 'Live')`)
    liveDb.close()
    const incoming = join(dir, `${ticker}.db`)
    const other = await freshDb(incoming)
    other.exec(`INSERT INTO instrument (tenant_id, ticker, name) VALUES (1, '${ticker}', 'In')`)
    other.close()
    await stageRestore(dbPath, incoming)
  }

  const tickers = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      return db.prepare('SELECT ticker FROM instrument').all()
    } finally {
      db.close()
    }
  }

  it('picks up a claimed file left behind by an interrupted attempt', async () => {
    await stagedOver('LIVE', 'NEW')
    const claimed = join(dir, 'restore-applying.db')
    renameSync(pendingRestorePath(dir), claimed)

    // A claim made moments ago is somebody's work in progress and is left alone.
    expect(await applyPendingRestore(dbPath, () => {})).toBeNull()
    const old = new Date(Date.now() - 10 * 60 * 1000)
    utimesSync(claimed, old, old)
    expect(await applyPendingRestore(dbPath, () => {})).toMatchObject({ applied: true })
    expect(tickers(dbPath)).toEqual([{ ticker: 'NEW' }])
  })

  it('claims the staged file so a second caller finds nothing to apply', async () => {
    await stagedOver('LIVE', 'NEW')
    const [first, second] = await Promise.all([
      applyPendingRestore(dbPath, () => {}),
      applyPendingRestore(dbPath, () => {}),
    ])
    expect([first?.applied, second?.applied].filter(Boolean)).toEqual([true])
    expect(tickers(dbPath)).toEqual([{ ticker: 'NEW' }])
  })

  it('puts the staged file back and leaves the database alone when the pre-swap check fails', async () => {
    await stagedOver('LIVE', 'NEW')
    await expect(
      applyPendingRestore(dbPath, () => {}, {
        beforeSwap: () => {
          throw new Error('a server started')
        },
      }),
    ).rejects.toThrow(/a server started/)
    expect(existsSync(pendingRestorePath(dir))).toBe(true)
    expect(existsSync(join(dir, 'restore-applying.db'))).toBe(false)
    expect(tickers(dbPath)).toEqual([{ ticker: 'LIVE' }])
  })

  it('never throws when the staged file cannot be set aside in backups/', async () => {
    ;(await freshDb()).close()
    writeFileSync(join(dir, 'backups'), 'a file where the folder should be')
    writeFileSync(pendingRestorePath(dir), 'garbage')
    const log = vi.fn()
    expect(await applyPendingRestore(dbPath, log)).toMatchObject({ applied: false })
    expect(existsSync(pendingRestorePath(dir))).toBe(false)
    expect(existsSync(join(dir, 'restore-applying.db'))).toBe(false)
    expect(existsSync(join(dir, 'restore-rejected.db'))).toBe(true)
  })

  it('does not repeat a pre-migration backup made moments ago', async () => {
    const earlier = await freshDb(join(dir, 'earlier.db'))
    await createBackup(earlier, dir, 'pre-migration')
    earlier.close()

    const old = join(dir, 'old')
    mkdirSync(old)
    const db = new DatabaseSync(dbPath)
    db.exec(
      "CREATE TABLE _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    const [first] = listMigrationFiles()
    db.exec(readFileSync(join(MIGRATIONS_DIR, first!), 'utf8'))
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(first!)
    db.close()

    ;(await initDb(dbPath)).close()
    expect(listBackups(dir).filter((b) => b.reason === 'pre-migration')).toHaveLength(1)
  })

  it('keeps manual and scheduled backups in separate pools and never prunes the one just made', async () => {
    const db = await freshDb()
    for (let i = 0; i < 3; i++) {
      await createBackup(db, dir, 'scheduled', { keep: 100 })
      await new Promise((r) => setTimeout(r, 3))
    }
    for (let i = 0; i < 4; i++) {
      await createBackup(db, dir, 'manual', { keep: 100 })
      await new Promise((r) => setTimeout(r, 3))
    }
    const newest = (await createBackup(db, dir, 'manual', { keep: 1 })).name
    const reasons = listBackups(dir).map((b) => b.reason)
    expect(reasons.filter((r) => r === 'scheduled')).toHaveLength(1)
    expect(reasons.filter((r) => r === 'manual')).toHaveLength(1)
    expect(listBackups(dir).map((b) => b.name)).toContain(newest)
    db.close()
  })

  it('takes a scheduled backup even when the last one is dated in the future', async () => {
    const db = await freshDb()
    withAccount(db)
    const scheduler = startBackupSchedule({ db, dataDir: dir, schedule: 'daily', warn: vi.fn() })
    const first = await scheduler.runIfDue()
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    utimesSync(join(dir, 'backups', first!), future, future)
    expect(await scheduler.runIfDue()).toBeDefined()
    scheduler.stop()
    db.close()
  })
})

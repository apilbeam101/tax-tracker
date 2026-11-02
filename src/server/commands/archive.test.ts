import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plainCipher } from '../crypto/fields.ts'
import { createKeySlots } from '../crypto/keyslots.ts'
import { formatRecoveryKey, generateRecoveryKey } from '../crypto/recovery.ts'
import { initDb } from '../db/database.ts'
import { loadFixture, storesOn } from '../repositories/sqlite/fixture.ts'
import { listBackups } from '../services/backup/backups.ts'
import { runExport, runImport, runRestore } from './archive.ts'
import { runBackup } from './backup.ts'

const PASSPHRASE = 'a reasonably long passphrase'
const EXPORT_PASSPHRASE = 'export passphrase 1'
const FAST = {
  passphraseKdf: { kdf: 'argon2id', memoryKiB: 64, timeCost: 1, parallelism: 1 },
} as const
const never = () => Promise.reject(new Error('no passphrase should be asked for'))

let root: string

function envFor(name: string): NodeJS.ProcessEnv {
  return { DATA_DIR: join(root, name) }
}

async function makeData(name: string, options: { fixture?: boolean; slots?: boolean } = {}) {
  const env = envFor(name)
  const db = await initDb(join(env.DATA_DIR as string, 'taxtracker.db'))
  db.prepare('INSERT INTO user (tenant_id, username, password_hash) VALUES (1, ?, ?)').run(
    'admin',
    'x',
  )
  if (options.fixture) loadFixture(storesOn(db, plainCipher))
  if (options.slots) {
    const { dek } = await createKeySlots(db, PASSPHRASE, FAST)
    dek.fill(0)
  }
  db.close()
  return env
}

const countTxns = async (env: NodeJS.ProcessEnv) => {
  const db = await initDb(join(env.DATA_DIR as string, 'taxtracker.db'))
  const n = (db.prepare('SELECT COUNT(*) AS n FROM txn').get() as { n: number }).n
  db.close()
  return n
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  root = mkdtempSync(join(tmpdir(), 'tt-cli-archive-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('export and import commands', () => {
  it('moves data between two installs through an encrypted archive', async () => {
    const source = await makeData('a', { fixture: true })
    const out = join(root, 'archive.json')
    await runExport(source, never, () => Promise.resolve(EXPORT_PASSPHRASE), {
      out,
      plaintext: false,
    })

    const text = readFileSync(out, 'utf8')
    expect(text).not.toContain('ZQXTECH')
    expect(JSON.parse(text).encrypted).toBe(true)

    const target = await makeData('b')
    const asked = vi.fn(() => Promise.resolve(EXPORT_PASSPHRASE))
    const summary = await runImport(target, out, never, asked, { replace: false })
    expect(summary.instruments).toBe(2)
    expect(asked).toHaveBeenCalledTimes(1)
    expect(await countTxns(target)).toBe(await countTxns(source))
  })

  it('writes a private file and will not overwrite an existing one', async () => {
    const source = await makeData('a', { fixture: true })
    const out = join(root, 'archive.json')
    await runExport(source, never, () => Promise.resolve(EXPORT_PASSPHRASE), {
      out,
      plaintext: true,
    })
    if (process.platform !== 'win32') expect(statSync(out).mode & 0o077).toBe(0)
    expect(readFileSync(out, 'utf8')).toContain('ZQXTECH')
    await expect(
      runExport(source, never, () => Promise.resolve(EXPORT_PASSPHRASE), { out, plaintext: true }),
    ).rejects.toThrow(/Could not write/)
  })

  it('imports a plaintext archive without asking for a passphrase, and replace backs up first', async () => {
    const source = await makeData('a', { fixture: true })
    const out = join(root, 'plain.json')
    await runExport(source, never, never, { out, plaintext: true })

    const target = await makeData('b', { fixture: true })
    await expect(runImport(target, out, never, never, { replace: false })).rejects.toThrow(
      /already holds/,
    )
    await runImport(target, out, never, never, { replace: true })
    expect(listBackups(join(root, 'b')).map((b) => b.reason)).toContain('pre-import')
  })

  it('stops while the app is running', async () => {
    const source = await makeData('a', { fixture: true })
    const out = join(root, 'plain.json')
    await runExport(source, never, never, { out, plaintext: true })
    const target = await makeData('b')
    writeFileSync(join(root, 'b', 'server.lock'), JSON.stringify({ pid: process.ppid }))
    await expect(runImport(target, out, never, never, { replace: false })).rejects.toThrow(
      /appears to be running/,
    )
    expect(await countTxns(target)).toBe(0)
  })

  it('asks for the database passphrase and rejects a wrong one', async () => {
    const env = await makeData('a', { slots: true })
    const out = join(root, 'x.json')
    await expect(
      runExport(env, () => Promise.resolve('wrong passphrase!!'), never, { out, plaintext: true }),
    ).rejects.toThrow(/does not open/)
    expect(existsSync(out)).toBe(false)
    await runExport(env, () => Promise.resolve(PASSPHRASE), never, { out, plaintext: true })
    expect(existsSync(out)).toBe(true)
  })

  it('opens a protected database with the recovery key as well as the passphrase', async () => {
    const env = envFor('r')
    const db = await initDb(join(env.DATA_DIR as string, 'taxtracker.db'))
    db.prepare('INSERT INTO user (tenant_id, username, password_hash) VALUES (1, ?, ?)').run(
      'admin',
      'x',
    )
    const { dek, recoveryKey } = await createKeySlots(db, PASSPHRASE, FAST)
    dek.fill(0)
    db.close()

    const out = join(root, 'by-recovery.json')
    await runExport(env, () => Promise.resolve(recoveryKey), never, { out, plaintext: true })
    expect(existsSync(out)).toBe(true)
    await expect(
      runExport(env, () => Promise.resolve(recoveryKey.replace(/.$/, 'X')), never, {
        out: join(root, 'no.json'),
        plaintext: true,
      }),
    ).rejects.toThrow(/does not open/)
  })

  it('still accepts a passphrase that happens to be shaped like a recovery key', async () => {
    const lookalike = formatRecoveryKey(generateRecoveryKey())
    const env = envFor('l')
    const db = await initDb(join(env.DATA_DIR as string, 'taxtracker.db'))
    db.prepare('INSERT INTO user (tenant_id, username, password_hash) VALUES (1, ?, ?)').run(
      'admin',
      'x',
    )
    const { dek } = await createKeySlots(db, lookalike, FAST)
    dek.fill(0)
    db.close()

    const out = join(root, 'lookalike.json')
    await runExport(env, () => Promise.resolve(lookalike), never, { out, plaintext: true })
    expect(existsSync(out)).toBe(true)
  })

  it('needs an account to attribute the import to', async () => {
    const env = envFor('c')
    ;(await initDb(join(env.DATA_DIR as string, 'taxtracker.db'))).close()
    await expect(
      runExport(env, never, never, { out: join(root, 'y.json'), plaintext: true }),
    ).rejects.toThrow(/No account exists/)
  })
})

describe('restore and backup commands', () => {
  it('restores a backup over the current database', async () => {
    const env = await makeData('a', { fixture: true })
    const file = await runBackup(env)
    const dbPath = join(root, 'a', 'taxtracker.db')

    const db = await initDb(dbPath)
    db.exec(
      'DELETE FROM cgt_disposal; DELETE FROM s104_pool; DELETE FROM vest_schedule; DELETE FROM txn',
    )
    db.close()
    expect(await countTxns(env)).toBe(0)

    const message = await runRestore(env, file)
    expect(message).toContain('Restored')
    expect(await countTxns(env)).toBeGreaterThan(0)
    expect(listBackups(join(root, 'a')).map((b) => b.reason)).toContain('pre-restore')
  })

  it('refuses while the app is running and for files that are not backups', async () => {
    const env = await makeData('a')
    const file = await runBackup(env)
    writeFileSync(join(root, 'a', 'server.lock'), JSON.stringify({ pid: process.ppid }))
    await expect(runRestore(env, file)).rejects.toThrow(/appears to be running/)

    rmSync(join(root, 'a', 'server.lock'))
    const junk = join(root, 'junk.db')
    writeFileSync(junk, 'nope')
    await expect(runRestore(env, junk)).rejects.toThrow(/not a SQLite database/)
  })
})

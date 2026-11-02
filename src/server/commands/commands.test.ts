import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readConfigFile } from '../config/file.ts'
import type { Argon2idParams } from '../crypto/kdf.ts'
import {
  createKeySlots,
  hasUnattendedSlot,
  listSlots,
  unlockWithRecoveryKey,
} from '../crypto/keyslots.ts'
import { runBackfillFx } from './backfill-fx.ts'
import { runBackup } from './backup.ts'
import {
  checkConfigFile,
  checkDatabase,
  checkDataDir,
  checkNode,
  checkPort,
  checkSecrets,
  checkUnattendedKey,
  checkUnattendedKeyLocation,
  runDoctor,
} from './doctor.ts'
import { gatherInfo } from './info.ts'
import { addUnattended, removeUnattended, rotateRecovery } from './keys.ts'
import { CliError } from './util.ts'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'db', 'migrations')
const FAST: { passphraseKdf: Argon2idParams } = {
  passphraseKdf: { kdf: 'argon2id', memoryKiB: 64, timeCost: 1, parallelism: 1 },
}
const PASSPHRASE = 'a reasonably long passphrase'
const UNATTENDED = 'u'.repeat(64)
const SESSION = 's'.repeat(64)

let dir: string
let dbPath: string
let env: NodeJS.ProcessEnv

function createDb(): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'))
  }
  return db
}

async function createEncryptedDb(): Promise<string> {
  const db = createDb()
  const { recoveryKey, dek } = await createKeySlots(db, PASSPHRASE, FAST)
  dek.fill(0)
  db.close()
  return recoveryKey
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-cmd-'))
  dbPath = join(dir, 'taxtracker.db')
  env = { DATA_DIR: dir, SESSION_SECRET: SESSION }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('info', () => {
  it('reports a data directory with no database yet', () => {
    const info = gatherInfo(env)
    expect(info).toMatchObject({
      dataDir: dir,
      database: 'not created yet',
      unlockMode: 'unprotected',
      lastBackup: undefined,
    })
  })

  it('reports an unprotected database', () => {
    createDb().close()
    expect(gatherInfo(env)).toMatchObject({ database: 'unprotected', keySlots: [] })
  })

  it('reports key slots and the unlock mode of a protected database', async () => {
    await createEncryptedDb()
    expect(gatherInfo(env)).toMatchObject({
      database: 'protected',
      unlockMode: 'passphrase',
      keySlots: ['passphrase', 'recovery'],
    })
  })
})

describe('doctor checks', () => {
  it('rejects an old Node', () => {
    expect(checkNode('22.1.0').status).toBe('fail')
    expect(checkNode('24.0.0').status).toBe('ok')
  })

  it('accepts a missing data directory and a usable one', () => {
    expect(checkDataDir(join(dir, 'missing')).status).toBe('ok')
    expect(checkDataDir(dir).status).toBe('ok')
  })

  it('fails on a config file that carries key material', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ENCRYPTION_KEY: 'x'.repeat(40) }))
    const result = checkConfigFile(dir)
    expect(result.status).toBe('fail')
    expect(result.detail).not.toContain('x'.repeat(40))
  })

  it('reports invalid settings without echoing secret values', () => {
    const bad = { DATA_DIR: dir, SESSION_SECRET: 'CHANGE_ME_before_use_please_0123456789' }
    const result = checkSecrets(bad, dir)
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('SESSION_SECRET')
    expect(result.detail).not.toContain('CHANGE_ME_before')
  })

  it('does not call a fresh self-configured install misconfigured', () => {
    expect(checkSecrets({ DATA_DIR: dir, AUTO_CONFIG: 'true' }, dir).status).toBe('ok')
    expect(checkSecrets({ DATA_DIR: dir }, dir).status).toBe('fail')
    expect(readConfigFile(dir)).toBeUndefined()
  })

  it('fails when the unattended key file sits inside the data directory', () => {
    expect(checkUnattendedKeyLocation({ ENCRYPTION_KEY_FILE: join(dir, 'key') }, dir).status).toBe(
      'fail',
    )
    expect(
      checkUnattendedKeyLocation({ ENCRYPTION_KEY_FILE: join(tmpdir(), 'elsewhere-key') }, dir)
        .status,
    ).toBe('ok')
    expect(checkUnattendedKeyLocation({}, dir).status).toBe('ok')
  })

  it('passes a healthy encrypted database and fails when a required slot is gone', async () => {
    await createEncryptedDb()
    expect(checkDatabase(dbPath).every((c) => c.status === 'ok')).toBe(true)

    const db = new DatabaseSync(dbPath)
    db.exec("DELETE FROM key_slot WHERE slot_type = 'recovery'")
    db.close()
    const slots = checkDatabase(dbPath).find((c) => c.name === 'key slots')
    expect(slots?.status).toBe('fail')
    expect(slots?.detail).toContain('recovery')
  })

  it('keeps going and reports a broken config file instead of crashing', async () => {
    writeFileSync(join(dir, 'config.json'), '{ bad json SESSION_SECRET: abcdef0123')
    const checks = await runDoctor({ DATA_DIR: dir, AUTO_CONFIG: 'true', PORT: '0' })
    const config = checks.find((c) => c.name === 'config file')
    expect(config?.status).toBe('fail')
    expect(config?.detail).not.toContain('abcdef0123')
    expect(checks.find((c) => c.name === 'node')).toBeDefined()
    expect(checks.find((c) => c.name === 'database')).toBeDefined()
  })

  it('ignores the config file in env-supplied mode, as the server does', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ SESSION_SECRET: SESSION }))
    expect(checkSecrets({ DATA_DIR: dir }, dir).status).toBe('fail')
    expect(checkSecrets({ DATA_DIR: dir, AUTO_CONFIG: 'true' }, dir).status).toBe('ok')
  })

  it('checks that ENCRYPTION_KEY opens the unattended slot', async () => {
    await createEncryptedDb()
    const withKey = { ...env, ENCRYPTION_KEY: UNATTENDED }
    expect((await checkUnattendedKey(withKey, dbPath))?.status).toBe('warn')

    await addUnattended(withKey, () => Promise.resolve(PASSPHRASE))
    expect((await checkUnattendedKey(withKey, dbPath))?.status).toBe('ok')
    expect(
      (await checkUnattendedKey({ ...env, ENCRYPTION_KEY: 'v'.repeat(64) }, dbPath))?.status,
    ).toBe('fail')
    expect(await checkUnattendedKey(env, dbPath)).toBeUndefined()
  })

  it('warns when the port is already taken', async () => {
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>((r) => server.listen({ host: '127.0.0.1', port: 0 }, r))
    const port = (server.address() as { port: number }).port
    try {
      expect((await checkPort('127.0.0.1', port)).status).toBe('warn')
    } finally {
      await new Promise((r) => server.close(r))
    }
    expect((await checkPort('127.0.0.1', port)).status).toBe('ok')
  })
})

describe('keys', () => {
  const passphrase = () => Promise.resolve(PASSPHRASE)

  it('refuses a database with no key slots', async () => {
    createDb().close()
    await expect(rotateRecovery(env, passphrase)).rejects.toThrow(/no key slots/)
  })

  it('refuses the wrong passphrase', async () => {
    await createEncryptedDb()
    await expect(rotateRecovery(env, () => Promise.resolve('wrong passphrase'))).rejects.toThrow(
      /does not open/,
    )
  })

  it('rotates the recovery key: the new one opens the data and the old one stops working', async () => {
    const oldKey = await createEncryptedDb()
    const newKey = await rotateRecovery(env, passphrase)
    expect(newKey).not.toBe(oldKey)

    const db = new DatabaseSync(dbPath)
    try {
      expect(await unlockWithRecoveryKey(db, oldKey)).toBeNull()
      expect(await unlockWithRecoveryKey(db, newKey)).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('adds and removes the unattended slot using the key from the environment', async () => {
    await createEncryptedDb()
    const withKey = { ...env, ENCRYPTION_KEY: UNATTENDED }
    expect(await addUnattended(withKey, passphrase)).toContain('Unattended key added.')

    let db = new DatabaseSync(dbPath)
    expect(hasUnattendedSlot(db)).toBe(true)
    expect(listSlots(db).map((s) => s.slotType)).toContain('unattended')
    db.close()

    expect(await removeUnattended(env, passphrase)).toBe('Unattended key removed.')
    db = new DatabaseSync(dbPath)
    expect(hasUnattendedSlot(db)).toBe(false)
    db.close()
  })

  it('needs a key to add, and refuses a weak one or one stored in the data directory', async () => {
    await createEncryptedDb()
    await expect(addUnattended(env, passphrase)).rejects.toThrow(/ENCRYPTION_KEY_FILE/)
    await expect(addUnattended({ ...env, ENCRYPTION_KEY: 'short' }, passphrase)).rejects.toThrow(
      /too short/,
    )
    const keyFile = join(dir, 'unattended.key')
    writeFileSync(keyFile, UNATTENDED)
    await expect(
      addUnattended({ ...env, ENCRYPTION_KEY_FILE: keyFile }, passphrase),
    ).rejects.toThrow(/inside the data directory/)
  })
})

describe('backup', () => {
  it('writes a readable snapshot under the data directory', async () => {
    const db = createDb()
    db.exec("INSERT INTO instrument (tenant_id, ticker, name) VALUES (1, 'TST', 'Test')")
    db.close()

    const dest = await runBackup(env)
    expect(dest.startsWith(join(dir, 'backups'))).toBe(true)
    const copy = new DatabaseSync(dest, { readOnly: true })
    try {
      expect(copy.prepare('SELECT COUNT(*) AS n FROM instrument').get()).toEqual({ n: 1 })
    } finally {
      copy.close()
    }
  })

  it('fails clearly when there is no database', async () => {
    mkdirSync(dir, { recursive: true })
    await expect(runBackup(env)).rejects.toThrow(CliError)
  })
})

describe('backfill-fx', () => {
  it('refuses an encrypted database', async () => {
    await createEncryptedDb()
    await expect(runBackfillFx(env, () => {})).rejects.toThrow(/encrypted database/)
  })

  it('has nothing to do on a database with no pending rows', async () => {
    createDb().close()
    const lines: string[] = []
    await expect(runBackfillFx(env, (l) => lines.push(l))).resolves.toEqual({
      updated: 0,
      failed: 0,
    })
    expect(lines[0]).toContain('No rows to backfill')
  })

  it('fills the GBP fields of a pending transaction and leaves finished ones alone', async () => {
    const db = createDb()
    db.exec("INSERT INTO instrument (tenant_id, ticker, name) VALUES (1, 'TST', 'Test')")
    db.exec(`INSERT INTO txn (tenant_id, instrument_id, txn_type, txn_date, quantity,
      unit_price_native, native_currency, costs_gbp)
      VALUES (1, 1, 'BUY', '2024-05-01', '100', '250', 'GBX', '5')`)
    db.close()

    const lines: string[] = []
    await expect(runBackfillFx(env, (l) => lines.push(l))).resolves.toEqual({
      updated: 1,
      failed: 0,
    })

    const check = new DatabaseSync(dbPath, { readOnly: true })
    try {
      expect(
        check.prepare('SELECT unit_price_gbp, total_gbp, net_gbp FROM txn WHERE id = 1').get(),
      ).toEqual({
        unit_price_gbp: '2.50000000',
        total_gbp: '250.00000000',
        net_gbp: '-255.00000000',
      })
    } finally {
      check.close()
    }
    await expect(runBackfillFx(env, () => {})).resolves.toEqual({ updated: 0, failed: 0 })
  })

  it('rejects an invalid FX policy', async () => {
    createDb().close()
    await expect(runBackfillFx({ ...env, FX_RATE_POLICY: 'bogus' }, () => {})).rejects.toThrow(
      /FX_RATE_POLICY/,
    )
  })
})

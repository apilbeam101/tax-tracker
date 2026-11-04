import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from './auth/password.ts'
import { createKeySlots } from './crypto/keyslots.ts'
import { initDb } from './db/database.ts'
import { stageRestoreFile } from './services/backup/restore.ts'

// The real buildApp, started over a data directory in which a restore has been staged: the swap
// happens before the database is opened, the restored data starts locked, and the restored
// install's own passphrase opens it.
vi.mock('@fastify/static', () => ({ default: async () => {} }))

const FAST = { kdf: 'argon2id', memoryKiB: 64, timeCost: 1, parallelism: 1 } as const
const ENV_KEYS = ['DATA_DIR', 'DB_PATH', 'AUTO_CONFIG', 'BACKUP_SCHEDULE'] as const

let dir: string
let saved: Record<string, string | undefined>
let app: FastifyInstance | undefined

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  dir = mkdtempSync(join(tmpdir(), 'tt-restore-boot-'))
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.DATA_DIR = dir
  for (const k of ['DB_PATH', 'AUTO_CONFIG', 'BACKUP_SCHEDULE'] as const) delete process.env[k]
  vi.resetModules()
})

afterEach(async () => {
  await app?.close()
  app = undefined
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

async function install(path: string, username: string, passphrase: string) {
  const db = await initDb(path)
  db.prepare('INSERT INTO "user" (tenant_id, username, password_hash) VALUES (1, ?, ?)').run(
    username,
    await hashPassword(passphrase),
  )
  const { dek } = await createKeySlots(db, passphrase, { passphraseKdf: FAST })
  dek.fill(0)
  db.close()
}

describe('starting the app over a staged restore', () => {
  it('swaps the backup in before opening it, starts locked, and unlocks with the backup passphrase', async () => {
    const livePath = join(dir, 'taxtracker.db')
    await install(livePath, 'current', 'current install passphrase')

    const backupPath = join(dir, 'incoming', 'incoming.db')
    await install(backupPath, 'restored', 'restored install passphrase')
    const staged = await stageRestoreFile(livePath, backupPath)
    expect(staged).toMatchObject({ protected: true, sameKeys: false })

    const { default: Fastify } = await import('fastify')
    const { buildApp } = await import('./app.ts')
    app = Fastify()
    await buildApp(app)
    await app.ready()

    expect(app.keyring.state).toBe('locked')
    expect(
      (app.db.prepare('SELECT username FROM "user"').all() as Array<{ username: string }>).map(
        (u) => u.username,
      ),
    ).toEqual(['restored'])

    const status = (await app.inject({ method: 'GET', url: '/api/auth/status' })).json()
    expect(status).toMatchObject({ locked: true, setupRequired: false })

    const csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf' })
    const cookie = String(csrf.headers['set-cookie']).split(';')[0] as string
    const token = (csrf.json() as { csrfToken: string }).csrfToken

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie, 'csrf-token': token },
      payload: { username: 'current', password: 'current install passphrase' },
    })
    expect(wrong.statusCode).toBe(401)
    expect(app.keyring.state).toBe('locked')

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie, 'csrf-token': token },
      payload: { username: 'restored', password: 'restored install passphrase' },
    })
    expect(login.statusCode).toBe(200)
    expect(app.keyring.state).toBe('unlocked')
  }, 30_000)
})

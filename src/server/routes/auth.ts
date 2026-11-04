import { basename, join } from 'node:path'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { requireAuth, type SessionUser } from '../auth/middleware.ts'
import { DUMMY_HASH, hashPassword, verifyPassword } from '../auth/password.ts'
import {
  applySlot,
  hasKeySlots,
  insertInitialSlots,
  prepareInitialSlots,
  preparePassphraseSlot,
  rotateRecoveryKey,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
} from '../crypto/keyslots.ts'
import {
  ALREADY_ENCRYPTED,
  ALREADY_ENCRYPTED_CODE,
  holdsStoredValues,
  keysCreatedAtSetup,
  listPlaintextCopies,
  recordDatabaseCreated,
  recordRecoveryKeyConfirmed,
  recoveryKeyNeedsConfirmation,
  removePreEncryptionBackups,
  upgradeToEncrypted,
} from '../crypto/upgrade.ts'
import { ConflictError, UnauthorizedError } from '../errors.ts'
import { lockedBody, requireLiveSession } from '../lock.ts'

interface LoginBody {
  username: string
  password: string
}
interface SetupBody {
  password: string
  unattended?: boolean
}
interface RecoverBody {
  recoveryKey: string
  newPassphrase: string
}
interface ChangePassphraseBody {
  currentPassword: string
  newPassphrase: string
}

const MIN_PASSPHRASE_LENGTH = 12
// Bounds the work an unauthenticated request can make argon2 do.
const MAX_SECRET_LENGTH = 1024

interface UserRow {
  id: number
  tenant_id: number
  username: string
  password_hash: string
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  function singleUser(): UserRow | undefined {
    return app.db
      .prepare('SELECT id, tenant_id, username, password_hash FROM user ORDER BY id LIMIT 1')
      .get() as UserRow | undefined
  }

  // Starts a session for `row`. Everything after the (only) await is synchronous, so the key,
  // the session and its tracker entry appear together: another session ending in between cannot
  // lock the key out from under this one, and a failure before that point leaves no key unlocked.
  // `dek` (if any) is taken over: it unlocks the keyring or is wiped.
  async function startSession(
    req: FastifyRequest,
    row: UserRow,
    dek: Buffer | null,
  ): Promise<SessionUser> {
    const previousId = req.session.sessionId
    try {
      // Rotate session ID on login to prevent session fixation
      await req.session.regenerate()
    } catch (err) {
      dek?.fill(0)
      throw err
    }
    return activateSession(req, previousId, row, dek)
  }

  // The synchronous half of startSession(), for callers that must regenerate the session before
  // they make the key available.
  function activateSession(
    req: FastifyRequest,
    previousId: string,
    row: UserRow,
    dek: Buffer | null,
  ): SessionUser {
    if (dek) {
      if (app.keyring.isLocked) app.keyring.unlock(dek)
      else dek.fill(0)
    }
    const user = {
      id: row.id,
      tenantId: row.tenant_id,
      username: row.username,
    } satisfies SessionUser
    req.session.user = user
    // Add before releasing the old id so the tracker is never momentarily empty.
    app.sessionTracker.add(req.session.sessionId)
    if (previousId !== req.session.sessionId) app.sessionTracker.release(previousId)
    return user
  }

  // The slot rewrap and the login hash must change together: if only one landed, the typed
  // passphrase would no longer open the data it logs in to.
  function applyPassphraseChange(
    userId: number,
    newHash: string,
    prepared: Awaited<ReturnType<typeof preparePassphraseSlot>> | null,
    action: string,
  ): void {
    app.db.exec('BEGIN')
    try {
      if (prepared) applySlot(app.db, prepared, action)
      app.db.prepare('UPDATE user SET password_hash = ? WHERE id = ?').run(newHash, userId)
      app.db.exec('COMMIT')
    } catch (err) {
      try {
        app.db.exec('ROLLBACK')
      } catch {
        /* ignore secondary rollback failure */
      }
      throw err
    }
  }

  const backupDir = join(app.runtime.dataDir, 'backups')

  function upgradeState(userCount: number): 'none' | 'available' | 'confirm' {
    if (userCount === 0) return 'none'
    if (!app.keyring.isProtected) return 'available'
    return recoveryKeyNeedsConfirmation(app.db) ? 'confirm' : 'none'
  }

  function unlockFailed(reply: FastifyReply) {
    return reply
      .status(423)
      .send(
        lockedBody(
          'UNLOCK_FAILED',
          'Your passphrase was accepted but could not unlock the data. Use your recovery key.',
        ),
      )
  }

  /**
   * GET /api/auth/status
   * Returns whether first-run setup is needed, whether the data is locked, and whether user is
   * logged in.
   */
  app.get('/status', async (req) => {
    const users = userCount()
    const { keyring } = app
    // A session the tracker has dropped (idle, or revoked by a credential change) is not signed in.
    const live = !!req.session.user && app.sessionTracker.touch(req.session.sessionId)
    return {
      setupRequired: users === 0,
      authenticated: live,
      user: live ? (req.session.user ?? null) : null,
      locked: keyring.isLocked,
      unlockMode: !keyring.isProtected ? 'none' : keyring.isPermanent ? 'unattended' : 'passphrase',
      // 'available': the data is not encrypted yet. 'confirm': it was encrypted but the user has
      // not yet proved they hold the recovery key, so the plaintext safety copy still exists.
      upgrade: live ? upgradeState(users) : 'none',
      // Whether the server has an ENCRYPTION_KEY the user could opt into using for automatic
      // unlock when setting up or encrypting.
      unattendedKeyAvailable:
        (live || users === 0) && !keyring.isProtected && Boolean(app.runtime.unattendedKey),
    }
  })

  function userCount(): number {
    return (app.db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n
  }

  /**
   * POST /api/auth/setup
   * First-run only: create the single local user and the key slots for the chosen passphrase, and
   * sign them in. The recovery key in the response is shown once; the client has the user type it
   * back through /upgrade/confirm. Rate-limited: 5 attempts per 15 minutes.
   */
  app.post<{ Body: SetupBody }>(
    '/setup',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          properties: {
            password: {
              type: 'string',
              minLength: MIN_PASSPHRASE_LENGTH,
              maxLength: MAX_SECRET_LENGTH,
            },
            unattended: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      if (userCount() > 0) return reply.status(409).send({ error: 'Setup already completed' })
      if (app.keyring.isProtected) {
        throw new ConflictError('Key slots exist but there is no user; restore the database')
      }
      const unattendedKey = req.body.unattended ? app.runtime.unattendedKey : undefined
      if (req.body.unattended && !unattendedKey) {
        throw new ConflictError('No ENCRYPTION_KEY is configured on the server')
      }

      // A database that already holds values (imported before anyone set up) cannot simply be
      // wrapped in a new key: those values are plaintext. Such a setup only creates the user, and
      // the sign-in then offers the in-app upgrade, which seals what is there.
      const withData = holdsStoredValues(app.db)
      const passwordHash = await hashPassword(req.body.password)
      const prepared = withData
        ? null
        : await prepareInitialSlots(req.body.password, {
            unattendedKey,
            ...(app.runtime.passphraseKdf ? { passphraseKdf: app.runtime.passphraseKdf } : {}),
          })

      const previousId = req.session.sessionId
      try {
        await req.session.regenerate()
      } catch (err) {
        prepared?.dek.fill(0)
        throw err
      }

      let row: UserRow | undefined
      // Synchronous from here to the end of the handler's work: the commit, the keyring switching
      // to encrypting and the session appearing together, so no request can write a plaintext row
      // in between and a lone sweep cannot lock a key that has no session yet.
      try {
        app.db.exec('BEGIN IMMEDIATE')
        try {
          if (userCount() > 0) throw new ConflictError('Setup already completed')
          if (holdsStoredValues(app.db) !== withData) {
            throw new ConflictError('The database changed during setup. Please try again.')
          }
          const inserted = app.db
            .prepare('INSERT INTO user (tenant_id, username, password_hash) VALUES (?, ?, ?)')
            .run(1, 'admin', passwordHash)
          row = {
            id: Number(inserted.lastInsertRowid),
            tenant_id: 1,
            username: 'admin',
            password_hash: passwordHash,
          }
          if (prepared) {
            insertInitialSlots(app.db, prepared.slots)
            recordDatabaseCreated(app.db)
          }
          try {
            app.db.exec('COMMIT')
          } catch (commitError) {
            // An I/O error on COMMIT can still have landed. If it did, carry on as for a success:
            // treating it as a failure would leave stored key slots with a keyring not using them.
            if (!(prepared ? hasKeySlots(app.db) : userCount() > 0)) throw commitError
          }
        } catch (err) {
          try {
            app.db.exec('ROLLBACK')
          } catch {
            /* ignore secondary rollback failure */
          }
          throw err
        }
      } catch (err) {
        prepared?.dek.fill(0)
        throw err
      }
      if (prepared) app.keyring.protect(prepared.dek, { permanent: Boolean(unattendedKey) })
      const user = activateSession(req, previousId, row!, null)

      reply.header('Cache-Control', 'no-store')
      return reply.status(201).send({
        ok: true,
        user,
        recoveryKey: prepared?.recoveryKey ?? null,
        unattended: Boolean(prepared && unattendedKey),
      })
    },
  )

  /**
   * POST /api/auth/login
   * Rate-limited: 10 attempts per 15 minutes to slow brute-force. When the data is locked, the
   * passphrase that proves the login also unlocks it.
   */
  app.post<{ Body: LoginBody }>(
    '/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', maxLength: 255 },
            password: { type: 'string', maxLength: MAX_SECRET_LENGTH },
          },
        },
      },
    },
    async (req, reply) => {
      const { username, password } = req.body
      const row = app.db
        .prepare('SELECT id, tenant_id, username, password_hash FROM user WHERE username = ?')
        .get(username) as UserRow | undefined

      // Always run verifyPassword to prevent username enumeration via timing.
      // When the user doesn't exist, compare against a dummy hash so the
      // argon2id work factor is always paid regardless.
      const valid = (await verifyPassword(row?.password_hash ?? DUMMY_HASH, password)) && !!row

      if (!valid || !row) {
        // Generic error — don't reveal whether the username exists
        return reply.status(401).send({ error: 'Invalid credentials' })
      }

      // Always derive the key when protected, even if another session already holds it: the
      // session start below is then independent of whether that other session survives.
      let dek: Buffer | null = null
      if (app.keyring.isProtected) {
        dek = await unlockWithPassphrase(app.db, password)
        if (!dek) return unlockFailed(reply)
      }

      // Record last login before issuing the session cookie — if this throws
      // the client gets a 500 with no cookie rather than a cookie + 500.
      try {
        app.db.prepare("UPDATE user SET last_login_at = datetime('now') WHERE id = ?").run(row.id)
      } catch (err) {
        dek?.fill(0)
        throw err
      }

      const user = await startSession(req, row, dek)
      return { ok: true, user }
    },
  )

  /**
   * POST /api/auth/recover
   * Forgotten passphrase: the recovery key opens the data and sets a new passphrase, which
   * becomes both the login password and the passphrase slot. Rate-limited like setup.
   */
  app.post<{ Body: RecoverBody }>(
    '/recover',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['recoveryKey', 'newPassphrase'],
          properties: {
            recoveryKey: { type: 'string', maxLength: 200 },
            newPassphrase: {
              type: 'string',
              minLength: MIN_PASSPHRASE_LENGTH,
              maxLength: MAX_SECRET_LENGTH,
            },
          },
        },
      },
    },
    async (req, reply) => {
      if (!app.keyring.isProtected) throw new ConflictError('No recovery key exists yet')
      const row = singleUser()
      if (!row) throw new ConflictError('Setup has not been completed')

      const dek = await unlockWithRecoveryKey(app.db, req.body.recoveryKey)
      if (!dek) return reply.status(401).send({ error: 'Invalid recovery key' })

      try {
        const prepared = await preparePassphraseSlot(dek, req.body.newPassphrase)
        const newHash = await hashPassword(req.body.newPassphrase)
        applyPassphraseChange(row.id, newHash, prepared, 'key_slot.passphrase.reset')
      } catch (err) {
        dek.fill(0)
        throw err
      }

      const user = await startSession(req, row, dek)
      // The old credentials may be compromised: nobody else stays signed in.
      app.sessionTracker.retainOnly(req.session.sessionId)
      return { ok: true, user }
    },
  )

  /**
   * POST /api/auth/change-passphrase
   * Signed-in users only. Rewraps the passphrase slot and updates the login hash together.
   */
  app.post<{ Body: ChangePassphraseBody }>(
    '/change-passphrase',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      preHandler: [requireAuth, requireLiveSession, app.csrfProtection],
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassphrase'],
          properties: {
            currentPassword: { type: 'string', maxLength: MAX_SECRET_LENGTH },
            newPassphrase: {
              type: 'string',
              minLength: MIN_PASSPHRASE_LENGTH,
              maxLength: MAX_SECRET_LENGTH,
            },
          },
        },
      },
    },
    async (req, reply) => {
      if (app.keyring.isLocked) return reply.status(423).send(lockedBody())
      const row = singleUser()
      if (!row || req.session.user?.id !== row.id) throw new UnauthorizedError()
      if (!(await verifyPassword(row.password_hash, req.body.currentPassword))) {
        return reply.status(401).send({ error: 'Current passphrase is incorrect' })
      }

      const newHash = await hashPassword(req.body.newPassphrase)
      if (!app.keyring.isProtected) {
        applyPassphraseChange(row.id, newHash, null, '')
        app.sessionTracker.retainOnly(req.session.sessionId)
        return { ok: true }
      }

      const dek = app.keyring.copyDek()
      try {
        const prepared = await preparePassphraseSlot(dek, req.body.newPassphrase)
        applyPassphraseChange(row.id, newHash, prepared, 'key_slot.passphrase.change')
      } finally {
        dek.fill(0)
      }
      app.sessionTracker.retainOnly(req.session.sessionId)
      return { ok: true }
    },
  )

  const rateLimited = { max: 5, timeWindow: '15 minutes' }
  const signedIn = [requireAuth, requireLiveSession, app.csrfProtection]

  /**
   * POST /api/auth/upgrade
   * Encrypts an existing, unencrypted database. Needs the passphrase again (it becomes the
   * passphrase key slot) and returns the recovery key, which is shown once. A plaintext safety
   * copy is kept until /upgrade/confirm.
   */
  app.post<{ Body: { passphrase: string; unattended?: boolean } }>(
    '/upgrade',
    {
      config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
      preHandler: signedIn,
      schema: {
        body: {
          type: 'object',
          required: ['passphrase'],
          properties: {
            passphrase: { type: 'string', maxLength: MAX_SECRET_LENGTH },
            unattended: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      if (app.keyring.isProtected)
        throw new ConflictError(ALREADY_ENCRYPTED, ALREADY_ENCRYPTED_CODE)
      const row = singleUser()
      if (!row || req.session.user?.id !== row.id) throw new UnauthorizedError()
      if (!(await verifyPassword(row.password_hash, req.body.passphrase))) {
        return reply.status(401).send({ error: 'Passphrase is incorrect' })
      }

      // ENCRYPTION_KEY becomes an automatic-unlock slot only when the user asks for it: it sits
      // in the server's environment next to the data, so it trades protection for convenience.
      const unattendedKey = req.body.unattended ? app.runtime.unattendedKey : undefined
      if (req.body.unattended && !unattendedKey) {
        throw new ConflictError('No ENCRYPTION_KEY is configured on the server')
      }

      const result = await upgradeToEncrypted(app.db, app.keyring, {
        passphrase: req.body.passphrase,
        backupDir,
        unattendedKey,
        // The passphrase was checked against the login hash before the slow preparation; if it
        // was changed in another tab since, the slot would not match what the user can sign in with.
        beforeCommit: () => {
          const current = singleUser()
          if (current?.password_hash !== row.password_hash) {
            throw new ConflictError('Your passphrase changed while encrypting. Please try again.')
          }
        },
        ...(app.runtime.passphraseKdf ? { passphraseKdf: app.runtime.passphraseKdf } : {}),
      })
      // The data key is new, so no session opened before this one is trusted with it.
      app.sessionTracker.retainOnly(req.session.sessionId)
      const safetyCopy = basename(result.backupPath)
      reply.header('Cache-Control', 'no-store')
      return {
        recoveryKey: result.recoveryKey,
        safetyCopy,
        plaintextCopies: listPlaintextCopies(app.runtime.dataDir, backupDir, {
          exceptSafetyCopy: safetyCopy,
        }),
        scrubbed: result.scrubbed,
        unattended: Boolean(unattendedKey),
      }
    },
  )

  /**
   * POST /api/auth/upgrade/confirm
   * The user types the recovery key back. Only then is the plaintext safety copy removed.
   */
  app.post<{ Body: { recoveryKey: string } }>(
    '/upgrade/confirm',
    {
      config: { rateLimit: rateLimited },
      preHandler: signedIn,
      schema: {
        body: {
          type: 'object',
          required: ['recoveryKey'],
          properties: { recoveryKey: { type: 'string', maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      if (!app.keyring.isProtected) throw new ConflictError('This database is not encrypted yet')
      const dek = await unlockWithRecoveryKey(app.db, req.body.recoveryKey)
      if (!dek) return reply.status(401).send({ error: 'That is not your recovery key' })
      dek.fill(0)
      const freshInstall = keysCreatedAtSetup(app.db)
      recordRecoveryKeyConfirmed(app.db)
      return {
        removed: freshInstall ? [] : removePreEncryptionBackups(backupDir),
        plaintextCopies: listPlaintextCopies(app.runtime.dataDir, backupDir),
      }
    },
  )

  /**
   * POST /api/auth/recovery-key/rotate
   * Replaces a lost or never-saved recovery key. The old one stops working immediately.
   */
  app.post<{ Body: { currentPassword: string } }>(
    '/recovery-key/rotate',
    {
      config: { rateLimit: rateLimited },
      preHandler: signedIn,
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword'],
          properties: { currentPassword: { type: 'string', maxLength: MAX_SECRET_LENGTH } },
        },
      },
    },
    async (req, reply) => {
      if (!app.keyring.isProtected) throw new ConflictError('This database is not encrypted yet')
      const row = singleUser()
      if (!row || req.session.user?.id !== row.id) throw new UnauthorizedError()
      if (!(await verifyPassword(row.password_hash, req.body.currentPassword))) {
        return reply.status(401).send({ error: 'Current passphrase is incorrect' })
      }
      reply.header('Cache-Control', 'no-store')
      return { recoveryKey: app.keyring.withDek((dek) => rotateRecoveryKey(app.db, dek)) }
    },
  )

  /**
   * GET /api/auth/csrf
   * Returns a CSRF token bound to the current session.
   * Clients must send this as the `csrf-token` header on state-mutating requests.
   */
  app.get('/csrf', async (_req, reply) => {
    return { csrfToken: reply.generateCsrf() }
  })

  /**
   * POST /api/auth/logout
   * CSRF-protected — requires a valid token from GET /api/auth/csrf. Ending the last live
   * session drops the data key from memory (unless the deployment keeps it unlocked).
   */
  app.post('/logout', { preHandler: app.csrfProtection }, async (req, reply) => {
    const sessionId = req.session.sessionId
    try {
      await req.session.destroy()
    } finally {
      app.sessionTracker.release(sessionId)
    }
    return reply.send({ ok: true })
  })
}

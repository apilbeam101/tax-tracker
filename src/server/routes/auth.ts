import type { FastifyPluginAsync } from 'fastify'
import type { Db } from '../db/database.ts'
import { hashPassword, verifyPassword, DUMMY_HASH } from '../auth/password.ts'
import type { SessionUser } from '../auth/middleware.ts'

interface LoginBody { username: string; password: string }
interface SetupBody  { password: string }

export const authRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/auth/status
   * Returns whether first-run setup is needed and whether user is logged in.
   */
  app.get('/status', async (req) => {
    const userCount = (app.db.prepare('SELECT COUNT(*) AS n FROM user').get() as {n: number}).n
    return {
      setupRequired: userCount === 0,
      authenticated: !!req.session.user,
      user: req.session.user ?? null,
    }
  })

  /**
   * POST /api/auth/setup
   * First-run only: create the single local user with the chosen passphrase.
   * Rate-limited: 5 attempts per 15 minutes.
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
            password: { type: 'string', minLength: 12 },
          },
        },
      },
    },
    async (req, reply) => {
      const existing = (app.db.prepare('SELECT COUNT(*) AS n FROM user').get() as {n: number}).n
      if (existing > 0) {
        return reply.status(409).send({ error: 'Setup already completed' })
      }

      const passwordHash = await hashPassword(req.body.password)
      app.db.prepare(
        'INSERT INTO user (tenant_id, username, password_hash) VALUES (?, ?, ?)'
      ).run(1, 'admin', passwordHash)

      return reply.status(201).send({ ok: true })
    },
  )

  /**
   * POST /api/auth/login
   * Rate-limited: 10 attempts per 15 minutes to slow brute-force.
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
            username: { type: 'string' },
            password: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const { username, password } = req.body
      const row = app.db.prepare(
        'SELECT id, tenant_id, username, password_hash FROM user WHERE username = ?'
      ).get(username) as { id: number; tenant_id: number; username: string; password_hash: string } | undefined

      // Always run verifyPassword to prevent username enumeration via timing.
      // When the user doesn't exist, compare against a dummy hash so the
      // argon2id work factor is always paid regardless.
      const valid = await verifyPassword(row?.password_hash ?? DUMMY_HASH, password) && !!row

      if (!valid || !row) {
        // Generic error — don't reveal whether the username exists
        return reply.status(401).send({ error: 'Invalid credentials' })
      }

      // Record last login before issuing the session cookie — if this throws
      // the client gets a 500 with no cookie rather than a cookie + 500.
      app.db.prepare("UPDATE user SET last_login_at = datetime('now') WHERE id = ?").run(row.id)

      // Rotate session ID on login to prevent session fixation
      await req.session.regenerate()
      req.session.user = {
        id: row.id,
        tenantId: row.tenant_id,
        username: row.username,
      } satisfies SessionUser

      return { ok: true, user: req.session.user }
    },
  )

  /**
   * GET /api/auth/csrf
   * Returns a CSRF token bound to the current session.
   * Clients must send this as the `csrf-token` header on state-mutating requests.
   */
  app.get('/csrf', async (req, reply) => {
    return { csrfToken: reply.generateCsrf() }
  })

  /**
   * POST /api/auth/logout
   * CSRF-protected — requires a valid token from GET /api/auth/csrf.
   */
  app.post('/logout', { preHandler: app.csrfProtection }, async (req, reply) => {
    await req.session.destroy()
    return reply.send({ ok: true })
  })
}

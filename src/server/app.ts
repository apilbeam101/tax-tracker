import { join } from 'node:path'
import fastifyCsrfProtection from '@fastify/csrf-protection'
import fastifyHelmet from '@fastify/helmet'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import { config } from './config/env.ts'
import { packageRoot } from './config/paths.ts'
import { scrubIfPending } from './crypto/upgrade.ts'
import { initDb } from './db/database.ts'
import { errorHandler } from './errors.ts'
import { registerLockState } from './lock.ts'
import { registerRepositories } from './repositories/register.ts'
import { createFxRateStore } from './repositories/sqlite/FxRateStore.ts'
import { createPriceStore } from './repositories/sqlite/PriceStore.ts'
import { apiRoutes } from './routes/api.ts'
import { authRoutes } from './routes/auth.ts'
import { healthRoute } from './routes/health.ts'
import { createFxService } from './services/fx/index.ts'
import { createPriceService } from './services/prices/cache.ts'
import { createTiingoProvider } from './services/prices/tiingo.ts'
import { createYahooProvider } from './services/prices/yahoo.ts'
import { backfillRealisedProjections, recalcAllInstruments } from './services/tax/recalc.ts'
import { backfillAutoWithholding } from './services/tax/withholding.ts'
import { registerSession } from './session.ts'

const CLIENT_DIST = join(packageRoot(), 'dist', 'client')

export async function buildApp(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(errorHandler)

  // ── Security headers ────────────────────────────────────────────────────────
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Svelte scoped styles
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    referrerPolicy: { policy: 'same-origin' },
  })

  // ── Rate limiting ───────────────────────────────────────────────────────────
  await app.register(fastifyRateLimit, {
    global: true,
    max: 200,
    timeWindow: '1 minute',
  })

  // ── Cookies & sessions ──────────────────────────────────────────────────────
  await registerSession(app, { secret: config.sessionSecret, secureCookies: config.secureCookies })

  // ── CSRF protection ─────────────────────────────────────────────────────────
  await app.register(fastifyCsrfProtection, {
    sessionPlugin: '@fastify/session',
  })

  // ── Database ────────────────────────────────────────────────────────────────
  const db = await initDb(config.dbPath)
  app.decorate('db', db)

  app.decorate('runtime', { dataDir: config.dataDir, unattendedKey: config.encryptionKey })

  // ── Lock state ───────────────────────────────────────────────────────────────
  // Created before the stores: they encrypt and decrypt through the keyring.
  const lockState = registerLockState(app, {
    db,
    encryptionKey: config.encryptionKey,
    // These touch decrypted data, so they run at boot when there is nothing to unlock (or an
    // unattended key opens it), and otherwise on the first unlock.
    startupTasks: () => {
      // Retroactively link any Projections entries that predate automatic
      // linking to a matching transaction already on file.
      backfillRealisedProjections(app)

      // Retroactively apply auto-withholding to USD dividend transactions that
      // predate this feature.
      backfillAutoWithholding(app)

      // Rebuild S104 pools and disposal records from the transactions. Repairs
      // pools persisted before the same-day matching order fix, which left
      // same-day-matched shares sitting in the pool.
      recalcAllInstruments(app)
    },
  })

  // ── Repositories & services ──────────────────────────────────────────────────
  const cipher = registerRepositories(app, db)
  const fxRateStore = createFxRateStore(db)
  app.decorate('fx', createFxService(fxRateStore, config.fxRatePolicy))

  const priceStore = createPriceStore(db, cipher)
  const priceProviders = [
    ...(config.tiingoApiKey ? [createTiingoProvider(config.tiingoApiKey)] : []),
    createYahooProvider(),
  ]
  app.decorate('priceService', createPriceService(priceStore, priceProviders))

  await lockState.boot()

  // An upgrade whose clean-up did not finish (disk full, file held open by another program) is
  // retried here, before any request is served, until it completes.
  if (scrubIfPending(db) === false) {
    app.log.warn(
      'Old unencrypted data may still be in free pages of the database file: the clean-up after encryption did not complete and will be retried at the next start.',
    )
  }

  // ── Static files (compiled Svelte SPA) ──────────────────────────────────────
  await app.register(fastifyStatic, {
    root: CLIENT_DIST,
    prefix: '/',
  })

  // SPA fallback — serve index.html for any non-API, non-asset route
  app.setNotFoundHandler(async (req, reply) => {
    if (!req.url.startsWith('/api/') && !req.url.startsWith('/health')) {
      return reply.sendFile('index.html')
    }
    return reply.status(404).send({ error: 'Not found' })
  })

  // ── Routes ───────────────────────────────────────────────────────────────────
  await app.register(healthRoute, { commit: config.gitCommit })
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(apiRoutes, { prefix: '/api' })
}

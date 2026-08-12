import { join } from 'node:path'
import fastifyCookie from '@fastify/cookie'
import fastifyCsrfProtection from '@fastify/csrf-protection'
import fastifyHelmet from '@fastify/helmet'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifySession from '@fastify/session'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import { config } from './config/env.ts'
import { initDb } from './db/database.ts'
import { errorHandler } from './errors.ts'
import { createCgtDisposalStore } from './repositories/sqlite/CgtDisposalStore.ts'
import { createFxRateStore } from './repositories/sqlite/FxRateStore.ts'
import { createInstrumentStore } from './repositories/sqlite/InstrumentStore.ts'
import { createPriceStore } from './repositories/sqlite/PriceStore.ts'
import { createS104PoolStore } from './repositories/sqlite/S104PoolStore.ts'
import { createTransactionStore } from './repositories/sqlite/TransactionStore.ts'
import { apiRoutes } from './routes/api.ts'
import { authRoutes } from './routes/auth.ts'
import { healthRoute } from './routes/health.ts'
import { createFxService } from './services/fx/index.ts'
import { createPriceService } from './services/prices/cache.ts'
import { createTiingoProvider } from './services/prices/tiingo.ts'
import { createYahooProvider } from './services/prices/yahoo.ts'
import { backfillRealisedProjections } from './services/tax/recalc.ts'
import { backfillAutoWithholding } from './services/tax/withholding.ts'

// Resolve client dist relative to the project root (process.cwd()), not the
// source file location — avoids __dirname/import.meta.url resolution issues
// when running via tsx directly vs compiled output.
const CLIENT_DIST = join(process.cwd(), 'dist', 'client')

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
  await app.register(fastifyCookie)
  await app.register(fastifySession, {
    secret: config.sessionSecret,
    cookie: {
      secure: config.isProduction,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000, // 8h idle timeout
    },
    saveUninitialized: false,
  })

  // ── CSRF protection ─────────────────────────────────────────────────────────
  await app.register(fastifyCsrfProtection, {
    sessionPlugin: '@fastify/session',
  })

  // ── Database ────────────────────────────────────────────────────────────────
  const db = await initDb(config.dbPath)
  app.decorate('db', db)

  // ── Repositories & services ──────────────────────────────────────────────────
  const fxRateStore = createFxRateStore(db)
  app.decorate('instruments', createInstrumentStore(db))
  app.decorate('transactions', createTransactionStore(db))
  app.decorate('cgtDisposals', createCgtDisposalStore(db))
  app.decorate('s104Pools', createS104PoolStore(db))
  app.decorate('fx', createFxService(fxRateStore, config.fxRatePolicy))

  // Retroactively link any Projections entries that predate automatic
  // linking to a matching transaction already on file.
  backfillRealisedProjections(app)

  // Retroactively apply auto-withholding to USD dividend transactions that
  // predate this feature.
  backfillAutoWithholding(app)

  const priceStore = createPriceStore(db)
  const priceProviders = [
    ...(config.tiingoApiKey ? [createTiingoProvider(config.tiingoApiKey)] : []),
    createYahooProvider(),
  ]
  app.decorate('priceService', createPriceService(priceStore, priceProviders))

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
  await app.register(healthRoute)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(apiRoutes, { prefix: '/api' })
}

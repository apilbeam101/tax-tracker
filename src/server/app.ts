import type { FastifyInstance } from 'fastify'
import fastifyHelmet from '@fastify/helmet'
import fastifyCookie from '@fastify/cookie'
import fastifySession from '@fastify/session'
import fastifyCsrfProtection from '@fastify/csrf-protection'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { join } from 'path'
import { config } from './config/env.ts'
import { initDb } from './db/database.ts'
import { healthRoute } from './routes/health.ts'
import { authRoutes } from './routes/auth.ts'
import { apiRoutes } from './routes/api.ts'
import { createInstrumentStore } from './repositories/sqlite/InstrumentStore.ts'
import { createTransactionStore } from './repositories/sqlite/TransactionStore.ts'
import { createFxRateStore } from './repositories/sqlite/FxRateStore.ts'
import { createCgtDisposalStore } from './repositories/sqlite/CgtDisposalStore.ts'
import { createS104PoolStore } from './repositories/sqlite/S104PoolStore.ts'
import { createFxService } from './services/fx/index.ts'
import { createPriceStore } from './repositories/sqlite/PriceStore.ts'
import { createTiingoProvider } from './services/prices/tiingo.ts'
import { createYahooProvider } from './services/prices/yahoo.ts'
import { createPriceService } from './services/prices/cache.ts'

// Resolve client dist relative to the project root (process.cwd()), not the
// source file location — avoids __dirname/import.meta.url resolution issues
// when running via tsx directly vs compiled output.
const CLIENT_DIST = join(process.cwd(), 'dist', 'client')

export async function buildApp(app: FastifyInstance): Promise<void> {
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

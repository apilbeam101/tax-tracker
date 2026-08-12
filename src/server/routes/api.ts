import type { FastifyPluginAsync } from 'fastify'
import { requireAuth } from '../auth/middleware.ts'
import { chartRoutes } from './charts.ts'
import { holdingRoutes } from './holdings.ts'
import { importExportRoutes } from './import-export.ts'
import { instrumentRoutes } from './instruments.ts'
import { projectionRoutes } from './projections.ts'
import { taxRoutes } from './tax.ts'
import { transactionRoutes } from './transactions.ts'

/**
 * Parent plugin for all authenticated API routes.
 */
export const apiRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth)
  // Protect all state-mutating methods against CSRF.
  // GET and HEAD are safe (read-only); everything else requires the csrf-token header.
  app.addHook('preHandler', (req, reply, done) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return app.csrfProtection(req, reply, done)
    }
    done()
  })

  app.get('/me', async (req) => {
    return { user: req.session.user }
  })

  await app.register(instrumentRoutes, { prefix: '/instruments' })
  await app.register(transactionRoutes, { prefix: '/transactions' })
  await app.register(taxRoutes, { prefix: '/tax' })
  await app.register(holdingRoutes, { prefix: '/holdings' })
  await app.register(chartRoutes, { prefix: '/charts' })
  await app.register(projectionRoutes, { prefix: '/projections' })
  await app.register(importExportRoutes)
}

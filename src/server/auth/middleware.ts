import type { FastifyRequest, FastifyReply } from 'fastify'

export interface SessionUser {
  id: number
  tenantId: number
  username: string
}

declare module '@fastify/session' {
  interface FastifySessionObject {
    user?: SessionUser
  }
}

/**
 * Fastify preHandler hook — rejects requests without a valid session.
 * Applied to all routes under /api (except /api/auth/*).
 */
export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!req.session.user) {
    return reply.status(401).send({ error: 'Authentication required' })
  }
}

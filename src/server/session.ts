import fastifyCookie from '@fastify/cookie'
import fastifySession from '@fastify/session'
import type { FastifyInstance } from 'fastify'

export interface SessionOptions {
  secret: string
  secureCookies: 'auto' | boolean
}

// 'auto' marks the cookie Secure only when the request arrived over HTTPS
// (honouring X-Forwarded-Proto when trustProxy is set), so plain
// http://localhost keeps working while a TLS-terminating proxy gets Secure cookies.
export async function registerSession(app: FastifyInstance, opts: SessionOptions): Promise<void> {
  await app.register(fastifyCookie)
  await app.register(fastifySession, {
    secret: opts.secret,
    cookie: {
      secure: opts.secureCookies,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000, // 8h idle timeout
    },
    saveUninitialized: false,
  })
}

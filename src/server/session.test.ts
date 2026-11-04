import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerSession } from './session.ts'

const SECRET = 's'.repeat(64)

let app: FastifyInstance

async function build(secureCookies: 'auto' | boolean, trustProxy: boolean): Promise<void> {
  app = Fastify({ trustProxy })
  await registerSession(app, { secret: SECRET, secureCookies })
  app.get('/login', async (req) => {
    req.session.user = { id: 1, tenantId: 1, username: 'admin' }
    return { ok: true }
  })
  await app.ready()
}

async function rawCookie(headers: Record<string, string> = {}): Promise<string | undefined> {
  const res = await app.inject({ method: 'GET', url: '/login', headers })
  const header = res.headers['set-cookie']
  return Array.isArray(header) ? header[0] : header
}

async function setCookie(headers: Record<string, string> = {}): Promise<string> {
  const cookie = await rawCookie(headers)
  expect(cookie).toMatch(/^sessionId=/)
  return cookie as string
}

afterEach(async () => {
  await app.close()
})

describe('session cookie Secure attribute', () => {
  it('auto: omits Secure on plain http so localhost keeps working', async () => {
    await build('auto', true)
    expect(await setCookie()).not.toMatch(/;\s*Secure/i)
  })

  it('auto: sets Secure when a trusted proxy reports https', async () => {
    await build('auto', true)
    expect(await setCookie({ 'x-forwarded-proto': 'https' })).toMatch(/;\s*Secure/i)
  })

  it('auto: ignores X-Forwarded-Proto when no proxy is trusted', async () => {
    await build('auto', false)
    expect(await setCookie({ 'x-forwarded-proto': 'https' })).not.toMatch(/;\s*Secure/i)
  })

  it('true: sets Secure over https via a trusted proxy', async () => {
    await build(true, true)
    expect(await setCookie({ 'x-forwarded-proto': 'https' })).toMatch(/;\s*Secure/i)
  })

  it('true: refuses to issue a cookie over plain http', async () => {
    await build(true, false)
    expect(await rawCookie()).toBeUndefined()
  })

  it('false: never sets Secure', async () => {
    await build(false, true)
    expect(await setCookie({ 'x-forwarded-proto': 'https' })).not.toMatch(/;\s*Secure/i)
  })

  it('keeps HttpOnly and SameSite=Lax', async () => {
    await build('auto', true)
    const cookie = await setCookie()
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
  })
})

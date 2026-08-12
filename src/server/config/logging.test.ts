import { Writable } from 'node:stream'
// pino is a devDependency here purely so this test can construct a real
// logger — Fastify already brings its own pino in production. Keep this
// package's version range matching fastify's declared pino peer range (see
// fastify's package.json "dependencies".pino) so this test's redact behavior
// can't silently diverge from what actually runs in the app.
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { redact } from './logging.ts'

function captureLog(): { logger: pino.Logger; lines: () => unknown[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString())
      cb()
    },
  })
  const logger = pino({ redact }, stream)
  return { logger, lines: () => chunks.map((c) => JSON.parse(c)) }
}

describe('logging redact config', () => {
  it('redacts request cookie and authorization headers', () => {
    const { logger, lines } = captureLog()
    logger.info({ req: { headers: { cookie: 'sid=secret', authorization: 'Bearer topsecret' } } })
    const [line] = lines() as Array<{ req: { headers: Record<string, string> } }>
    expect(line?.req.headers.cookie).toBe('[REDACTED]')
    expect(line?.req.headers.authorization).toBe('[REDACTED]')
  })

  it('redacts set-cookie response headers', () => {
    const { logger, lines } = captureLog()
    logger.info({ res: { headers: { 'set-cookie': 'sid=secret; Path=/' } } })
    const [line] = lines() as Array<{ res: { headers: Record<string, string> } }>
    expect(line?.res.headers['set-cookie']).toBe('[REDACTED]')
  })

  it('redacts one level of nested apiKey/sessionSecret/password fields', () => {
    const { logger, lines } = captureLog()
    logger.info({
      config: { apiKey: 'tiingo-key', sessionSecret: 'shh', password: 'p@ss' },
    })
    const [line] = lines() as Array<{ config: Record<string, string> }>
    expect(line?.config.apiKey).toBe('[REDACTED]')
    expect(line?.config.sessionSecret).toBe('[REDACTED]')
    expect(line?.config.password).toBe('[REDACTED]')
  })

  it('leaves unrelated fields untouched', () => {
    const { logger, lines } = captureLog()
    logger.info({ msg: 'hello', req: { headers: { host: 'example.com' } } })
    const [line] = lines() as Array<{ req: { headers: Record<string, string> } }>
    expect(line?.req.headers.host).toBe('example.com')
  })
})

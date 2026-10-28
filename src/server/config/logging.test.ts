import { Writable } from 'node:stream'
// pino is a devDependency here purely so this test can construct a real
// logger — Fastify already brings its own pino in production. Keep this
// package's version range matching fastify's declared pino peer range (see
// fastify's package.json "dependencies".pino) so this test's redact behavior
// can't silently diverge from what actually runs in the app.
import Fastify from 'fastify'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { loggerOptions, prettyAvailable, redact } from './logging.ts'

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

const KEY_FIELDS = [
  'passphrase',
  'newPassphrase',
  'recoveryKey',
  'dataKey',
  'dek',
  'wrappedDek',
  'password',
  'encryptionKey',
]

describe('logging redact config: key material', () => {
  it.each(KEY_FIELDS)('redacts %s at the top level and one level down', (field) => {
    const { logger, lines } = captureLog()
    logger.info({ [field]: 'LEAK-top', nested: { [field]: 'LEAK-nested' } })
    const raw = JSON.stringify(lines())
    expect(raw).not.toContain('LEAK')
  })

  it('redacts a whole request body, whatever it contains', () => {
    const { logger, lines } = captureLog()
    logger.info({ body: { anything: 'LEAK-a', keys: { deep: 'LEAK-b' } } })
    logger.info({ req: { url: '/api/auth/setup', body: { custom: 'LEAK-c' } } })
    expect(JSON.stringify(lines())).not.toContain('LEAK')
  })

  it('emits no key material when a real Fastify request body is logged', async () => {
    const chunks: string[] = []
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString())
        cb()
      },
    })
    const app = Fastify({ logger: { ...loggerOptions('info', false), stream } })
    app.post('/api/auth/unlock', async (req) => {
      req.log.info({ body: req.body }, 'unlock attempt')
      return { ok: true }
    })
    await app.inject({
      method: 'POST',
      url: '/api/auth/unlock',
      payload: { passphrase: 'LEAK-passphrase', recoveryKey: 'LEAK-recovery' },
    })
    await app.close()

    const raw = chunks.join('')
    expect(raw).toContain('unlock attempt')
    expect(raw).not.toContain('LEAK')
  })
})

describe('loggerOptions', () => {
  it('uses plain JSON logging when pretty output is not wanted', () => {
    const opts = loggerOptions('warn', false)
    expect(opts.transport).toBeUndefined()
    expect(opts.level).toBe('warn')
    expect(opts.redact).toBe(redact)
  })

  it('uses pino-pretty when pretty output is wanted', () => {
    expect(loggerOptions('info', true).transport).toEqual({ target: 'pino-pretty' })
  })
})

describe('prettyAvailable', () => {
  it('is true on a TTY when pino-pretty resolves', () => {
    expect(prettyAvailable(true, () => '/x/pino-pretty')).toBe(true)
  })

  it('is false when stdout is not a TTY, without trying to resolve the module', () => {
    const resolve = vi.fn(() => '/x/pino-pretty')
    expect(prettyAvailable(false, resolve)).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('is false on a TTY when pino-pretty cannot be resolved (production install)', () => {
    expect(
      prettyAvailable(true, () => {
        throw new Error("Cannot find module 'pino-pretty'")
      }),
    ).toBe(false)
  })

  it('resolves the real pino-pretty in this repo', () => {
    expect(prettyAvailable(true)).toBe(true)
  })
})

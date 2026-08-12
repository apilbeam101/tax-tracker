import fastifyRateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import {
  BadRequestError,
  ConflictError,
  errorHandler,
  NotFoundError,
  UnauthorizedError,
} from './errors.ts'

function makeRequest(): FastifyRequest {
  return { log: { warn: vi.fn(), error: vi.fn() } } as unknown as FastifyRequest
}

function makeReply(): FastifyReply & {
  status: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
} {
  const reply = {
    status: vi.fn(),
    send: vi.fn(),
  }
  reply.status.mockReturnValue(reply)
  return reply as unknown as FastifyReply & typeof reply
}

describe('errorHandler', () => {
  it('sends the message and status code for a known HttpError subclass', () => {
    const request = makeRequest()
    const reply = makeReply()
    errorHandler(new NotFoundError('Instrument not found'), request, reply)

    expect(reply.status).toHaveBeenCalledWith(404)
    expect(reply.send).toHaveBeenCalledWith({
      error: 'Instrument not found',
      message: 'Instrument not found',
    })
    expect(request.log.warn).toHaveBeenCalled()
    expect(request.log.error).not.toHaveBeenCalled()
  })

  it.each([
    [new BadRequestError('bad input'), 400, 'bad input'],
    [new UnauthorizedError(), 401, 'Authentication required'],
    [new ConflictError('already exists'), 409, 'already exists'],
  ] as const)('maps %s to status %i', (error, status, message) => {
    const request = makeRequest()
    const reply = makeReply()
    errorHandler(error, request, reply)

    expect(reply.status).toHaveBeenCalledWith(status)
    expect(reply.send).toHaveBeenCalledWith({ error: message, message })
  })

  it('sends the message for a Fastify schema-validation error', () => {
    const request = makeRequest()
    const reply = makeReply()
    const validationError = Object.assign(new Error('body.foo must be a string'), {
      validation: [{ message: 'must be a string' }],
      code: 'FST_ERR_VALIDATION',
      statusCode: 400,
    }) as unknown as FastifyError

    errorHandler(validationError, request, reply)

    expect(reply.status).toHaveBeenCalledWith(400)
    expect(reply.send).toHaveBeenCalledWith({
      error: 'body.foo must be a string',
      message: 'body.foo must be a string',
    })
    expect(request.log.warn).toHaveBeenCalled()
  })

  it('passes through a plugin-set 4xx statusCode for a non-HttpError, non-validation error', () => {
    const request = makeRequest()
    const reply = makeReply()
    const pluginError = Object.assign(new Error('Rate limit exceeded'), {
      statusCode: 429,
      code: 'FST_ERR_RATE_LIMIT',
    }) as unknown as FastifyError

    errorHandler(pluginError, request, reply)

    expect(reply.status).toHaveBeenCalledWith(429)
    expect(reply.send).toHaveBeenCalledWith({
      error: 'Rate limit exceeded',
      message: 'Rate limit exceeded',
    })
    expect(request.log.warn).toHaveBeenCalled()
    expect(request.log.error).not.toHaveBeenCalled()
  })

  it('hides the real message behind a generic 500 for an unrecognized error', () => {
    const request = makeRequest()
    const reply = makeReply()
    const internal = new Error(
      'SQLITE_CONSTRAINT: UNIQUE constraint failed: txn.id',
    ) as FastifyError

    errorHandler(internal, request, reply)

    expect(reply.status).toHaveBeenCalledWith(500)
    expect(reply.send).toHaveBeenCalledWith({
      error: 'Internal server error',
      message: 'Internal server error',
    })
    expect(request.log.error).toHaveBeenCalledWith(internal)
  })
})

// Hand-built request/reply mocks above can't catch a regression where the
// handler forgets to read a real Fastify plugin's own statusCode — a mock
// never disagrees with the code under test. These hit a live instance instead.
describe('errorHandler wired into a live Fastify instance', () => {
  it('passes through a plugin-generated 4xx statusCode (rate limit) instead of collapsing it to 500', async () => {
    const app = Fastify()
    app.setErrorHandler(errorHandler)
    await app.register(fastifyRateLimit, { global: true, max: 1, timeWindow: '1 minute' })
    app.get('/ping', async () => ({ ok: true }))
    await app.ready()

    await app.inject({ method: 'GET', path: '/ping' })
    const res = await app.inject({ method: 'GET', path: '/ping' })

    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body).error).toMatch(/rate limit/i)
    await app.close()
  })

  it('still returns a generic 500 for an unclassified thrown error', async () => {
    const app = Fastify()
    app.setErrorHandler(errorHandler)
    app.get('/boom', async () => {
      throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: txn.id')
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', path: '/boom' })

    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body)).toEqual({
      error: 'Internal server error',
      message: 'Internal server error',
    })
    await app.close()
  })

  it('returns the right status/message for a thrown HttpError subclass', async () => {
    const app = Fastify()
    app.setErrorHandler(errorHandler)
    app.get('/missing', async () => {
      throw new NotFoundError('Instrument not found')
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', path: '/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({
      error: 'Instrument not found',
      message: 'Instrument not found',
    })
    await app.close()
  })
})

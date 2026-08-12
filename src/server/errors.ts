import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'

/** Base for errors whose message is safe to send to the client as-is. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = this.constructor.name
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, message)
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Authentication required') {
    super(401, message)
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Not found') {
    super(404, message)
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message)
  }
}

// Both `error` and `message` carry the same string: existing routes/client
// code was already inconsistent about which key it reads (some client code
// reads response.message, some reads response.error), and this handler
// shouldn't have to know which.
function sendError(reply: FastifyReply, statusCode: number, message: string): void {
  reply.status(statusCode).send({ error: message, message })
}

/**
 * Global Fastify error handler. Three kinds of error carry a message that's
 * safe to show a client: known HttpError subclasses, Fastify's own
 * schema-validation errors, and plugin-generated errors that set their own
 * 4xx statusCode (rate-limit, CSRF, body-parser, unsupported media type, ...)
 * — those plugins choose that statusCode specifically so it reaches the
 * client. Anything else is a bug or an unexpected internal failure — log the
 * real error server-side, but never echo its message back, since it can
 * contain DB/internal detail (e.g. a SQLite constraint message).
 */
export function errorHandler(
  error: FastifyError | HttpError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof HttpError) {
    request.log.warn({ err: error }, error.message)
    sendError(reply, error.statusCode, error.message)
    return
  }

  if (error.validation) {
    request.log.warn({ err: error }, 'validation error')
    sendError(reply, error.statusCode ?? 400, error.message)
    return
  }

  if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
    request.log.warn({ err: error }, error.message)
    sendError(reply, error.statusCode, error.message)
    return
  }

  request.log.error(error)
  sendError(reply, 500, 'Internal server error')
}

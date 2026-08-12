import type { LoggerOptions, redactOptions } from 'pino'

// Anything logged with one of these shapes gets scrubbed before it hits stdout —
// a boundary property, not something every call site has to remember to do itself.
export const redact: redactOptions = {
  paths: [
    'req.headers.cookie',
    'req.headers.authorization',
    'req.headers["x-api-key"]',
    'res.headers["set-cookie"]',
    '*.sessionSecret',
    '*.encryptionKey',
    '*.apiKey',
    '*.password',
  ],
  censor: '[REDACTED]',
}

export function loggerOptions(isProduction: boolean): LoggerOptions {
  return isProduction
    ? { level: 'warn', redact }
    : { level: 'info', redact, transport: { target: 'pino-pretty' } }
}

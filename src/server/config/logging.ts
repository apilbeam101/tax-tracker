import { createRequire } from 'node:module'
import type { LoggerOptions, redactOptions } from 'pino'

const SECRET_FIELDS = [
  'sessionSecret',
  'encryptionKey',
  'apiKey',
  'password',
  'currentPassword',
  'passphrase',
  'newPassphrase',
  'recoveryKey',
  'dataKey',
  'dek',
  'wrappedDek',
]

// Anything logged with one of these shapes gets scrubbed before it hits stdout —
// a boundary property, not something every call site has to remember to do itself.
export const redact: redactOptions = {
  paths: [
    'req.headers.cookie',
    'req.headers.authorization',
    'req.headers["x-api-key"]',
    'res.headers["set-cookie"]',
    'body',
    '*.body',
    ...SECRET_FIELDS,
    ...SECRET_FIELDS.map((f) => `*.${f}`),
  ],
  censor: '[REDACTED]',
}

const require = createRequire(import.meta.url)

export function prettyAvailable(
  isTTY: boolean | undefined = process.stdout.isTTY,
  resolve: (id: string) => string = (id) => require.resolve(id),
): boolean {
  if (!isTTY) return false
  try {
    resolve('pino-pretty')
    return true
  } catch {
    return false
  }
}

// pino-pretty is an optional dependency; fall back to JSON when it is absent or when
// output is piped, so a production install never crashes on a missing module.
export function loggerOptions(level: string, pretty: boolean = prettyAvailable()): LoggerOptions {
  return pretty ? { level, redact, transport: { target: 'pino-pretty' } } : { level, redact }
}

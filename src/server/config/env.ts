/**
 * Typed, validated environment configuration.
 * All process.env access flows through here — never scattered across the codebase.
 */

import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { resolveDataPaths } from './paths.ts'
import { readSecret, validateStrongSecret } from './secrets.ts'

const FX_RATE_POLICIES = ['hmrc-monthly', 'daily-spot'] as const
type FxRatePolicy = (typeof FX_RATE_POLICIES)[number]

const SECURE_COOKIE_MODES = ['auto', 'true', 'false'] as const
type SecureCookies = 'auto' | boolean

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

function isFxRatePolicy(v: string): v is FxRatePolicy {
  return (FX_RATE_POLICIES as readonly string[]).includes(v)
}

function validatePort(raw: string, errors: string[]): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    errors.push(`PORT must be an integer between 1 and 65535, got: ${raw}`)
    return 3000
  }
  return n
}

function parseSecureCookies(raw: string, errors: string[]): SecureCookies {
  if (!(SECURE_COOKIE_MODES as readonly string[]).includes(raw)) {
    errors.push(`SECURE_COOKIES must be one of ${SECURE_COOKIE_MODES.join(', ')}, got: ${raw}`)
    return 'auto'
  }
  return raw === 'auto' ? 'auto' : raw === 'true'
}

const TRUST_PROXY_KEYWORDS = ['loopback', 'linklocal', 'uniquelocal']

function isTrustProxyEntry(entry: string): boolean {
  if (TRUST_PROXY_KEYWORDS.includes(entry)) return true
  const [addr = '', prefix, ...rest] = entry.split('/')
  const family = isIP(addr)
  if (family === 0 || rest.length > 0) return false
  if (prefix === undefined) return true
  return /^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)
}

// A numeric hop count is deliberately unsupported: Fastify's typings omit it
// and at runtime it trusts no proxy at all, which would silently defeat 'auto'.
function parseTrustProxy(raw: string | undefined, errors: string[]): boolean | string {
  if (!raw || raw === 'false') return false
  if (raw === 'true') return true
  const entries = raw.split(',').map((e) => e.trim())
  if (!entries.every(isTrustProxyEntry)) {
    errors.push(
      `TRUST_PROXY must be true, false, or a comma-separated list of IPs, CIDRs or ${TRUST_PROXY_KEYWORDS.join('/')}, got: ${raw}`,
    )
    return false
  }
  return raw
}

// Collects every problem before throwing, rather than failing on the first
// missing/invalid var — a misconfigured deployment should see the full list
// in one shot, not fix-and-restart repeatedly to find the next issue.
export function buildConfig(env: NodeJS.ProcessEnv = process.env) {
  const errors: string[] = []

  const host = env.HOST ?? '127.0.0.1'
  const port = validatePort(env.PORT ?? '3000', errors)
  const {
    dbPath,
    dataDir,
    source: dataDirSource,
  } = resolveDataPaths({ env, cwd: process.cwd(), platform: process.platform, home: homedir() })

  const errorsBefore = errors.length
  const sessionSecret = readSecret('SESSION_SECRET', env, errors)
  if (sessionSecret) validateStrongSecret('SESSION_SECRET', sessionSecret, errors)
  else if (errors.length === errorsBefore) {
    errors.push('Missing required environment variable: SESSION_SECRET')
  }

  const encryptionKeyRaw = readSecret('ENCRYPTION_KEY', env, errors)
  const encryptionKey = encryptionKeyRaw || undefined
  if (encryptionKey) validateStrongSecret('ENCRYPTION_KEY', encryptionKey, errors)

  const tiingoApiKey = readSecret('TIINGO_API_KEY', env, errors)
  const alphaVantageApiKey = readSecret('ALPHA_VANTAGE_API_KEY', env, errors)

  const fxRatePolicyRaw = env.FX_RATE_POLICY ?? 'hmrc-monthly'
  if (!isFxRatePolicy(fxRatePolicyRaw)) {
    errors.push(
      `FX_RATE_POLICY must be one of ${FX_RATE_POLICIES.join(', ')}, got: ${fxRatePolicyRaw}`,
    )
  }
  const fxRatePolicy: FxRatePolicy = isFxRatePolicy(fxRatePolicyRaw)
    ? fxRatePolicyRaw
    : 'hmrc-monthly'

  const secureCookies = parseSecureCookies(env.SECURE_COOKIES || 'auto', errors)
  const trustProxy = parseTrustProxy(env.TRUST_PROXY, errors)

  const logLevelRaw = env.LOG_LEVEL || 'info'
  if (!(LOG_LEVELS as readonly string[]).includes(logLevelRaw)) {
    errors.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got: ${logLevelRaw}`)
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`)
  }

  return {
    host,
    port,
    dbPath,
    dataDir,
    dataDirSource,
    sessionSecret,
    encryptionKey,
    tiingoApiKey,
    alphaVantageApiKey,
    fxRatePolicy,
    secureCookies,
    trustProxy,
    logLevel: logLevelRaw,
    gitCommit: env.GIT_COMMIT || 'unknown',
  }
}

export const config = buildConfig()

export type Config = typeof config

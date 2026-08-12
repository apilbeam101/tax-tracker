/**
 * Typed, validated environment configuration.
 * All process.env access flows through here — never scattered across the codebase.
 */

const FX_RATE_POLICIES = ['hmrc-monthly', 'daily-spot'] as const
type FxRatePolicy = (typeof FX_RATE_POLICIES)[number]

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

// Collects every problem before throwing, rather than failing on the first
// missing/invalid var — a misconfigured deployment should see the full list
// in one shot, not fix-and-restart repeatedly to find the next issue.
export function buildConfig() {
  const errors: string[] = []

  const host = process.env.HOST ?? '127.0.0.1'
  const port = validatePort(process.env.PORT ?? '3000', errors)
  const dbPath = process.env.DB_PATH ?? './data/taxtracker.db'

  const sessionSecret = process.env.SESSION_SECRET
  if (!sessionSecret) errors.push('Missing required environment variable: SESSION_SECRET')

  const encryptionKey = process.env.ENCRYPTION_KEY
  if (!encryptionKey) errors.push('Missing required environment variable: ENCRYPTION_KEY')

  const tiingoApiKey = process.env.TIINGO_API_KEY ?? ''
  const alphaVantageApiKey = process.env.ALPHA_VANTAGE_API_KEY ?? ''

  const fxRatePolicyRaw = process.env.FX_RATE_POLICY ?? 'hmrc-monthly'
  if (!isFxRatePolicy(fxRatePolicyRaw)) {
    errors.push(
      `FX_RATE_POLICY must be one of ${FX_RATE_POLICIES.join(', ')}, got: ${fxRatePolicyRaw}`,
    )
  }
  const fxRatePolicy: FxRatePolicy = isFxRatePolicy(fxRatePolicyRaw)
    ? fxRatePolicyRaw
    : 'hmrc-monthly'

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`)
  }

  return {
    host,
    port,
    dbPath,
    sessionSecret: sessionSecret as string,
    encryptionKey: encryptionKey as string,
    tiingoApiKey,
    alphaVantageApiKey,
    fxRatePolicy,
    isProduction: process.env.NODE_ENV === 'production',
  }
}

export const config = buildConfig()

export type Config = typeof config

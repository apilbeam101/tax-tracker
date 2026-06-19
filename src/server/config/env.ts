/**
 * Typed, validated environment configuration.
 * All process.env access flows through here — never scattered across the codebase.
 */

function requireEnv(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`Missing required environment variable: ${key}`)
  return v
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

export const config = {
  host: optional('HOST', '127.0.0.1'),
  port: parseInt(optional('PORT', '3000'), 10),
  dbPath: optional('DB_PATH', './data/taxtracker.db'),
  sessionSecret: requireEnv('SESSION_SECRET'),
  encryptionKey: requireEnv('ENCRYPTION_KEY'),
  tiingoApiKey: optional('TIINGO_API_KEY', ''),
  alphaVantageApiKey: optional('ALPHA_VANTAGE_API_KEY', ''),
  fxRatePolicy: optional('FX_RATE_POLICY', 'hmrc-monthly') as 'hmrc-monthly' | 'daily-spot',
  isProduction: process.env['NODE_ENV'] === 'production',
} as const

export type Config = typeof config

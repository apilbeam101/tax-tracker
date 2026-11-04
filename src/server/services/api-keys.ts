import type { AppSecretStore } from '../repositories/index.ts'

export const API_KEY_NAMES = ['TIINGO_API_KEY', 'ALPHA_VANTAGE_API_KEY'] as const
export type ApiKeyName = (typeof API_KEY_NAMES)[number]

// 'env': supplied by the deployment (read-only in the UI); 'stored': entered in the UI and held
// in the encrypted app_secret table.
export type ApiKeySource = 'env' | 'stored' | 'unset'

export interface ApiKeys {
  get(name: ApiKeyName): string | undefined
  source(name: ApiKeyName): ApiKeySource
}

export interface ApiKeyDeps {
  fromEnv: Partial<Record<ApiKeyName, string | undefined>>
  store: AppSecretStore
  tenantId: number
  isLocked: () => boolean
}

// The environment always wins, so a deployment can pin its keys. A stored key is only readable
// while the data is unlocked; until then it simply counts as absent.
export function createApiKeys({ fromEnv, store, tenantId, isLocked }: ApiKeyDeps): ApiKeys {
  const stored = (name: ApiKeyName) => (isLocked() ? undefined : store.get(tenantId, name))
  return {
    get: (name) => fromEnv[name] || stored(name),
    source: (name) => (fromEnv[name] ? 'env' : stored(name) ? 'stored' : 'unset'),
  }
}

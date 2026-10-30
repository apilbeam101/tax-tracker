import type { Argon2idParams } from '../crypto/kdf.ts'
import type { Keyring } from '../crypto/keyring.ts'
import type { SessionTracker } from '../crypto/session-tracker.ts'
import type { Db } from '../db/database.ts'
import type {
  AppSecretStore,
  InstrumentStore,
  TransactionStore,
  VestScheduleStore,
} from '../repositories/index.ts'
import type { CgtDisposalStore } from '../repositories/sqlite/CgtDisposalStore.ts'
import type { S104PoolStore } from '../repositories/sqlite/S104PoolStore.ts'
import type { FxService } from '../services/fx/index.ts'
import type { PriceService } from '../services/prices/cache.ts'

// Deployment facts the routes need that are not part of any store.
export interface RuntimeSettings {
  dataDir: string
  /** ENCRYPTION_KEY, if the deployment supplies one; it becomes the unattended key slot. */
  unattendedKey?: string | undefined
  /** Tests lower the passphrase KDF cost; production leaves it unset. */
  passphraseKdf?: Argon2idParams | undefined
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db
    keyring: Keyring
    sessionTracker: SessionTracker
    runtime: RuntimeSettings
    instruments: InstrumentStore
    transactions: TransactionStore
    cgtDisposals: CgtDisposalStore
    s104Pools: S104PoolStore
    vestSchedules: VestScheduleStore
    appSecrets: AppSecretStore
    fx: FxService
    priceService: PriceService
  }
}

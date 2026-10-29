import type { FastifyInstance } from 'fastify'
import { createFieldCipher, type FieldCipher } from '../crypto/fields.ts'
import type { Db } from '../db/database.ts'
import { createAppSecretStore } from './sqlite/AppSecretStore.ts'
import { createCgtDisposalStore } from './sqlite/CgtDisposalStore.ts'
import { createInstrumentStore } from './sqlite/InstrumentStore.ts'
import { createS104PoolStore } from './sqlite/S104PoolStore.ts'
import { createTransactionStore } from './sqlite/TransactionStore.ts'
import { createVestScheduleStore } from './sqlite/VestScheduleStore.ts'

// Decorates the app with every store that holds encrypted columns. They all encrypt through the
// keyring, so it must already be registered (see registerLockState). Shared by buildApp() and the
// tests, so the order that matters is tested where it is defined.
export function registerRepositories(app: FastifyInstance, db: Db): FieldCipher {
  const cipher = createFieldCipher(app.keyring)
  app.decorate('instruments', createInstrumentStore(db, cipher))
  app.decorate('transactions', createTransactionStore(db, cipher))
  app.decorate('cgtDisposals', createCgtDisposalStore(db, cipher))
  app.decorate('s104Pools', createS104PoolStore(db, cipher))
  app.decorate('vestSchedules', createVestScheduleStore(db, cipher))
  app.decorate('appSecrets', createAppSecretStore(db, cipher))
  return cipher
}

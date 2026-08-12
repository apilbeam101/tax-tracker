import type { Db } from '../db/database.ts'
import type { InstrumentStore, TransactionStore } from '../repositories/index.ts'
import type { CgtDisposalStore } from '../repositories/sqlite/CgtDisposalStore.ts'
import type { S104PoolStore } from '../repositories/sqlite/S104PoolStore.ts'
import type { FxService } from '../services/fx/index.ts'
import type { PriceService } from '../services/prices/cache.ts'

declare module 'fastify' {
  interface FastifyInstance {
    db: Db
    instruments: InstrumentStore
    transactions: TransactionStore
    cgtDisposals: CgtDisposalStore
    s104Pools: S104PoolStore
    fx: FxService
    priceService: PriceService
  }
}

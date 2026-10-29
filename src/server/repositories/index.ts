import type {
  CreateInstrumentBody,
  CreateTransactionBody,
  FxRate,
  FxRateType,
  Instrument,
  Price,
  Transaction,
  UpdateInstrumentBody,
  UpdateTransactionBody,
} from '../../shared/types.ts'

export type { CgtDisposalStore } from './sqlite/CgtDisposalStore.ts'
export type { S104PoolStore } from './sqlite/S104PoolStore.ts'

export interface InstrumentStore {
  list(tenantId: number): Instrument[]
  getById(tenantId: number, id: number): Instrument | undefined
  getByTicker(tenantId: number, ticker: string): Instrument | undefined
  create(tenantId: number, body: CreateInstrumentBody, userId: number): Instrument
  update(
    tenantId: number,
    id: number,
    body: UpdateInstrumentBody,
    userId: number,
  ): Instrument | undefined
  delete(tenantId: number, id: number, userId: number): boolean
}

export interface TransactionStore {
  list(
    tenantId: number,
    opts?: { instrumentId?: number; from?: string; to?: string },
  ): Transaction[]
  getById(tenantId: number, id: number): Transaction | undefined
  create(tenantId: number, body: CreateTransactionBody, userId: number): Transaction
  update(
    tenantId: number,
    id: number,
    body: UpdateTransactionBody,
    userId: number,
  ): Transaction | undefined
  delete(tenantId: number, id: number, userId: number): boolean
}

export interface FxRateStore {
  get(
    fromCurrency: string,
    toCurrency: string,
    rateDate: string,
    rateType: FxRateType,
  ): FxRate | undefined
  upsert(rate: Omit<FxRate, 'id' | 'fetchedAt'>): FxRate
  listForMonth(fromCurrency: string, toCurrency: string, year: number, month: number): FxRate[]
}

export interface PriceStore {
  get(instrumentId: number, priceDate: string): Price | undefined
  getLatest(instrumentId: number): Price | undefined
  /** Earliest cached price date for the instrument, or null if none. */
  earliestDate(instrumentId: number): string | null
  /** Cached prices with from <= date <= to, oldest first. */
  listRange(instrumentId: number, from: string, to: string): Price[]
  upsert(price: Omit<Price, 'id' | 'fetchedAt'>): Price
}

export interface VestSchedule {
  id: number
  tenantId: number
  instrumentId: number
  scheduleType: string
  scheduledDate: string
  quantity: string
  expectedPriceUsd: string | null
  expectedDiscountPriceNative: string | null
  notes: string | null
  realisedTxnId: number | null
  createdAt: string
}

export interface CreateVestScheduleBody {
  instrumentId: number
  scheduleType: string
  scheduledDate: string
  quantity: string
  expectedPriceUsd?: string | null
  expectedDiscountPriceNative?: string | null
  notes?: string | null
}

export interface VestScheduleStore {
  list(
    tenantId: number,
    opts?: {
      instrumentId?: number
      scheduleType?: string
      from?: string
      to?: string
      /** Only entries not yet matched to a real transaction. */
      unrealisedOnly?: boolean
    },
  ): VestSchedule[]
  /** Every tenant's unrealised entries, oldest first (startup reconciliation). */
  listAllUnrealised(): VestSchedule[]
  create(tenantId: number, body: CreateVestScheduleBody): VestSchedule
  delete(tenantId: number, id: number): boolean
  setRealisedTxn(tenantId: number, id: number, txnId: number): void
  /** Unlink any entry currently marked as realised by this transaction. */
  clearRealisedTxn(tenantId: number, txnId: number): void
  /** Ids of transactions already linked from some entry. */
  linkedTxnIds(tenantId: number): Set<number>
}

export interface AppSecretStore {
  get(tenantId: number, name: string): string | undefined
  set(tenantId: number, name: string, value: string): void
  delete(tenantId: number, name: string): boolean
  names(tenantId: number): string[]
}

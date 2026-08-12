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
  upsert(price: Omit<Price, 'id' | 'fetchedAt'>): Price
}

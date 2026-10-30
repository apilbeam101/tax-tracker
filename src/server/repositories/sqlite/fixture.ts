import type { DatabaseSync } from 'node:sqlite'
import type { FieldCipher } from '../../crypto/fields.ts'
import { runTaxEngineForInstrument } from '../../services/tax/engine.ts'
import { createAppSecretStore } from './AppSecretStore.ts'
import { createCgtDisposalStore } from './CgtDisposalStore.ts'
import { createInstrumentStore } from './InstrumentStore.ts'
import { createPriceStore } from './PriceStore.ts'
import { createS104PoolStore } from './S104PoolStore.ts'
import { createTransactionStore } from './TransactionStore.ts'
import { createVestScheduleStore } from './VestScheduleStore.ts'

// Test support: a small portfolio loaded through the stores, with fictional identifiers and
// figures that are distinctive enough to search raw database bytes for.
export const TICKER = 'ZQXTECH'
export const ISIN = 'XX0123456789'
export const NAME = 'Zebra Quartz Holdings'
export const NOTE = 'confidential-note-marker'
export const QUANTITIES = ['1234.5678', '777.125', '420.0001']
export const PRICES = ['91.337', '88.2211']
export const MARKERS = [TICKER, ISIN, NAME, NOTE, ...QUANTITIES, ...PRICES, '123.456789']

export interface Stores {
  db: DatabaseSync
  cipher: FieldCipher
  instruments: ReturnType<typeof createInstrumentStore>
  transactions: ReturnType<typeof createTransactionStore>
  cgtDisposals: ReturnType<typeof createCgtDisposalStore>
  s104Pools: ReturnType<typeof createS104PoolStore>
  prices: ReturnType<typeof createPriceStore>
  vestSchedules: ReturnType<typeof createVestScheduleStore>
  appSecrets: ReturnType<typeof createAppSecretStore>
}

export function storesOn(db: DatabaseSync, cipher: FieldCipher): Stores {
  return {
    db,
    cipher,
    instruments: createInstrumentStore(db, cipher),
    transactions: createTransactionStore(db, cipher),
    cgtDisposals: createCgtDisposalStore(db, cipher),
    s104Pools: createS104PoolStore(db, cipher),
    prices: createPriceStore(db, cipher),
    vestSchedules: createVestScheduleStore(db, cipher),
    appSecrets: createAppSecretStore(db, cipher),
  }
}

// The same fixture goes through whichever stores it is given. Every figure here is invented.
export function loadFixture(s: Stores): { instrumentId: number; otherInstrumentId: number } {
  const instrument = s.instruments.create(
    1,
    {
      ticker: TICKER,
      isin: ISIN,
      name: NAME,
      currency: 'USD',
      exchange: 'NASDAQ',
      isEmployerStock: true,
      rsuWithholdingMethod: 'sell-to-cover',
      notes: NOTE,
    },
    1,
  )
  const other = s.instruments.create(1, { ticker: 'ABCD', name: 'Alpha Beta', currency: 'GBP' }, 1)

  const add = (
    txnType: 'BUY' | 'SELL' | 'DIV_PAY',
    txnDate: string,
    quantity: string,
    price: string,
    extra: Record<string, string> = {},
  ) => {
    const txn = s.transactions.create(
      1,
      {
        instrumentId: instrument.id,
        txnType,
        txnDate,
        quantity,
        unitPriceNative: price,
        nativeCurrency: 'USD',
        fxRate: '0.8',
        fxRateType: 'hmrc-monthly',
        notes: NOTE,
        ...extra,
      },
      1,
    )
    const gbp = (Number(price) * 0.8).toFixed(8)
    return s.transactions.update(
      1,
      txn.id,
      {
        unitPriceGbp: gbp,
        totalGbp: (Number(quantity) * Number(gbp)).toFixed(8),
        netGbp: (Number(quantity) * Number(gbp)).toFixed(8),
        fxRateSource: 'trade-tariff.service.gov.uk',
      },
      1,
    )!
  }

  add('BUY', '2024-05-01', QUANTITIES[0] as string, PRICES[0] as string)
  add('BUY', '2024-09-10', QUANTITIES[1] as string, PRICES[1] as string)
  add('SELL', '2025-01-15', QUANTITIES[2] as string, '105.5', { costsGbp: '12.5' })
  add('DIV_PAY', '2025-02-01', '100', '0.52', { dividendGrossGbp: '41.6' })

  s.prices.upsert({
    instrumentId: instrument.id,
    priceDate: '2025-03-03',
    closePrice: '123.456789',
    source: 'tiingo',
  })
  s.vestSchedules.create(1, {
    instrumentId: instrument.id,
    scheduleType: 'rsu-vest',
    scheduledDate: '2025-06-01',
    quantity: '555.5',
    expectedPriceUsd: '99.9',
    expectedDiscountPriceNative: '77.7',
    notes: NOTE,
  })

  // One transaction of each remaining kind, on the second instrument, so that every encrypted
  // txn column ends up holding a value. The tax engine is not run for them.
  const rich = (
    txnType: 'RSU_VEST' | 'ESPP_PURCHASE' | 'DIV_PAY' | 'SPLIT' | 'CAPRETURN',
    txnDate: string,
    extra: Record<string, string>,
  ) =>
    s.transactions.create(
      1,
      {
        instrumentId: other.id,
        txnType,
        txnDate,
        quantity: '10',
        unitPriceNative: '1.5',
        nativeCurrency: 'GBP',
        fxRate: '1',
        fxRateType: 'manual',
        costsGbp: '1',
        ...extra,
      },
      1,
    )
  rich('RSU_VEST', '2024-06-01', {
    rsuGrossSharesVested: '20',
    rsuSharesWithheld: '10',
    rsuWithholdingRate: '0.47',
    rsuWithholdingMethod: 'net-settlement',
    incomeAmountGbp: '30',
  })
  const espp = rich('ESPP_PURCHASE', '2024-07-01', { esppDiscountPriceNative: '1.2' })
  s.transactions.update(1, espp.id, { esppDiscountPriceGbp: '1.2' }, 1)
  rich('DIV_PAY', '2024-08-01', {
    dividendGrossGbp: '10',
    dividendWithholdingGbp: '1.5',
    dividendNetGbp: '8.5',
  })
  rich('SPLIT', '2024-09-01', { splitRatio: '2/1' })
  rich('CAPRETURN', '2024-10-01', { capreturnsPerShareGbp: '0.1' })

  runTaxEngineForInstrument(1, instrument.id, s.transactions, s.cgtDisposals, s.s104Pools)
  return { instrumentId: instrument.id, otherInstrumentId: other.id }
}

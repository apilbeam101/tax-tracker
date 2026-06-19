// ── Enums ────────────────────────────────────────────────────────────────────

export type TransactionType =
  | 'BUY'
  | 'SELL'
  | 'DIV_PAY'         // cash dividend payment (taxable income)
  | 'DRIP'            // dividend reinvestment — shares acquired at market price
  | 'RSU_VEST'
  | 'ESPP_PURCHASE'
  | 'SPLIT'
  | 'UNSPLIT'
  | 'CAPRETURN'
  | 'RIGHTS_ISSUE'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'

export type InstrumentType = 'equity' | 'fund' | 'etf' | 'reit'
export type RsuWithholdingMethod = 'net-settlement' | 'sell-to-cover' | 'cash'
export type FxRateType = 'hmrc-monthly' | 'daily-spot' | 'manual'
export type MatchType = 'same-day' | '30-day' | 's104-pool'

// ── Domain types ──────────────────────────────────────────────────────────────

export interface Instrument {
  id: number
  tenantId: number
  ticker: string
  isin: string | null
  name: string
  currency: string
  exchange: string | null
  instrumentType: InstrumentType
  isEmployerStock: boolean
  rsuWithholdingMethod: RsuWithholdingMethod
  notes: string | null
  createdAt: string
}

export interface FxRate {
  id: number
  fromCurrency: string
  toCurrency: string
  rateDate: string
  rate: string
  rateType: FxRateType
  source: string
  fetchedAt: string
}

export interface Price {
  id: number
  instrumentId: number
  priceDate: string
  closePrice: string
  source: string
  fetchedAt: string
}

export interface Transaction {
  id: number
  tenantId: number
  instrumentId: number
  txnType: TransactionType
  txnDate: string
  quantity: string
  unitPriceNative: string | null
  nativeCurrency: string | null
  fxRate: string | null
  fxRateType: FxRateType | null
  fxRateSource: string | null
  unitPriceGbp: string | null
  totalGbp: string | null
  costsGbp: string
  netGbp: string | null
  incomeAmountGbp: string | null
  esppDiscountPriceNative: string | null
  esppDiscountPriceGbp: string | null
  rsuGrossSharesVested: string | null
  rsuSharesWithheld: string | null
  rsuWithholdingRate: string | null
  rsuWithholdingMethod: RsuWithholdingMethod | null
  dividendGrossGbp: string | null
  dividendWithholdingGbp: string | null
  dividendNetGbp: string | null
  splitRatio: string | null
  capreturnsPerShareGbp: string | null
  notes: string | null
  importSource: string | null
  createdAt: string
  updatedAt: string
}

export interface TaxYearConfig {
  taxYear: string
  startDate: string
  endDate: string
  cgtAnnualExempt: string
  cgtBasicRate: string
  cgtHigherRate: string
  cgtBasicRatePre: string | null
  cgtHigherRatePre: string | null
  cgtRateChangeDate: string | null
  dividendAllowance: string
  dividendBasicRate: string
  dividendHigherRate: string
  dividendAddlRate: string
  cgtProceedsThreshold: string
  incomeBasicRateLimit: string
}

// ── API payload shapes ─────────────────────────────────────────────────────────

export interface CreateInstrumentBody {
  ticker: string
  isin?: string
  name: string
  currency: string
  exchange?: string
  instrumentType?: InstrumentType
  isEmployerStock?: boolean
  rsuWithholdingMethod?: RsuWithholdingMethod
  notes?: string
}

export interface UpdateInstrumentBody extends Partial<CreateInstrumentBody> {}

export interface CreateTransactionBody {
  instrumentId: number
  txnType: TransactionType
  txnDate: string
  quantity: string
  unitPriceNative?: string
  nativeCurrency?: string
  fxRate?: string
  fxRateType?: FxRateType
  costsGbp?: string
  incomeAmountGbp?: string
  esppDiscountPriceNative?: string
  rsuGrossSharesVested?: string
  rsuSharesWithheld?: string
  rsuWithholdingRate?: string
  rsuWithholdingMethod?: RsuWithholdingMethod
  dividendGrossGbp?: string
  dividendWithholdingGbp?: string
  dividendNetGbp?: string
  splitRatio?: string
  capreturnsPerShareGbp?: string
  notes?: string
}

export interface UpdateTransactionBody extends Partial<CreateTransactionBody> {
  // Derived fields written back by the server after FX computation
  unitPriceGbp?: string | null
  totalGbp?: string | null
  netGbp?: string | null
  fxRateSource?: string | null
  esppDiscountPriceGbp?: string | null
}

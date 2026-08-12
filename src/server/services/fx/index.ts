import Big from 'big.js'
import type { FxRate, FxRateType } from '../../../shared/types.ts'
import type { FxRateStore } from '../../repositories/index.ts'
import { getFrankfurterRate } from './frankfurter.ts'
import { getHmrcRateForDate } from './hmrc.ts'

export interface FxService {
  getRate(fromCurrency: string, toCurrency: string, date: string): Promise<FxRate>
  convert(
    amount: string,
    fromCurrency: string,
    toCurrency: string,
    date: string,
  ): Promise<{ gbp: string; rate: FxRate }>
}

export function createFxService(store: FxRateStore, policy: FxRateType): FxService {
  async function getRate(fromCurrency: string, toCurrency: string, date: string): Promise<FxRate> {
    if (fromCurrency === toCurrency) {
      return {
        id: 0,
        fromCurrency,
        toCurrency,
        rateDate: date,
        rate: '1',
        rateType: policy,
        source: 'identity',
        fetchedAt: new Date().toISOString(),
      }
    }

    // GBX is GBP pence — 1 GBX = 0.01 GBP. No HMRC/Frankfurter rate exists for it.
    if (fromCurrency === 'GBX' && toCurrency === 'GBP') {
      return {
        id: 0,
        fromCurrency,
        toCurrency,
        rateDate: date,
        rate: '0.01',
        rateType: policy,
        source: 'identity',
        fetchedAt: new Date().toISOString(),
      }
    }
    if (fromCurrency === 'GBP' && toCurrency === 'GBX') {
      return {
        id: 0,
        fromCurrency,
        toCurrency,
        rateDate: date,
        rate: '100',
        rateType: policy,
        source: 'identity',
        fetchedAt: new Date().toISOString(),
      }
    }

    // Check local cache first regardless of policy
    const cached = store.get(fromCurrency, toCurrency, date, policy)
    if (cached) return cached

    if (policy === 'hmrc-monthly') {
      return getHmrcRateForDate(fromCurrency, toCurrency, date, store)
    }
    return getFrankfurterRate(fromCurrency, toCurrency, date, store)
  }

  async function convert(amount: string, fromCurrency: string, toCurrency: string, date: string) {
    const rate = await getRate(fromCurrency, toCurrency, date)
    const gbp = new Big(amount).times(new Big(rate.rate)).toFixed(8)
    return { gbp, rate }
  }

  return { getRate, convert }
}

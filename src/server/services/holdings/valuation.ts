import Big from 'big.js'
import type { Instrument } from '../../../shared/types.ts'
import type { S104PoolStore } from '../../repositories/sqlite/S104PoolStore.ts'
import type { FxService } from '../fx/index.ts'
import type { PriceService } from '../prices/cache.ts'

export interface HoldingValuation {
  instrument: Instrument
  /** Shares held in the S104 pool */
  quantity: string
  /** Pool cost basis in GBP */
  costGbp: string
  /** Average cost per share in GBP (costGbp / quantity), or null if quantity is 0 */
  avgCostGbp: string | null
  /** Latest price in instrument's native currency, or null if unavailable */
  latestPriceNative: string | null
  /** Date of the latest price */
  latestPriceDate: string | null
  /** Latest price converted to GBP, or null if unavailable */
  latestPriceGbp: string | null
  /** Current portfolio value in GBP (quantity × latestPriceGbp), or null */
  currentValueGbp: string | null
  /** Unrealised gain/loss in GBP (currentValueGbp - costGbp), or null */
  unrealisedGainGbp: string | null
  /** Unrealised gain/loss as a percentage, or null */
  unrealisedGainPct: string | null
}

export async function computeHoldings(
  tenantId: number,
  instruments: Instrument[],
  s104Pools: S104PoolStore,
  priceService: PriceService,
  fx: FxService,
  today: string,
): Promise<HoldingValuation[]> {
  const results: HoldingValuation[] = []

  for (const inst of instruments) {
    const pool = s104Pools.get(tenantId, inst.id)
    const qty = new Big(pool.quantity)
    const cost = new Big(pool.costGbp)

    // Skip instruments with zero pool (fully disposed or never acquired)
    if (qty.lte(0)) continue

    const avgCostGbp = qty.gt(0) ? cost.div(qty).toFixed(8) : null

    // Get the latest cached price; if missing or zero, attempt to fetch today's price
    let priceRecord = priceService.getLatestCached(inst.id)
    if (!priceRecord || parseFloat(priceRecord.closePrice) <= 0) {
      priceRecord =
        (await priceService.getPrice(inst.id, inst.ticker, inst.currency, today)) ?? undefined
    }

    let latestPriceNative: string | null = null
    let latestPriceDate: string | null = null
    let latestPriceGbp: string | null = null
    let currentValueGbp: string | null = null
    let unrealisedGainGbp: string | null = null
    let unrealisedGainPct: string | null = null

    if (priceRecord && parseFloat(priceRecord.closePrice) > 0) {
      latestPriceNative = priceRecord.closePrice
      latestPriceDate = priceRecord.priceDate

      try {
        const { gbp: priceGbp } = await fx.convert(
          priceRecord.closePrice,
          inst.currency,
          'GBP',
          priceRecord.priceDate,
        )
        latestPriceGbp = priceGbp
        const value = qty.times(new Big(priceGbp))
        currentValueGbp = value.toFixed(2)
        const gain = value.minus(cost)
        unrealisedGainGbp = gain.toFixed(2)
        unrealisedGainPct = cost.gt(0) ? gain.div(cost).times(100).toFixed(2) : null
      } catch {
        // FX conversion failed — leave value fields null
      }
    }

    results.push({
      instrument: inst,
      quantity: pool.quantity,
      costGbp: pool.costGbp,
      avgCostGbp,
      latestPriceNative,
      latestPriceDate,
      latestPriceGbp,
      currentValueGbp,
      unrealisedGainGbp,
      unrealisedGainPct,
    })
  }

  return results
}

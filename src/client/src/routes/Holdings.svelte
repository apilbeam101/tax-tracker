<script lang="ts">
  import { onMount } from 'svelte'
  import { apiFetch } from '../lib/api.ts'
  import { maskedStore } from '../lib/masked.svelte.ts'

  interface HoldingRow {
    instrument: {
      id: number
      ticker: string
      name: string
      currency: string
    }
    quantity: string
    costGbp: string
    avgCostGbp: string | null
    latestPriceNative: string | null
    latestPriceDate: string | null
    latestPriceGbp: string | null
    currentValueGbp: string | null
    unrealisedGainGbp: string | null
    unrealisedGainPct: string | null
  }

  interface PoolHistoryEntry {
    txnId: number
    date: string
    txnType: string
    quantity: string
    costGbp: string
    avgCostGbp: string
  }

  let holdings: HoldingRow[] = $state([])
  let loading: boolean = $state(false)
  let refreshing: boolean = $state(false)
  let error: string = $state('')

  // Expanded rows: instrumentId -> history entries (null while loading)
  let expanded: Map<number, PoolHistoryEntry[] | null> = $state(new Map())

  onMount(load)

  async function load() {
    loading = true
    error = ''
    try {
      const res = await fetch('/api/holdings')
      if (!res.ok) { error = 'Failed to load holdings.'; return }
      holdings = await res.json()
    } catch {
      error = 'Network error.'
    } finally {
      loading = false
    }
  }

  async function refreshPrices() {
    refreshing = true
    error = ''
    try {
      await apiFetch('/api/holdings/refresh-prices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      await load()
    } catch {
      error = 'Refresh failed.'
    } finally {
      refreshing = false
    }
  }

  async function toggleHistory(instrumentId: number) {
    if (expanded.has(instrumentId)) {
      // Collapse
      const next = new Map(expanded)
      next.delete(instrumentId)
      expanded = next
      return
    }
    // Expand — mark loading
    expanded = new Map(expanded).set(instrumentId, null)
    const res = await fetch(`/api/tax/pool-history?instrumentId=${instrumentId}`)
    const data: PoolHistoryEntry[] = res.ok ? await res.json() : []
    expanded = new Map(expanded).set(instrumentId, data)
  }

  function fmtGbp(val: string | null, dp = 2) {
    if (!val) return '—'
    if (maskedStore.masked) return '£••••'
    const n = parseFloat(val)
    return `£${n.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
  }

  // Public market data — never masked
  function fmtNative(val: string | null, currency: string) {
    if (!val) return '—'
    const n = parseFloat(val)
    return `${currency} ${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
  }

  function fmtQty(val: string) {
    if (maskedStore.masked) return '••••'
    return parseFloat(val).toLocaleString('en-GB', { maximumFractionDigits: 6 })
  }

  function gainClass(val: string | null): string {
    if (!val) return ''
    return parseFloat(val) >= 0 ? 'positive' : 'negative'
  }

  const totalCost = $derived(
    holdings.reduce((sum, h) => sum + parseFloat(h.costGbp), 0)
  )
  const totalValue = $derived(
    holdings.every(h => h.currentValueGbp !== null)
      ? holdings.reduce((sum, h) => sum + parseFloat(h.currentValueGbp!), 0)
      : null
  )
  const totalGain = $derived(
    totalValue !== null ? totalValue - totalCost : null
  )
  const totalGainPct = $derived(
    totalGain !== null && totalCost > 0 ? (totalGain / totalCost) * 100 : null
  )
</script>

<div class="toolbar">
  <h2>Holdings</h2>
  <button type="button" class="btn-secondary" onclick={refreshPrices} disabled={refreshing}>
    {refreshing ? 'Refreshing…' : '↻ Refresh prices'}
  </button>
</div>

{#if error}
  <div class="error">{error}</div>
{/if}

{#if loading}
  <p class="hint">Loading holdings…</p>
{:else if holdings.length === 0}
  <p class="empty">No open positions. Run the tax engine first (Tax Summary → Run engine), then check back.</p>
{:else}
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th></th>
          <th>Ticker</th>
          <th class="num">Shares held</th>
          <th class="num">Cost basis</th>
          <th class="num">Avg cost / share</th>
          <th class="num">Latest price</th>
          <th class="num">Price date</th>
          <th class="num">Current value</th>
          <th class="num">Unrealised gain</th>
          <th class="num">Gain %</th>
        </tr>
      </thead>
      <tbody>
        {#each holdings as h (h.instrument.id)}
          {@const isExpanded = expanded.has(h.instrument.id)}
          {@const history = expanded.get(h.instrument.id)}
          <tr class="holding-row" class:expanded={isExpanded}>
            <td class="expand-cell">
              <button
                type="button"
                class="expand-btn"
                onclick={() => toggleHistory(h.instrument.id)}
                title="Show S104 pool cost history"
              >{isExpanded ? '▾' : '▸'}</button>
            </td>
            <td>
              <strong>{h.instrument.ticker}</strong>
              <span class="inst-name">{h.instrument.name}</span>
            </td>
            <td class="num">{fmtQty(h.quantity)}</td>
            <td class="num">{fmtGbp(h.costGbp)}</td>
            <td class="num">{h.avgCostGbp ? `£${parseFloat(h.avgCostGbp).toLocaleString('en-GB', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}` : '—'}</td>
            <td class="num">{fmtNative(h.latestPriceNative, h.instrument.currency)}</td>
            <td class="num date">{h.latestPriceDate ?? '—'}</td>
            <td class="num">{fmtGbp(h.currentValueGbp)}</td>
            <td class="num {gainClass(h.unrealisedGainGbp)}">{fmtGbp(h.unrealisedGainGbp)}</td>
            <td class="num {gainClass(h.unrealisedGainPct)}">
              {h.unrealisedGainPct !== null ? `${parseFloat(h.unrealisedGainPct).toFixed(1)}%` : '—'}
            </td>
          </tr>
          {#if isExpanded}
            <tr class="history-row">
              <td colspan="10" class="history-cell">
                {#if history === null}
                  <p class="history-loading">Loading pool history…</p>
                {:else if history.length === 0}
                  <p class="history-loading">No pool history available. Run the tax engine first.</p>
                {:else}
                  <div class="history-wrap">
                    <h4>S104 pool history — {h.instrument.ticker}</h4>
                    <p class="history-hint">Shows the pool state after each acquisition or disposal. Avg cost is the running HMRC average cost per share.</p>
                    <table class="history-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Event</th>
                          <th class="num">Pool quantity</th>
                          <th class="num">Pool cost (GBP)</th>
                          <th class="num">Avg cost / share</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each history as entry (entry.txnId)}
                          <tr>
                            <td>{entry.date}</td>
                            <td><span class="badge badge-{entry.txnType.toLowerCase()}">{entry.txnType}</span></td>
                            <td class="num">{maskedStore.masked ? '••••' : parseFloat(entry.quantity).toLocaleString('en-GB', { maximumFractionDigits: 6 })}</td>
                            <td class="num">{fmtGbp(entry.costGbp)}</td>
                            <td class="num avg">{`£${parseFloat(entry.avgCostGbp).toLocaleString('en-GB', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                {/if}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
      {#if holdings.length > 1}
        <tfoot>
          <tr class="totals">
            <td></td>
            <td><strong>Total</strong></td>
            <td></td>
            <td class="num"><strong>{fmtGbp(String(totalCost))}</strong></td>
            <td></td>
            <td></td>
            <td></td>
            <td class="num"><strong>{totalValue !== null ? fmtGbp(String(totalValue)) : '—'}</strong></td>
            <td class="num {gainClass(totalGain !== null ? String(totalGain) : null)}">
              <strong>{totalGain !== null ? fmtGbp(String(totalGain)) : '—'}</strong>
            </td>
            <td class="num {gainClass(totalGainPct !== null ? String(totalGainPct) : null)}">
              <strong>{totalGainPct !== null ? `${totalGainPct.toFixed(1)}%` : '—'}</strong>
            </td>
          </tr>
        </tfoot>
      {/if}
    </table>
  </div>

  <p class="hint">
    Prices sourced from Tiingo (if configured) or Yahoo Finance. Values shown in GBP using
    the configured FX policy. Unrealised gains are not reportable until shares are sold.
    Click ▸ on a row to see the S104 running average cost history.
  </p>
{/if}

<style>
  h2 { margin-top: 0; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
  .empty { color: #6c757d; }
  .hint { color: #6c757d; font-size: .8rem; margin-top: 1rem; }

  .btn-secondary { background: #fff; color: #0d6efd; border: 1px solid #0d6efd; padding: .5rem 1rem; border-radius: 4px; cursor: pointer; font-size: .9rem; }
  .btn-secondary:hover { background: #e8f0fe; }
  button:disabled { opacity: .65; cursor: not-allowed; }

  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: .875rem; }
  th, td { padding: .5rem .75rem; text-align: left; border-bottom: 1px solid #dee2e6; white-space: nowrap; }
  th { font-weight: 600; color: #495057; background: #f8f9fa; }
  .num { text-align: right; }
  .date { color: #6c757d; font-size: .8rem; }

  .expand-cell { width: 32px; padding: .35rem .5rem; }
  .expand-btn {
    background: none; border: none; cursor: pointer; color: #6c757d;
    font-size: .85rem; padding: 0; line-height: 1;
  }
  .expand-btn:hover { color: #0d6efd; }

  .holding-row.expanded > td { background: #f0f4ff; }

  .history-row > td { padding: 0; border-bottom: 2px solid #0d6efd33; }
  .history-cell { background: #f8f9fa; }
  .history-wrap { padding: 1rem 1.5rem; }
  .history-wrap h4 { margin: 0 0 .25rem; font-size: .9rem; color: #212529; }
  .history-hint { margin: 0 0 .75rem; font-size: .78rem; color: #6c757d; }
  .history-loading { padding: .75rem 1.5rem; color: #6c757d; font-size: .875rem; margin: 0; }

  .history-table { width: 100%; border-collapse: collapse; font-size: .825rem; }
  .history-table th, .history-table td { padding: .35rem .6rem; border-bottom: 1px solid #dee2e6; }
  .history-table th { background: #fff; font-weight: 600; color: #6c757d; font-size: .78rem; text-transform: uppercase; letter-spacing: .03em; }
  .history-table .avg { font-weight: 600; color: #0d6efd; }

  .inst-name { display: block; color: #6c757d; font-size: .75rem; font-weight: 400; }

  tfoot tr.totals td { border-top: 2px solid #dee2e6; border-bottom: none; background: #f8f9fa; }

  .positive { color: #198754; }
  .negative { color: #dc3545; }

  .badge { display: inline-block; padding: .125rem .4rem; border-radius: 3px; font-size: .75rem; font-weight: 600; background: #e9ecef; color: #495057; }
  .badge-buy, .badge-rsu_vest, .badge-espp_purchase, .badge-transfer_in, .badge-drip { background: #d1ecf1; color: #0c5460; }
  .badge-sell, .badge-transfer_out { background: #f8d7da; color: #721c24; }

  .error {
    background: #f8d7da; border: 1px solid #f5c2c7; border-radius: 4px;
    padding: .75rem; margin-bottom: 1rem; font-size: .875rem;
  }
</style>

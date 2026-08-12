<script lang="ts">
  import Transactions from './Transactions.svelte'
  import TaxSummary from './TaxSummary.svelte'
  import Holdings from './Holdings.svelte'
  import Projections from './Projections.svelte'
  import ImportExport from './ImportExport.svelte'
  import LineChart from '../lib/LineChart.svelte'
  import BarChart from '../lib/BarChart.svelte'
  import { onMount } from 'svelte'
  import { maskedStore } from '../lib/masked.svelte.ts'
  import { themeStore } from '../lib/theme.svelte.ts'

  type Page = 'dashboard' | 'transactions' | 'holdings' | 'tax' | 'projections' | 'import-export'

  let {
    user,
    onlogout,
  }: {
    user: { username: string } | null
    onlogout: () => void
  } = $props()

  let page: Page = $state('dashboard')

  interface ChartPoint { date: string; value: string }
  interface TaxYear { taxYear: string }
  interface HoldingSummary { ticker: string; costGbp: string; valueGbp: string | null; priceDate: string | null }
  interface ProjectedEvent {
    id: number; ticker: string; scheduleType: string
    scheduledDate: string; quantity: string
    projectedValueGbp: string | null; estimatedIncomeGbp: string | null
  }

  let portfolioPoints: ChartPoint[] = $state([])
  let gainPoints: ChartPoint[] = $state([])
  let dividendPoints: ChartPoint[] = $state([])
  let costVsValue: HoldingSummary[] = $state([])
  let upcomingEvents: ProjectedEvent[] = $state([])

  let chartPeriod: string = $state('1y')
  let taxYears: string[] = $state([])
  let selectedTaxYear: string = $state('')

  let loadingPortfolio = $state(false)
  let loadingGains = $state(false)
  let loadingDividends = $state(false)
  let loadingOverview = $state(true)

  let totalCostGbp = $state(0)
  let totalValueGbp: number | null = $state(null)
  let totalUnrealisedGbp: number | null = $state(null)

  // 7y and 10y added
  const PERIODS = ['3m', '6m', '1y', '2y', '3y', '5y', '7y', '10y']

  function taxYearForDate(date: string): string {
    const parts = date.split('-')
    const y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2])
    const inNewYear = m > 4 || (m === 4 && d >= 6)
    const start = inNewYear ? y : y - 1
    return `${start}-${String(start + 1).slice(-2)}`
  }

  const today = new Date().toISOString().slice(0, 10)

  async function loadTaxYears() {
    const res = await fetch('/api/tax/years')
    if (!res.ok) return
    const data: TaxYear[] = await res.json()
    taxYears = data.map(t => t.taxYear).sort().reverse()
    const current = taxYearForDate(today)
    selectedTaxYear = taxYears.includes(current) ? current : (taxYears[0] ?? current)
  }

  async function loadPortfolioChart() {
    loadingPortfolio = true
    try {
      const pv = await fetch(`/api/charts/portfolio-value?period=${chartPeriod}`).then(r => r.ok ? r.json() : { points: [] })
      portfolioPoints = pv.points ?? []
    } finally {
      loadingPortfolio = false
    }
  }

  async function loadGainsChart() {
    if (!selectedTaxYear) return
    loadingGains = true
    try {
      const rg = await fetch(`/api/charts/realised-gains?taxYear=${selectedTaxYear}`).then(r => r.ok ? r.json() : { points: [] })
      gainPoints = rg.points ?? []
    } finally {
      loadingGains = false
    }
  }

  async function loadDividendsChart() {
    if (!selectedTaxYear) return
    loadingDividends = true
    try {
      const di = await fetch(`/api/charts/dividend-income?taxYear=${selectedTaxYear}`).then(r => r.ok ? r.json() : { points: [] })
      dividendPoints = di.points ?? []
    } finally {
      loadingDividends = false
    }
  }

  async function loadOverview() {
    loadingOverview = true
    try {
      const [cv, proj] = await Promise.all([
        fetch('/api/charts/cost-vs-value').then(r => r.ok ? r.json() : []),
        fetch('/api/projections').then(r => r.ok ? r.json() : []),
      ])
      costVsValue = cv
      upcomingEvents = (proj as ProjectedEvent[]).slice(0, 5)
      totalCostGbp = costVsValue.reduce((s, h) => s + parseFloat(h.costGbp || '0'), 0)
      // Only compute value and unrealised gain for instruments that have a price.
      // Mixing priced value with full cost would produce a misleading gain figure.
      const priced = costVsValue.filter(h => h.valueGbp != null)
      if (priced.length > 0) {
        totalValueGbp = priced.reduce((s, h) => s + parseFloat(h.valueGbp!), 0)
        const pricedCost = priced.reduce((s, h) => s + parseFloat(h.costGbp), 0)
        totalUnrealisedGbp = totalValueGbp - pricedCost
      }
    } finally {
      loadingOverview = false
    }
  }

  onMount(async () => {
    await loadTaxYears()
    await Promise.all([loadPortfolioChart(), loadGainsChart(), loadDividendsChart(), loadOverview()])
  })

  // Re-fetch portfolio when period changes (skip first run — onMount handles it)
  let periodMounted = false
  $effect(() => {
    void chartPeriod
    if (!periodMounted) { periodMounted = true; return }
    loadPortfolioChart()
  })

  // Re-fetch gains + dividends when tax year changes (skip first run)
  let taxYearMounted = false
  $effect(() => {
    void selectedTaxYear
    if (!taxYearMounted) { taxYearMounted = true; return }
    loadGainsChart()
    loadDividendsChart()
  })

  function fmtGbp(v: number | null) {
    if (v === null) return '—'
    if (maskedStore.masked) return '£••••'
    return `£${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const maskedFormatY = (v: number) => maskedStore.masked ? '£••••' : `£${v.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
</script>

<div class="shell">
  <header>
    <span class="brand">UK Tax Tracker</span>
    <nav>
      <a href="#dashboard" class:active={page === 'dashboard'} onclick={() => page = 'dashboard'}>Dashboard</a>
      <a href="#transactions" class:active={page === 'transactions'} onclick={() => page = 'transactions'}>Transactions</a>
      <a href="#holdings" class:active={page === 'holdings'} onclick={() => page = 'holdings'}>Holdings</a>
      <a href="#tax" class:active={page === 'tax'} onclick={() => page = 'tax'}>Tax Summary</a>
      <a href="#projections" class:active={page === 'projections'} onclick={() => page = 'projections'}>Projections</a>
      <a href="#import-export" class:active={page === 'import-export'} onclick={() => page = 'import-export'}>Import / Export</a>
    </nav>
    <div class="user-menu">
      <button type="button" class="mask-btn" class:active={maskedStore.masked} onclick={() => maskedStore.toggle()} title="Toggle number masking">
        {maskedStore.masked ? '👁 Unmask' : '🙈 Mask'}
      </button>
      <button type="button" class="theme-btn" onclick={() => themeStore.toggle()} title="Toggle dark mode">
        {themeStore.theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
      </button>
      <span>{user?.username}</span>
      <button type="button" onclick={onlogout}>Sign out</button>
    </div>
  </header>

  <main>
    {#if page === 'transactions'}
      <Transactions />
    {:else if page === 'holdings'}
      <Holdings />
    {:else if page === 'tax'}
      <TaxSummary />
    {:else if page === 'projections'}
      <Projections />
    {:else if page === 'import-export'}
      <ImportExport />
    {:else}

      <!-- KPI cards -->
      {#if loadingOverview}
        <div class="kpi-row">
          {#each [1,2,3] as _}
            <div class="kpi-card loading"></div>
          {/each}
        </div>
      {:else}
        <div class="kpi-row">
          <div class="kpi-card">
            <div class="kpi-label">Cost basis</div>
            <div class="kpi-value">{fmtGbp(totalCostGbp)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Current value</div>
            <div class="kpi-value">{fmtGbp(totalValueGbp)}</div>
            {#if totalValueGbp === null}
              <div class="kpi-sub hint">Refresh prices on Holdings page</div>
            {/if}
          </div>
          <div class="kpi-card"
            class:gain={totalUnrealisedGbp !== null && totalUnrealisedGbp >= 0}
            class:loss={totalUnrealisedGbp !== null && totalUnrealisedGbp < 0}>
            <div class="kpi-label">Unrealised gain / loss</div>
            <div class="kpi-value">{fmtGbp(totalUnrealisedGbp)}</div>
            {#if totalValueGbp !== null && totalCostGbp > 0}
              <div class="kpi-sub">
                {((totalValueGbp - totalCostGbp) / totalCostGbp * 100).toFixed(1)}%
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <!-- ── Portfolio value (period-scoped) ─────────────────────────────────── -->
      <div class="section-header">
        <h3>Portfolio value</h3>
        <div class="period-pills">
          {#each PERIODS as p}
            <button type="button" class="pill" class:active={chartPeriod === p} onclick={() => chartPeriod = p}>{p.toUpperCase()}</button>
          {/each}
        </div>
      </div>
      {#if loadingPortfolio}
        <div class="chart-placeholder">Loading…</div>
      {:else}
        <div class="chart-card">
          <LineChart points={portfolioPoints} height={220} formatY={maskedFormatY} />
        </div>
      {/if}

      <!-- ── Realised gains + Dividends (tax-year-scoped, shared selector) ────── -->
      <div class="section-header" style="margin-top: 2rem">
        <h3>Tax year</h3>
        {#if taxYears.length > 1}
          <select class="year-select" bind:value={selectedTaxYear}>
            {#each taxYears as ty}
              <option value={ty}>{ty}</option>
            {/each}
          </select>
        {:else if selectedTaxYear}
          <span class="year-badge">{selectedTaxYear}</span>
        {/if}
      </div>

      <div class="chart-row">
        <div class="chart-col">
          <h4>Realised gains</h4>
          {#if loadingGains}
            <div class="chart-placeholder-sm">Loading…</div>
          {:else}
            <div class="chart-card">
              <BarChart points={gainPoints} height={180} formatY={maskedFormatY} />
            </div>
          {/if}
        </div>
        <div class="chart-col">
          <h4>Dividend income</h4>
          {#if loadingDividends}
            <div class="chart-placeholder-sm">Loading…</div>
          {:else}
            <div class="chart-card">
              <BarChart points={dividendPoints} height={180} color="var(--success)" formatY={maskedFormatY} />
            </div>
          {/if}
        </div>
      </div>

      <!-- Upcoming events -->
      {#if upcomingEvents.length > 0}
        <div class="section-header" style="margin-top: 2rem">
          <h3>Upcoming events</h3>
          <a href="#projections" class="see-all" onclick={() => page = 'projections'}>See all →</a>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Ticker</th>
                <th>Type</th>
                <th class="num">Shares</th>
                <th class="num">Proj. value</th>
                <th class="num">Est. income</th>
              </tr>
            </thead>
            <tbody>
              {#each upcomingEvents as evt (evt.id)}
                <tr>
                  <td>{evt.scheduledDate}</td>
                  <td><strong>{evt.ticker}</strong></td>
                  <td><span class="badge badge-{evt.scheduleType}">{evt.scheduleType}</span></td>
                  <td class="num">{maskedStore.masked ? '••••' : parseFloat(evt.quantity).toLocaleString('en-GB', { maximumFractionDigits: 4 })}</td>
                  <td class="num">{evt.projectedValueGbp ? (maskedStore.masked ? '£••••' : `£${parseFloat(evt.projectedValueGbp).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`) : '—'}</td>
                  <td class="num">
                    {#if evt.scheduleType === 'rsu-vest' && evt.estimatedIncomeGbp}
                      {maskedStore.masked ? '£••••' : `£${parseFloat(evt.estimatedIncomeGbp).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`}
                    {:else}—{/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

    {/if}
  </main>
</div>

<style>
  .shell { display: flex; flex-direction: column; min-height: 100vh; }
  header {
    display: flex; align-items: center; gap: 1.5rem;
    background: var(--nav-bg); color: var(--nav-text); padding: .75rem 1.5rem;
  }
  .brand { font-weight: 700; font-size: 1.1rem; white-space: nowrap; }
  nav { display: flex; gap: 1rem; flex: 1; }
  nav a { color: rgba(255,255,255,.8); text-decoration: none; font-size: .9rem; }
  nav a:hover, nav a.active { color: var(--nav-text); font-weight: 600; }
  .user-menu { display: flex; align-items: center; gap: .75rem; font-size: .875rem; }
  .user-menu button {
    background: transparent; border: 1px solid rgba(255,255,255,.4);
    color: var(--nav-text); padding: .25rem .75rem; border-radius: 4px; cursor: pointer; font-size: .875rem;
  }
  .mask-btn.active { background: rgba(255,193,7,.25); border-color: var(--warning); }
  main { padding: 2rem; flex: 1; min-width: 0; }

  /* KPI cards */
  .kpi-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-bottom: 2rem; }
  .kpi-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem 1.5rem; }
  .kpi-card.loading { min-height: 90px; background: var(--bg); }
  .kpi-card.gain { border-left: 4px solid var(--success); }
  .kpi-card.loss { border-left: 4px solid var(--danger); }
  .kpi-label { font-size: .8rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; margin-bottom: .35rem; }
  .kpi-value { font-size: 1.5rem; font-weight: 700; color: var(--text); }
  .kpi-sub { font-size: .85rem; color: var(--text-muted); margin-top: .2rem; }
  .hint { color: var(--text-muted); font-size: .8rem; }

  /* Section headers */
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: .75rem; }
  .section-header h3 { margin: 0; font-size: 1rem; }

  /* Period pills */
  .period-pills { display: flex; gap: .3rem; flex-wrap: wrap; }
  .pill {
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    padding: .2rem .55rem; font-size: .75rem; cursor: pointer; color: var(--text-secondary);
  }
  .pill.active { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }

  /* Tax year selector */
  .year-select {
    padding: .25rem .5rem; border: 1px solid var(--border); border-radius: 4px;
    font-size: .875rem; color: var(--text-secondary); background: var(--surface); cursor: pointer;
  }
  .year-badge { background: var(--surface-alt); color: var(--text-secondary); padding: .15rem .5rem; border-radius: 4px; font-size: .8rem; }

  /* Charts */
  .chart-card { border: 1px solid var(--border); border-radius: 8px; padding: 1rem; background: var(--surface); }
  .chart-placeholder { height: 220px; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: .875rem; }
  .chart-placeholder-sm { height: 180px; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: .875rem; }

  .chart-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .chart-col h4 { margin: 0 0 .6rem; font-size: .9rem; font-weight: 600; color: var(--text-secondary); }

  /* Upcoming events */
  .see-all { font-size: .875rem; color: var(--accent); text-decoration: none; }
  .see-all:hover { text-decoration: underline; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: .875rem; }
  th, td { padding: .5rem .75rem; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { font-weight: 600; color: var(--text-secondary); background: var(--bg); }
  .num { text-align: right; }
  .badge { display: inline-block; padding: .125rem .4rem; border-radius: 3px; font-size: .75rem; font-weight: 600; background: var(--surface-alt); color: var(--text-secondary); }
  .badge-rsu-vest { background: var(--info-bg); color: var(--info-text); }
  .badge-espp-purchase { background: var(--success-bg); color: var(--success-text); }
  .badge-option-expiry { background: var(--warning-bg); color: var(--warning-text); }

  @media (max-width: 700px) {
    .kpi-row { grid-template-columns: 1fr; }
    .chart-row { grid-template-columns: 1fr; }
  }
</style>

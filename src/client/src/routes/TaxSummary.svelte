<script lang="ts">
  import { onMount } from 'svelte'
  import type { TaxYearConfig } from '../../../shared/types.ts'
  import { apiFetch } from '../lib/api.ts'
  import { maskedStore } from '../lib/masked.svelte.ts'

  interface CgtSummary {
    taxYear: string
    totalProceeds: string
    totalAllowableCost: string
    totalSellingCosts: string
    grossGain: string
    grossLoss: string
    netGain: string
    annualExempt: string
    taxableGain: string
    taxAtBasicRate: string
    taxAtHigherRate: string
    estimatedTax: string
    disposalCount: number
    proceedsForThreshold: string
    mustReport: boolean
  }

  interface DisposalRecord {
    txnId: number
    instrumentId: number
    disposalDate: string
    taxYear: string
    matchType: string
    acquisitionTxnId: number | null
    quantity: string
    proceedsGbp: string
    allowableCostGbp: string
    sellingCostsGbp: string
    gainGbp: string
  }

  interface DividendTaxResult {
    txnId: number
    txnDate: string
    taxYear: string
    grossGbp: string
    withholdingGbp: string
    treatyCappedWithholdingGbp: string
    ukTaxBeforeCredit: string
    ftcr: string
    ukTaxAfterCredit: string
    rateBand: 'nil' | 'basic' | 'higher' | 'additional'
  }

  interface DividendSummary {
    totalGrossGbp: string
    totalWithholdingGbp: string
    dividendAllowance: string
    taxableGrossGbp: string
    rateBand: 'basic' | 'higher'
    ukRateApplied: string
    ukTaxBeforeCredit: string
    totalFtcr: string
    ukTaxAfterCredit: string
    transactionCount: number
  }

  interface EsppPurchaseIncome {
    txnId: number
    txnDate: string
    taxYear: string
    quantity: string
    mvAtPurchaseGbp: string
    pricePaidGbp: string
    discountGbp: string
    incomeAmountGbp: string
    poolCostGbp: string
  }

  interface EsppProjectedItem {
    scheduleId: number
    scheduledDate: string
    taxYear: string
    quantity: string
    mvAtPurchaseGbp: string | null
    pricePaidGbp: string | null
    discountGbp: string | null
    incomeAmountGbp: string | null
    poolCostGbp: string | null
    priceDate: string | null
    isProjection: true
  }

  interface EsppSummary {
    totalIncomeGbp: string
    totalDiscountGbp: string
    totalPoolCostGbp: string
    transactionCount: number
    projectedIncomeGbp: string
    projectedCount: number
    hasProjections: boolean
  }

  let taxYears: TaxYearConfig[] = $state([])
  let selectedYear: string = $state('')
  let income: string = $state('0')
  let taxBand: 'basic' | 'higher' | 'additional' | 'custom' = $state('custom')
  let summary: CgtSummary | null = $state(null)
  let disposals: DisposalRecord[] = $state([])
  let dividendItems: DividendTaxResult[] = $state([])
  let dividendSummary: DividendSummary | null = $state(null)
  let esppItems: EsppPurchaseIncome[] = $state([])
  let esppProjectedItems: EsppProjectedItem[] = $state([])
  let esppSummary: EsppSummary | null = $state(null)
  let loading = $state(false)
  let running = $state(false)
  let error = $state('')

  onMount(async () => {
    const res = await fetch('/api/tax/years')
    if (res.ok) {
      taxYears = await res.json()
      if (taxYears.length > 0) {
        const today = new Date().toISOString().slice(0, 10)
        const current = taxYears.find(y => today >= y.startDate && today <= y.endDate)
        selectedYear = current?.taxYear ?? taxYears[taxYears.length - 1].taxYear
        await loadSummary()
      }
    }
  })

  const BAND_INCOMES: Record<string, string> = { basic: '20000', higher: '60000', additional: '130000' }

  function selectBand(band: typeof taxBand) {
    taxBand = band
    if (band !== 'custom') {
      income = BAND_INCOMES[band]
      void loadSummary()
    }
  }

  async function loadSummary() {
    if (!selectedYear) return
    loading = true
    error = ''
    try {
      const params = new URLSearchParams({ taxYear: selectedYear, income })
      const [sumRes, dispRes, divRes, esppRes] = await Promise.all([
        fetch(`/api/tax/summary?${params}`),
        fetch(`/api/tax/disposals?taxYear=${selectedYear}`),
        fetch(`/api/tax/dividends?${params}`),
        fetch(`/api/tax/espp?taxYear=${selectedYear}`),
      ])
      if (sumRes.ok) summary = await sumRes.json()
      if (dispRes.ok) disposals = await dispRes.json()
      if (divRes.ok) {
        const divData = await divRes.json()
        dividendItems = divData.items ?? []
        dividendSummary = divData.summary ?? null
      }
      if (esppRes.ok) {
        const esppData = await esppRes.json()
        esppItems = esppData.items ?? []
        esppProjectedItems = esppData.projectedItems ?? []
        esppSummary = esppData.summary ?? null
      }
    } catch (e) {
      error = 'Failed to load tax summary'
    } finally {
      loading = false
    }
  }

  async function runEngine() {
    running = true
    error = ''
    try {
      const res = await apiFetch('/api/tax/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const data = await res.json()
        error = data.error ?? 'Engine run failed'
        return
      }
      await loadSummary()
    } catch (e) {
      error = 'Engine run failed'
    } finally {
      running = false
    }
  }

  function gbp(v: string | undefined | null): string {
    if (!v) return '—'
    const n = parseFloat(v)
    if (isNaN(n)) return '—'
    if (maskedStore.masked) return '£••••'
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n)
  }

  function pct(v: string): string {
    const n = parseFloat(v)
    if (isNaN(n)) return '—'
    return `${(n * 100).toFixed(2)}%`
  }

  function signClass(v: string): string {
    const n = parseFloat(v)
    if (n > 0) return 'gain'
    if (n < 0) return 'loss'
    return ''
  }

  function matchLabel(type: string): string {
    return type === 'same-day' ? 'Same day' : type === '30-day' ? '30 day (B&B)' : 'S104 pool'
  }

  // Estimated income tax on dividend / ESPP income using the configured band rate.
  // This is a rough guide only — the actual liability depends on Self Assessment.
  function estimateDividendTax(): string {
    if (!dividendSummary) return '—'
    return gbp(dividendSummary.ukTaxAfterCredit)
  }
</script>

<div class="tax-summary">
  <div class="toolbar">
    <h2>Tax Summary</h2>
    <div class="controls">
      <label>
        Tax year
        <select bind:value={selectedYear} onchange={loadSummary}>
          {#each taxYears as y}
            <option value={y.taxYear}>{y.taxYear}</option>
          {/each}
        </select>
      </label>
      <div class="band-group">
        <span class="band-label">Tax band</span>
        <div class="band-pills">
          {#each [['basic','Basic'], ['higher','Higher'], ['additional','Additional'], ['custom','Custom']] as [band, label]}
            <button type="button" class="band-pill" class:active={taxBand === band} onclick={() => selectBand(band as typeof taxBand)}>{label}</button>
          {/each}
        </div>
      </div>
      {#if taxBand === 'custom'}
        <label>
          Your income (£)
          <input type="number" min="0" step="1000" bind:value={income} onchange={loadSummary} />
        </label>
      {:else}
        <div class="income-hint">Income: £{parseInt(BAND_INCOMES[taxBand]).toLocaleString('en-GB')}</div>
      {/if}
      <button type="button" onclick={runEngine} disabled={running} class="btn-primary">
        {running ? 'Running…' : 'Run tax engine'}
      </button>
    </div>
  </div>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else}

    <!-- ── Capital Gains Tax ─────────────────────────────────────────── -->
    <div class="section-header">
      <h3>Capital Gains Tax</h3>
      <span class="section-sub">TCGA 1992 — disposals of shares &amp; securities</span>
    </div>

    {#if summary}
      <div class="cards">
        <div class="card">
          <div class="card-label">Total proceeds</div>
          <div class="card-value">{gbp(summary.totalProceeds)}</div>
        </div>
        <div class="card">
          <div class="card-label">Net gain / (loss)</div>
          <div class="card-value {signClass(summary.netGain)}">{gbp(summary.netGain)}</div>
        </div>
        <div class="card">
          <div class="card-label">Annual exempt amount</div>
          <div class="card-value">{summary.annualExempt ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(parseFloat(summary.annualExempt)) : '—'}</div>
        </div>
        <div class="card">
          <div class="card-label">Taxable gain</div>
          <div class="card-value">{gbp(summary.taxableGain)}</div>
        </div>
        <div class="card">
          <div class="card-label">Estimated CGT</div>
          <div class="card-value {parseFloat(summary.estimatedTax) > 0 ? 'loss' : ''}">{gbp(summary.estimatedTax)}</div>
        </div>
        <div class="card">
          <div class="card-label">Disposals</div>
          <div class="card-value">{summary.disposalCount}</div>
        </div>
      </div>

      {#if summary.mustReport}
        <div class="alert">
          ⚠ Proceeds ({gbp(summary.proceedsForThreshold)}) exceed the HMRC reporting threshold
          ({gbp(taxYears.find(y => y.taxYear === selectedYear)?.cgtProceedsThreshold ?? '50000')}).
          You must report disposals on Self Assessment even if there is no tax to pay.
        </div>
      {/if}

      <div class="section">
        <h4>CGT breakdown</h4>
        <table class="breakdown">
          <tbody>
            <tr><td>Gross gains</td><td class="right gain">{gbp(summary.grossGain)}</td></tr>
            <tr><td>Gross losses</td><td class="right loss">{gbp(summary.grossLoss)}</td></tr>
            <tr><td>Net gain / (loss)</td><td class="right {signClass(summary.netGain)}">{gbp(summary.netGain)}</td></tr>
            <tr><td>Annual exempt amount</td><td class="right">{summary.annualExempt ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(parseFloat(summary.annualExempt)) : '—'}</td></tr>
            <tr class="highlight"><td>Taxable gain</td><td class="right">{gbp(summary.taxableGain)}</td></tr>
            <tr><td>Tax @ basic rate (based on income entered above)</td><td class="right">{gbp(summary.taxAtBasicRate)}</td></tr>
            <tr><td>Tax @ higher rate</td><td class="right">{gbp(summary.taxAtHigherRate)}</td></tr>
            <tr class="highlight"><td>Estimated CGT (band-apportioned)</td><td class="right {parseFloat(summary.estimatedTax) > 0 ? 'loss' : ''}">{gbp(summary.estimatedTax)}</td></tr>
          </tbody>
        </table>
      </div>
    {:else}
      <p class="muted">No CGT data. Click "Run tax engine" to process your transactions.</p>
    {/if}

    {#if disposals.length > 0}
      <div class="section">
        <h4>Disposals ({disposals.length})</h4>
        <table class="disposals">
          <thead>
            <tr>
              <th>Date</th>
              <th>Match type</th>
              <th>Qty</th>
              <th>Proceeds</th>
              <th>Cost</th>
              <th>Gain / (Loss)</th>
            </tr>
          </thead>
          <tbody>
            {#each disposals as d}
              <tr>
                <td>{d.disposalDate}</td>
                <td><span class="badge badge-{d.matchType}">{matchLabel(d.matchType)}</span></td>
                <td class="right">{maskedStore.masked ? '••••' : parseFloat(d.quantity).toLocaleString('en-GB', { maximumFractionDigits: 4 })}</td>
                <td class="right">{gbp(d.proceedsGbp)}</td>
                <td class="right">{gbp(d.allowableCostGbp)}</td>
                <td class="right {signClass(d.gainGbp)}">{gbp(d.gainGbp)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <!-- ── Dividend Income ───────────────────────────────────────────── -->
    <div class="section-header mt">
      <h3>Dividend Income</h3>
      <span class="section-sub">ITTOIA 2005 Part 4 — dividend income from shares</span>
    </div>

    {#if dividendSummary}
      <div class="cards">
        <div class="card">
          <div class="card-label">Total gross dividends</div>
          <div class="card-value">{gbp(dividendSummary.totalGrossGbp)}</div>
        </div>
        <div class="card">
          <div class="card-label">Dividend allowance</div>
          <div class="card-value">{gbp(dividendSummary.dividendAllowance)}</div>
        </div>
        <div class="card">
          <div class="card-label">Taxable amount</div>
          <div class="card-value">{gbp(dividendSummary.taxableGrossGbp)}</div>
        </div>
        <div class="card">
          <div class="card-label">Foreign withholding</div>
          <div class="card-value">{gbp(dividendSummary.totalWithholdingGbp)}</div>
        </div>
        <div class="card">
          <div class="card-label">FTCR relief</div>
          <div class="card-value gain">{gbp(dividendSummary.totalFtcr)}</div>
        </div>
        <div class="card">
          <div class="card-label">Estimated dividend tax</div>
          <div class="card-value {parseFloat(dividendSummary.ukTaxAfterCredit) > 0 ? 'loss' : ''}">{estimateDividendTax()}</div>
        </div>
      </div>

      <div class="section">
        <h4>Dividend breakdown</h4>
        <table class="breakdown">
          <tbody>
            <tr><td>Total gross dividends received</td><td class="right">{gbp(dividendSummary.totalGrossGbp)}</td></tr>
            <tr><td>Less: dividend allowance</td><td class="right gain">({gbp(dividendSummary.dividendAllowance)})</td></tr>
            <tr class="highlight"><td>Taxable dividend income</td><td class="right">{gbp(dividendSummary.taxableGrossGbp)}</td></tr>
            <tr><td>Tax rate ({dividendSummary.rateBand} rate — {pct(dividendSummary.ukRateApplied)})</td><td class="right">{gbp(dividendSummary.ukTaxBeforeCredit)}</td></tr>
            <tr><td>Less: Foreign Tax Credit Relief (FTCR)</td><td class="right gain">({gbp(dividendSummary.totalFtcr)})</td></tr>
            <tr class="highlight"><td>Estimated dividend tax payable</td><td class="right {parseFloat(dividendSummary.ukTaxAfterCredit) > 0 ? 'loss' : ''}">{gbp(dividendSummary.ukTaxAfterCredit)}</td></tr>
          </tbody>
        </table>
        <p class="hint">FTCR is limited to the lower of foreign withholding and UK tax on the dividend. The dividend allowance (£{parseFloat(dividendSummary.dividendAllowance).toLocaleString('en-GB')}) covers the first slice of dividend income tax-free.</p>
      </div>

      {#if dividendItems.length > 0}
        <div class="section">
          <h4>Dividend transactions ({dividendItems.length})</h4>
          <table class="disposals">
            <thead>
              <tr>
                <th>Date</th>
                <th>Gross (GBP)</th>
                <th>Withholding</th>
                <th>FTCR</th>
                <th>UK Tax</th>
                <th>Band</th>
              </tr>
            </thead>
            <tbody>
              {#each dividendItems as d}
                <tr>
                  <td class="muted-sm">{d.txnDate}</td>
                  <td class="right">{gbp(d.grossGbp)}</td>
                  <td class="right">{gbp(d.withholdingGbp)}</td>
                  <td class="right gain">{gbp(d.ftcr)}</td>
                  <td class="right {parseFloat(d.ukTaxAfterCredit) > 0 ? 'loss' : ''}">{gbp(d.ukTaxAfterCredit)}</td>
                  <td><span class="badge badge-band-{d.rateBand}">{d.rateBand}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {:else if dividendItems.length === 0}
      <p class="muted">No dividend transactions found for {selectedYear}.</p>
    {/if}

    <!-- ── ESPP Income ────────────────────────────────────────────────── -->
    <div class="section-header mt">
      <h3>ESPP Employment Income</h3>
      <span class="section-sub">ITEPA 2003 Ch 9 — discount on employee share purchase</span>
    </div>

    {#if esppSummary}
      {#if esppSummary.hasProjections}
        <div class="alert alert-info">
          ⓘ This section includes <strong>{esppSummary.projectedCount} projected purchase{esppSummary.projectedCount !== 1 ? 's' : ''}</strong>
          based on scheduled events and the latest cached price.
          Projected income (<strong>{gbp(esppSummary.projectedIncomeGbp)}</strong>) is an estimate and will change until the actual transaction is recorded.
        </div>
      {/if}

      <div class="cards">
        <div class="card">
          <div class="card-label">Confirmed income</div>
          <div class="card-value">{gbp(esppSummary.totalIncomeGbp)}</div>
        </div>
        {#if esppSummary.hasProjections}
          <div class="card card-projected">
            <div class="card-label">Projected income (estimate)</div>
            <div class="card-value">{gbp(esppSummary.projectedIncomeGbp)}</div>
          </div>
        {/if}
        <div class="card">
          <div class="card-label">Confirmed discount (GBP)</div>
          <div class="card-value">{gbp(esppSummary.totalDiscountGbp)}</div>
        </div>
        <div class="card">
          <div class="card-label">CGT pool cost added</div>
          <div class="card-value">{gbp(esppSummary.totalPoolCostGbp)}</div>
        </div>
        <div class="card">
          <div class="card-label">Confirmed purchases</div>
          <div class="card-value">{esppSummary.transactionCount}</div>
        </div>
      </div>

      <div class="section">
        <h4>How ESPP income is calculated</h4>
        <p class="hint">
          Under ITEPA 2003 Chapter 9, the discount (market value at purchase minus price paid) is treated as employment income in the tax year of purchase.
          The CGT cost basis is set to the full market value at purchase — not the discounted price — because the discount has already been charged to income tax.
          This income should be declared on your Self Assessment return and may already have been reported via your employer's PAYE.
        </p>
        <table class="breakdown">
          <tbody>
            <tr><td>Confirmed employment income (discount × shares)</td><td class="right">{gbp(esppSummary.totalIncomeGbp)}</td></tr>
            {#if esppSummary.hasProjections}
              <tr class="projected-row"><td>Projected employment income (estimate) <span class="badge badge-projected">estimate</span></td><td class="right">{gbp(esppSummary.projectedIncomeGbp)}</td></tr>
            {/if}
            <tr><td>CGT cost basis entered into S104 pool</td><td class="right">{gbp(esppSummary.totalPoolCostGbp)}</td></tr>
          </tbody>
        </table>
      </div>

      {#if esppItems.length > 0}
        <div class="section">
          <h4>Confirmed ESPP purchases ({esppItems.length})</h4>
          <table class="disposals">
            <thead>
              <tr>
                <th>Date</th>
                <th>Qty</th>
                <th>MV/share</th>
                <th>Price paid/share</th>
                <th>Discount/share</th>
                <th>Income (GBP)</th>
                <th>Pool cost (GBP)</th>
              </tr>
            </thead>
            <tbody>
              {#each esppItems as e}
                <tr>
                  <td class="muted-sm">{e.txnDate}</td>
                  <td class="right">{maskedStore.masked ? '••••' : parseFloat(e.quantity).toLocaleString('en-GB', { maximumFractionDigits: 4 })}</td>
                  <td class="right">{gbp(e.mvAtPurchaseGbp)}</td>
                  <td class="right">{gbp(e.pricePaidGbp)}</td>
                  <td class="right gain">{gbp(e.discountGbp)}</td>
                  <td class="right">{gbp(e.incomeAmountGbp)}</td>
                  <td class="right">{gbp(e.poolCostGbp)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      {#if esppProjectedItems.length > 0}
        <div class="section">
          <h4>Projected ESPP purchases ({esppProjectedItems.length}) <span class="badge badge-projected">estimates</span></h4>
          <p class="hint">
            These are scheduled purchases from the Projections page that have not yet been realised as transactions.
            Market value is estimated from the latest cached price. Income will update automatically when prices refresh,
            and disappear once the actual transaction is entered.
          </p>
          <table class="disposals">
            <thead>
              <tr>
                <th>Scheduled date</th>
                <th>Qty</th>
                <th>Est. MV/share</th>
                <th>Discount price/share</th>
                <th>Est. discount/share</th>
                <th>Est. income (GBP)</th>
                <th>Price as of</th>
              </tr>
            </thead>
            <tbody>
              {#each esppProjectedItems as e}
                <tr class="projected-row">
                  <td>{e.scheduledDate}</td>
                  <td class="right">{maskedStore.masked ? '••••' : parseFloat(e.quantity).toLocaleString('en-GB', { maximumFractionDigits: 4 })}</td>
                  <td class="right">{gbp(e.mvAtPurchaseGbp)}</td>
                  <td class="right">{gbp(e.pricePaidGbp)}</td>
                  <td class="right gain">{gbp(e.discountGbp)}</td>
                  <td class="right">{gbp(e.incomeAmountGbp)}</td>
                  <td class="muted-sm">{e.priceDate ?? '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {:else}
      <p class="muted">No ESPP purchases with a discount price recorded for {selectedYear}. Add the discounted purchase price to ESPP_PURCHASE transactions to see income here.</p>
    {/if}

  {/if}
</div>

<style>
  .tax-summary { max-width: 1100px; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
  .toolbar h2 { margin: 0; }
  .controls { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
  label { display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; font-weight: 600; }
  label select, label input { font-size: 1rem; padding: .35rem .5rem; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--text); }
  label input { width: 120px; }
  .btn-primary { background: var(--nav-bg); color: var(--nav-text); border: none; padding: .5rem 1rem; border-radius: 4px; cursor: pointer; font-size: .9rem; }
  .btn-primary:disabled { opacity: .6; cursor: not-allowed; }

  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 1rem; }
  .card-label { font-size: .78rem; color: var(--text-muted); margin-bottom: .25rem; }
  .card-value { font-size: 1.25rem; font-weight: 700; }

  /* Tax band selector */
  .band-group { display: flex; flex-direction: column; gap: .25rem; }
  .band-label { font-size: .85rem; font-weight: 600; }
  .band-pills { display: flex; gap: .3rem; }
  .band-pill {
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    padding: .25rem .6rem; font-size: .8rem; cursor: pointer; color: var(--text-secondary);
  }
  .band-pill.active { background: var(--nav-bg); color: var(--nav-text); border-color: var(--nav-bg); }
  .band-pill:hover:not(.active) { background: var(--surface-alt); }
  .income-hint { font-size: .85rem; color: var(--text-muted); padding: .35rem 0; align-self: flex-end; }

  .gain { color: var(--success); }
  .loss { color: var(--danger); }

  .alert { background: var(--warning-bg); border: 1px solid var(--warning); border-radius: 6px; padding: .75rem 1rem; margin-bottom: 1.5rem; font-size: .9rem; }
  .error { color: var(--danger); margin-bottom: 1rem; }
  .muted { color: var(--text-muted); }
  .muted-sm { color: var(--text-muted); font-size: .8rem; }
  .hint { color: var(--text-muted); font-size: .85rem; margin: .5rem 0 1rem; line-height: 1.5; }

  /* Section headers */
  .section-header { display: flex; align-items: baseline; gap: 1rem; margin-top: 2.5rem; margin-bottom: 1rem; border-bottom: 2px solid var(--border); padding-bottom: .5rem; }
  .section-header h3 { margin: 0; font-size: 1.1rem; }
  .section-header.mt { margin-top: 3rem; }
  .section-sub { font-size: .8rem; color: var(--text-muted); }

  .section { margin-top: 1.5rem; }
  .section h4 { margin-top: 0; margin-bottom: .75rem; font-size: .95rem; color: var(--text-secondary); }

  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { padding: .5rem .75rem; text-align: left; border-bottom: 1px solid var(--border); }
  th { background: var(--bg); font-weight: 600; }
  .right { text-align: right; }
  tr.highlight td { background: var(--bg); font-weight: 600; }

  .badge { font-size: .75rem; padding: .2rem .5rem; border-radius: 4px; white-space: nowrap; }
  .badge-same-day { background: var(--info-bg-alt); color: var(--info-text-alt); }
  .badge-30-day { background: var(--warning-bg); color: var(--warning-text-alt); }
  .badge-s104-pool { background: var(--neutral-bg); color: var(--neutral-text); }
  .badge-band-nil { background: var(--neutral-bg); color: var(--neutral-text); }
  .badge-band-basic { background: var(--info-bg); color: var(--info-text); }
  .badge-band-higher { background: var(--warning-bg); color: var(--warning-text-alt); }
  .badge-band-additional { background: var(--danger-bg); color: var(--danger-text-alt); }
  .badge-projected { background: var(--projected-bg); color: var(--projected-text-alt); }

  .alert-info { background: var(--info-bg-alt); border: 1px solid var(--info-border); border-radius: 6px; padding: .75rem 1rem; margin-bottom: 1.5rem; font-size: .9rem; color: var(--info-text-alt); }

  .card-projected { border-style: dashed; border-color: var(--projected-border); background: var(--projected-bg-alt); }
  .card-projected .card-label { color: var(--projected-accent); }
  .card-projected .card-value { color: var(--projected-text); }

  .projected-row td { background: var(--projected-bg-alt); color: var(--projected-text); font-style: italic; }
</style>

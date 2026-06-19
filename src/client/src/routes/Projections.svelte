<script lang="ts">
  import { onMount } from 'svelte'
  import { apiFetch } from '../lib/api.ts'
  import { maskedStore } from '../lib/masked.svelte.ts'

  interface ProjectedEvent {
    id: number
    instrumentId: number
    ticker: string
    currency: string
    scheduleType: string
    scheduledDate: string
    quantity: string
    expectedDiscountPriceNative: string | null
    latestPriceNative: string | null
    latestPriceDate: string | null
    projectedValueGbp: string | null
    estimatedIncomeGbp: string | null
    estimatedEsppDiscountGbp: string | null
    notes: string | null
  }

  type View = 'list' | 'add'

  let view: View = $state('list')
  let events: ProjectedEvent[] = $state([])
  let loading = $state(false)
  let error = $state('')

  interface Instrument { id: number; ticker: string; currency: string }
  let instruments: Instrument[] = $state([])

  let form = $state({
    instrumentId: '' as number | '',
    scheduleType: 'rsu-vest',
    scheduledDate: '',
    quantity: '',
    expectedDiscountPriceNative: '',
    notes: '',
  })

  onMount(async () => {
    await Promise.all([loadEvents(), loadInstruments()])
  })

  async function loadEvents() {
    loading = true
    try {
      const res = await fetch('/api/projections')
      if (res.ok) events = await res.json()
    } finally {
      loading = false
    }
  }

  async function loadInstruments() {
    const res = await fetch('/api/instruments')
    if (res.ok) instruments = await res.json()
  }

  async function save() {
    error = ''
    loading = true
    try {
      const res = await apiFetch('/api/projections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instrumentId: Number(form.instrumentId),
          scheduleType: form.scheduleType,
          scheduledDate: form.scheduledDate,
          quantity: form.quantity,
          ...(form.expectedDiscountPriceNative ? { expectedDiscountPriceNative: form.expectedDiscountPriceNative } : {}),
          ...(form.notes ? { notes: form.notes } : {}),
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        error = d.error ?? 'Save failed.'
        return
      }
      await loadEvents()
      view = 'list'
    } catch {
      error = 'Network error.'
    } finally {
      loading = false
    }
  }

  async function remove(id: number) {
    if (!confirm('Delete this scheduled event?')) return
    await apiFetch(`/api/projections/${id}`, { method: 'DELETE' })
    await loadEvents()
  }

  function fmtGbp(val: string | null) {
    if (!val) return '—'
    if (maskedStore.masked) return '£••••'
    return `£${parseFloat(val).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  function fmtQty(val: string) {
    if (maskedStore.masked) return '••••'
    return parseFloat(val).toLocaleString('en-GB', { maximumFractionDigits: 4 })
  }

  const SCHEDULE_TYPES = ['rsu-vest', 'espp-purchase', 'option-expiry']

  // Group events by tax year
  function taxYearForDate(date: string): string {
    const [y, m, d] = date.split('-').map(Number)
    const inNewYear = m > 4 || (m === 4 && d >= 6)
    const start = inNewYear ? y : y - 1
    return `${start}-${String(start + 1).slice(-2)}`
  }

  interface Group { taxYear: string; events: ProjectedEvent[] }
  let grouped: Group[] = $derived((() => {
    const map = new Map<string, ProjectedEvent[]>()
    for (const e of events) {
      const ty = taxYearForDate(e.scheduledDate)
      const arr = map.get(ty) ?? []
      arr.push(e)
      map.set(ty, arr)
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a < b ? -1 : 1)
      .map(([taxYear, evts]) => ({ taxYear, events: evts }))
  })())

  // Totals per group
  function groupTotal(evts: ProjectedEvent[]) {
    let total = 0
    for (const e of evts) {
      if (e.projectedValueGbp) total += parseFloat(e.projectedValueGbp)
    }
    return total > 0 ? fmtGbp(total.toFixed(2)) : null
  }
</script>

{#if view === 'list'}
  <div class="toolbar">
    <h2>Projections</h2>
    <button class="btn-primary" onclick={() => { view = 'add'; form = { instrumentId: '', scheduleType: 'rsu-vest', scheduledDate: '', quantity: '', expectedDiscountPriceNative: '', notes: '' }; error = '' }}>
      + Add event
    </button>
  </div>

  {#if loading}
    <p class="hint">Loading…</p>
  {:else if events.length === 0}
    <p class="empty">No upcoming vest or purchase events. Add your schedule above.</p>
  {:else}
    {#each grouped as group (group.taxYear)}
      <div class="group-header">
        <span>Tax year {group.taxYear}</span>
        {#if groupTotal(group.events)}
          <span class="group-total">Projected total: {groupTotal(group.events)}</span>
        {/if}
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Ticker</th>
              <th>Type</th>
              <th class="num">Shares</th>
              <th class="num">Latest price</th>
              <th class="num">Projected value</th>
              <th class="num">Est. income</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each group.events as evt (evt.id)}
              <tr>
                <td>{evt.scheduledDate}</td>
                <td><strong>{evt.ticker}</strong></td>
                <td><span class="badge badge-{evt.scheduleType}">{evt.scheduleType}</span></td>
                <td class="num">{fmtQty(evt.quantity)}</td>
                <td class="num">
                  {#if evt.latestPriceNative}
                    {evt.currency} {parseFloat(evt.latestPriceNative).toLocaleString('en-GB', { minimumFractionDigits: 2 })}
                    {#if evt.latestPriceDate}
                      <span class="hint-inline">({evt.latestPriceDate})</span>
                    {/if}
                  {:else}
                    —
                  {/if}
                </td>
                <td class="num">{fmtGbp(evt.projectedValueGbp)}</td>
                <td class="num">
                  {#if evt.scheduleType === 'rsu-vest'}
                    {fmtGbp(evt.estimatedIncomeGbp)}
                  {:else if evt.scheduleType === 'espp-purchase' && evt.estimatedEsppDiscountGbp}
                    {fmtGbp(evt.estimatedEsppDiscountGbp)}
                  {:else}
                    —
                  {/if}
                </td>
                <td class="actions">
                  <button class="btn-link danger" onclick={() => remove(evt.id)}>Del</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/each}
  {/if}

{:else}
  <div class="form-header">
    <button class="btn-link" onclick={() => view = 'list'}>← Back</button>
    <h2>Add scheduled event</h2>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <form onsubmit={(e) => { e.preventDefault(); save() }} class="proj-form">
    <div class="row">
      <label>
        Instrument *
        <select bind:value={form.instrumentId} required>
          <option value="">— select —</option>
          {#each instruments as inst (inst.id)}
            <option value={inst.id}>{inst.ticker}</option>
          {/each}
        </select>
      </label>

      <label>
        Type *
        <select bind:value={form.scheduleType} required>
          {#each SCHEDULE_TYPES as t}
            <option value={t}>{t}</option>
          {/each}
        </select>
      </label>

      <label>
        Date *
        <input type="date" bind:value={form.scheduledDate} required />
      </label>
    </div>

    <div class="row">
      <label>
        Shares *
        <input type="text" bind:value={form.quantity} placeholder="e.g. 50" required pattern="^\d+(\.\d+)?$" />
      </label>

      {#if form.scheduleType === 'espp-purchase'}
        <label>
          Discounted purchase price (native)
          <input type="text" bind:value={form.expectedDiscountPriceNative} placeholder="e.g. 42.50" pattern="^\d+(\.\d+)?$" />
        </label>
      {/if}

      <label class="wide">
        Notes
        <input type="text" bind:value={form.notes} placeholder="optional" />
      </label>
    </div>

    {#if form.scheduleType === 'espp-purchase'}
      <p class="hint">Enter the discounted purchase price per share (in the instrument's native currency). The projected employment income is estimated as (latest market price − discount price) × shares.</p>
    {:else}
      <p class="hint">Projected value is estimated using the latest cached price — it will update when prices are refreshed.</p>
    {/if}

    <div class="form-actions">
      <button type="button" onclick={() => view = 'list'}>Cancel</button>
      <button type="submit" class="btn-primary" disabled={loading}>
        {loading ? 'Saving…' : 'Add event'}
      </button>
    </div>
  </form>
{/if}

<style>
  h2 { margin-top: 0; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
  .empty { color: #6c757d; }
  .hint { color: #6c757d; font-size: .8rem; margin: .25rem 0 1rem; }
  .hint-inline { color: #6c757d; font-size: .8rem; }

  .group-header {
    display: flex; align-items: baseline; justify-content: space-between;
    font-weight: 600; font-size: .9rem; color: #495057;
    margin: 1.5rem 0 .5rem; padding-bottom: .4rem;
    border-bottom: 2px solid #dee2e6;
  }
  .group-total { font-weight: 400; color: #0d6efd; font-size: .875rem; }

  .table-wrap { overflow-x: auto; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; font-size: .875rem; }
  th, td { padding: .5rem .75rem; text-align: left; border-bottom: 1px solid #dee2e6; white-space: nowrap; }
  th { font-weight: 600; color: #495057; background: #f8f9fa; }
  .num { text-align: right; }

  .badge { display: inline-block; padding: .125rem .4rem; border-radius: 3px; font-size: .75rem; font-weight: 600; background: #e9ecef; color: #495057; }
  .badge-rsu-vest { background: #d1ecf1; color: #0c5460; }
  .badge-espp-purchase { background: #d4edda; color: #155724; }
  .badge-option-expiry { background: #fff3cd; color: #856404; }

  .actions { display: flex; gap: .5rem; }
  .btn-link { background: none; border: none; color: #0d6efd; cursor: pointer; padding: 0; font-size: inherit; }
  .btn-link.danger { color: #dc3545; }
  .btn-primary { background: #0d6efd; color: white; border: none; padding: .5rem 1rem; border-radius: 4px; cursor: pointer; font-size: .9rem; }
  button:disabled { opacity: .65; cursor: not-allowed; }

  .form-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; }
  .proj-form { max-width: 700px; }
  .row { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
  label { display: flex; flex-direction: column; gap: .25rem; font-weight: 500; font-size: .9rem; flex: 1; min-width: 140px; }
  label.wide { flex: 2; }
  input, select { padding: .4rem .6rem; border: 1px solid #ced4da; border-radius: 4px; font-size: .9rem; }
  .form-actions { display: flex; gap: .75rem; }
  .error { background: #f8d7da; border: 1px solid #f5c2c7; border-radius: 4px; padding: .75rem; margin-bottom: 1rem; font-size: .875rem; }
</style>

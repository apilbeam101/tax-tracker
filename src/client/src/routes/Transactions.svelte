<script lang="ts">
  import { onMount } from 'svelte'
  import type { Transaction, Instrument, TransactionType } from '../../../shared/types.ts'
  import { apiFetch } from '../lib/api.ts'
  import { maskedStore } from '../lib/masked.svelte.ts'

  type View = 'list' | 'add' | 'edit' | 'import-dividends'
  type SortKey = 'txnDate' | 'txnType' | 'instrument' | 'quantity' | 'unitPriceNative' | 'unitPriceGbp' | 'fxRate' | 'totalGbp' | 'costsGbp' | 'netGbp'
  type SortDir = 'asc' | 'desc'

  interface DividendRow {
    exDate: string
    paymentDate: string
    paymentDateEstimated: boolean
    amountPerShare: string
    quantity: string
    skipReason: string | null
  }

  let view: View = $state('list')
  let transactions: Transaction[] = $state([])
  let instruments: Instrument[] = $state([])
  let editingTxn: Transaction | null = $state(null)
  let error: string = $state('')
  let loading: boolean = $state(false)
  const masked = $derived(maskedStore.masked)

  // Sort state
  let sortKey: SortKey = $state('txnDate')
  let sortDir: SortDir = $state('desc')

  // Column widths (px); null = auto
  const defaultWidths: Record<SortKey | 'actions', number> = {
    txnDate: 100, txnType: 110, instrument: 110, quantity: 90,
    unitPriceNative: 120, unitPriceGbp: 110, fxRate: 80,
    totalGbp: 110, costsGbp: 80, netGbp: 110, actions: 80,
  }
  let colWidths: Record<string, number> = $state({ ...defaultWidths })

  // Drag-resize state
  let draggingCol: string | null = $state(null)
  let dragStartX = 0
  let dragStartW = 0

  // Import dividends state
  let importInstrumentId: number | '' = $state('')
  let importPreviewRows: DividendRow[] = $state([])
  let importInserted: number = $state(0)
  let importDone: boolean = $state(false)

  // Form state
  let form = $state<{
    instrumentId: number | '' | 'new'
    txnType: TransactionType | ''
    txnDate: string
    quantity: string
    unitPriceNative: string
    nativeCurrency: string
    esppDiscountPriceNative: string
    costsGbp: string
    notes: string
  }>({
    instrumentId: '',
    txnType: '',
    txnDate: '',
    quantity: '',
    unitPriceNative: '',
    nativeCurrency: '',
    esppDiscountPriceNative: '',
    costsGbp: '',
    notes: '',
  })

  // New instrument inline form
  let newInstForm = $state({ ticker: '', name: '', currency: 'USD' })
  let newInstError = $state('')
  let savingInst = $state(false)

  // Edit instrument inline form
  let editingInst = $state(false)
  let editInstForm = $state({ ticker: '', name: '', currency: '' })
  let editInstError = $state('')
  let savingEditInst = $state(false)

  const TXN_TYPES: TransactionType[] = [
    'BUY', 'SELL', 'DIV_PAY', 'DRIP', 'RSU_VEST', 'ESPP_PURCHASE',
    'SPLIT', 'UNSPLIT', 'CAPRETURN', 'RIGHTS_ISSUE', 'TRANSFER_IN', 'TRANSFER_OUT',
  ]

  const COL_TIPS: Record<string, string> = {
    txnDate: 'Date the trade or event settled.',
    txnType: 'Transaction type: BUY/SELL are share trades; DIV_PAY is a cash dividend; RSU_VEST/ESPP_PURCHASE are equity compensation events.',
    instrument: 'The security this transaction belongs to.',
    quantity: 'Number of shares bought, sold, or received.',
    unitPriceNative: 'Price per share in the instrument\'s native currency.',
    unitPriceGbp: 'Price per share converted to GBP using the FX rate on the transaction date.',
    fxRate: 'Exchange rate used to convert the native currency to GBP.',
    totalGbp: 'Gross proceeds or cost in GBP (quantity × unit price GBP).',
    costsGbp: 'Broker commissions, stamp duty, or other acquisition costs in GBP.',
    netGbp: 'Net GBP after deducting costs from the gross total.',
    actions: '',
  }

  onMount(async () => {
    await Promise.all([loadTransactions(), loadInstruments()])
  })

  async function loadTransactions() {
    const res = await fetch('/api/transactions')
    if (res.ok) transactions = await res.json()
  }

  async function loadInstruments() {
    const res = await fetch('/api/instruments')
    if (res.ok) instruments = await res.json()
  }

  function openAdd() {
    editingTxn = null
    form = { instrumentId: '', txnType: '', txnDate: '', quantity: '', unitPriceNative: '', nativeCurrency: '', esppDiscountPriceNative: '', costsGbp: '', notes: '' }
    newInstForm = { ticker: '', name: '', currency: 'USD' }
    newInstError = ''
    editingInst = false
    error = ''
    view = 'add'
  }

  async function createInstrument() {
    newInstError = ''
    if (!newInstForm.ticker || !newInstForm.name || !newInstForm.currency) {
      newInstError = 'Ticker, name, and currency are required.'
      return
    }
    savingInst = true
    try {
      const res = await apiFetch('/api/instruments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker: newInstForm.ticker.toUpperCase(),
          name: newInstForm.name,
          currency: newInstForm.currency.toUpperCase(),
        }),
      })
      const data = await res.json().catch(() => ({})) as { id?: number; error?: string; message?: string }
      if (!res.ok) {
        newInstError = data.error ?? data.message ?? 'Could not create instrument.'
        return
      }
      await loadInstruments()
      form.instrumentId = data.id!
      newInstForm = { ticker: '', name: '', currency: 'USD' }
    } catch {
      newInstError = 'Network error.'
    } finally {
      savingInst = false
    }
  }

  function openEdit(txn: Transaction) {
    editingTxn = txn
    form = {
      instrumentId: txn.instrumentId,
      txnType: txn.txnType,
      txnDate: txn.txnDate,
      quantity: txn.quantity,
      unitPriceNative: txn.unitPriceNative ?? '',
      nativeCurrency: txn.nativeCurrency ?? '',
      esppDiscountPriceNative: txn.esppDiscountPriceNative ?? '',
      costsGbp: txn.costsGbp,
      notes: txn.notes ?? '',
    }
    editingInst = false
    error = ''
    view = 'edit'
  }

  function openEditInst() {
    const inst = instruments.find(i => i.id === form.instrumentId)
    if (!inst) return
    editInstForm = { ticker: inst.ticker, name: inst.name, currency: inst.currency }
    editInstError = ''
    editingInst = true
  }

  async function saveEditInst() {
    editInstError = ''
    if (!editInstForm.ticker || !editInstForm.name || !editInstForm.currency) {
      editInstError = 'Ticker, name, and currency are required.'
      return
    }
    savingEditInst = true
    try {
      const res = await apiFetch(`/api/instruments/${form.instrumentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker: editInstForm.ticker.toUpperCase(),
          name: editInstForm.name,
          currency: editInstForm.currency.toUpperCase(),
        }),
      })
      const data = await res.json().catch(() => ({})) as { error?: string; message?: string }
      if (!res.ok) {
        editInstError = data.error ?? data.message ?? 'Could not update instrument.'
        return
      }
      await loadInstruments()
      editingInst = false
    } catch {
      editInstError = 'Network error.'
    } finally {
      savingEditInst = false
    }
  }

  async function save() {
    if (form.instrumentId === 'new') {
      error = 'Create the new instrument before saving the transaction.'
      return
    }
    error = ''
    loading = true
    try {
      const body = {
        instrumentId: Number(form.instrumentId),
        txnType: form.txnType,
        txnDate: form.txnDate,
        quantity: form.quantity,
        ...(form.unitPriceNative ? { unitPriceNative: form.unitPriceNative } : {}),
        ...(form.nativeCurrency ? { nativeCurrency: form.nativeCurrency } : {}),
        ...(form.esppDiscountPriceNative ? { esppDiscountPriceNative: form.esppDiscountPriceNative } : {}),
        ...(form.costsGbp ? { costsGbp: form.costsGbp } : {}),
        ...(form.notes ? { notes: form.notes } : {}),
      }

      const url = editingTxn ? `/api/transactions/${editingTxn.id}` : '/api/transactions'
      const method = editingTxn ? 'PATCH' : 'POST'
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        error = (data as { message?: string }).message ?? 'Save failed.'
        return
      }
      await loadTransactions()
      view = 'list'
    } catch {
      error = 'Network error.'
    } finally {
      loading = false
    }
  }

  async function remove(txn: Transaction) {
    if (!confirm(`Delete ${txn.txnType} on ${txn.txnDate}?`)) return
    const res = await apiFetch(`/api/transactions/${txn.id}`, { method: 'DELETE' })
    if (res.ok) await loadTransactions()
  }

  function openImportDividends() {
    importInstrumentId = instruments.length === 1 ? instruments[0].id : ''
    importPreviewRows = []
    importInserted = 0
    importDone = false
    error = ''
    view = 'import-dividends'
  }

  async function previewDividends() {
    if (!importInstrumentId) return
    error = ''
    loading = true
    try {
      const res = await apiFetch('/api/transactions/import-dividends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrumentId: Number(importInstrumentId), commit: false }),
      })
      const data = await res.json().catch(() => ({})) as { rows?: DividendRow[]; error?: string }
      if (!res.ok) { error = data.error ?? 'Preview failed.'; return }
      importPreviewRows = data.rows ?? []
    } catch {
      error = 'Network error.'
    } finally {
      loading = false
    }
  }

  async function commitDividends() {
    if (!importInstrumentId) return
    error = ''
    loading = true
    try {
      const res = await apiFetch('/api/transactions/import-dividends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrumentId: Number(importInstrumentId), commit: true }),
      })
      const data = await res.json().catch(() => ({})) as { inserted?: number; error?: string }
      if (!res.ok) { error = data.error ?? 'Import failed.'; return }
      importInserted = data.inserted ?? 0
      importDone = true
      await loadTransactions()
    } catch {
      error = 'Network error.'
    } finally {
      loading = false
    }
  }

  function instrumentName(id: number) {
    return instruments.find(i => i.id === id)?.ticker ?? `#${id}`
  }

  function fmtGbp(val: string | null) {
    if (!val) return '—'
    if (masked) return '£••••'
    return `£${parseFloat(val).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
  }

  // Public market data — never masked
  function fmtNum(val: string | null, decimals = 4) {
    if (!val || val === '0') return '—'
    return parseFloat(val).toLocaleString('en-GB', { maximumFractionDigits: decimals })
  }

  // ── Sorting ───────────────────────────────────────────────────────────────────

  function sortVal(txn: Transaction, key: SortKey): string | number {
    switch (key) {
      case 'txnDate': return txn.txnDate
      case 'txnType': return txn.txnType
      case 'instrument': return instrumentName(txn.instrumentId)
      case 'quantity': return parseFloat(txn.quantity)
      case 'unitPriceNative': return parseFloat(txn.unitPriceNative ?? '0')
      case 'unitPriceGbp': return parseFloat(txn.unitPriceGbp ?? '0')
      case 'fxRate': return parseFloat(txn.fxRate ?? '0')
      case 'totalGbp': return parseFloat(txn.totalGbp ?? '0')
      case 'costsGbp': return parseFloat(txn.costsGbp ?? '0')
      case 'netGbp': return parseFloat(txn.netGbp ?? '0')
    }
  }

  const sorted = $derived(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...transactions].sort((a, b) => {
      const av = sortVal(a, sortKey)
      const bv = sortVal(b, sortKey)
      if (av < bv) return -dir
      if (av > bv) return dir
      return 0
    })
  })

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc'
    } else {
      sortKey = key
      sortDir = key === 'txnDate' ? 'desc' : 'asc'
    }
  }

  function sortIcon(key: SortKey) {
    if (sortKey !== key) return '⇅'
    return sortDir === 'asc' ? '↑' : '↓'
  }

  // ── Column resize ─────────────────────────────────────────────────────────────

  function onResizeStart(col: string, e: MouseEvent) {
    e.preventDefault()
    draggingCol = col
    dragStartX = e.clientX
    dragStartW = colWidths[col] ?? defaultWidths[col as keyof typeof defaultWidths] ?? 100
  }

  function onMouseMove(e: MouseEvent) {
    if (!draggingCol) return
    const delta = e.clientX - dragStartX
    colWidths = { ...colWidths, [draggingCol]: Math.max(50, dragStartW + delta) }
  }

  function onMouseUp() {
    draggingCol = null
  }
</script>

<svelte:window onmousemove={onMouseMove} onmouseup={onMouseUp} />

{#if view === 'list'}
  <div class="toolbar">
    <h2>Transactions</h2>
    <div class="toolbar-actions">
      <button type="button" class="btn-secondary" onclick={openImportDividends}>↓ Import dividends</button>
      <button type="button" class="btn-primary" onclick={openAdd}>+ Add transaction</button>
    </div>
  </div>

  {#if transactions.length === 0}
    <p class="empty">No transactions yet. Add your first trade above.</p>
  {:else}
    <div class="table-wrap">
      <table>
        <colgroup>
          {#each Object.entries(colWidths) as [col, w]}
            <col style="width:{w}px;min-width:{col === 'actions' ? 70 : 50}px" />
          {/each}
        </colgroup>
        <thead>
          <tr>
            {#each [
              { key: 'txnDate', label: 'Date' },
              { key: 'txnType', label: 'Type' },
              { key: 'instrument', label: 'Name' },
              { key: 'quantity', label: 'QTY' },
              { key: 'unitPriceNative', label: 'Price (native)' },
              { key: 'unitPriceGbp', label: 'Price (GBP)' },
              { key: 'fxRate', label: 'FX rate' },
              { key: 'totalGbp', label: 'Total GBP' },
              { key: 'costsGbp', label: 'Costs' },
              { key: 'netGbp', label: 'Net GBP' },
            ] as col}
              <th style="width:{colWidths[col.key]}px">
                <div class="th-inner">
                  <button type="button" class="sort-btn" onclick={() => toggleSort(col.key as SortKey)}>
                    {col.label} <span class="sort-icon">{sortIcon(col.key as SortKey)}</span>
                  </button>
                  {#if COL_TIPS[col.key]}
                    <span class="tip" title={COL_TIPS[col.key]}>?</span>
                  {/if}
                  <button
                    type="button"
                    class="resize-handle"
                    onmousedown={(e) => onResizeStart(col.key, e)}
                    aria-label="Resize {col.label} column"
                  ></button>
                </div>
              </th>
            {/each}
            <th style="width:{colWidths['actions']}px"><div class="th-inner"></div></th>
          </tr>
        </thead>
        <tbody>
          {#each sorted() as txn (txn.id)}
            <tr>
              <td>{txn.txnDate}</td>
              <td><span class="badge badge-{txn.txnType.toLowerCase()}">{txn.txnType}</span></td>
              <td>{instrumentName(txn.instrumentId)}</td>
              <td class="num">{masked ? '••••' : parseFloat(txn.quantity).toLocaleString('en-GB')}</td>
              <td class="num">{txn.unitPriceNative ? `${txn.nativeCurrency ?? ''} ${parseFloat(txn.unitPriceNative).toLocaleString('en-GB', { minimumFractionDigits: 2 })}` : '—'}</td>
              <td class="num">{txn.unitPriceGbp ? `£${parseFloat(txn.unitPriceGbp).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : '—'}</td>
              <td class="num">
                {txn.fxRate ? fmtNum(txn.fxRate) : '—'}
                {#if txn.fxRateType && txn.fxRateType !== 'hmrc-monthly'}
                  <span class="fx-badge" title="Rate type: {txn.fxRateType}{txn.fxRateSource ? ` (${txn.fxRateSource})` : ''}">{txn.fxRateType === 'daily-spot' ? 'spot' : txn.fxRateType}</span>
                {/if}
              </td>
              <td class="num">{fmtGbp(txn.totalGbp)}</td>
              <td class="num">{txn.costsGbp !== '0' ? fmtGbp(txn.costsGbp) : '—'}</td>
              <td class="num" class:negative={txn.netGbp?.startsWith('-')}>{fmtGbp(txn.netGbp)}</td>
              <td class="actions">
                <button type="button" class="btn-link" onclick={() => openEdit(txn)}>Edit</button>
                <button type="button" class="btn-link danger" onclick={() => remove(txn)}>Del</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

{:else if view === 'import-dividends'}
  <div class="form-header">
    <button type="button" class="btn-link" onclick={() => view = 'list'}>← Back</button>
    <h2>Import dividend history</h2>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if importDone}
    <div class="success">
      Imported {importInserted} DIV_PAY transaction{importInserted !== 1 ? 's' : ''}.
      GBP values are being computed — refresh in a moment.
    </div>
    <button type="button" class="btn-primary" onclick={() => view = 'list'}>Back to transactions</button>
  {:else}
    <div class="import-form">
      <label>
        Instrument
        <select bind:value={importInstrumentId} onchange={previewDividends}>
          <option value="">— select —</option>
          {#each instruments as inst (inst.id)}
            <option value={inst.id}>{inst.ticker}</option>
          {/each}
        </select>
      </label>
    </div>

    {#if loading}
      <p class="hint">Fetching from Alpha Vantage…</p>
    {:else if importPreviewRows.length > 0}
      {@const toInsert = importPreviewRows.filter(r => r.skipReason === null)}
      {@const skipped = importPreviewRows.filter(r => r.skipReason !== null)}

      <p class="preview-summary">
        <strong>{toInsert.length}</strong> rows to import,
        <strong>{skipped.length}</strong> skipped
      </p>

      {#if toInsert.length > 0}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ex-date</th>
                <th>Payment date</th>
                <th class="num">Per share</th>
                <th class="num">Shares held</th>
              </tr>
            </thead>
            <tbody>
              {#each toInsert as row}
                <tr>
                  <td>{row.exDate}</td>
                  <td>
                    {row.paymentDate}
                    {#if row.paymentDateEstimated}
                      <span class="badge-warn" title="Payment date not available from provider; estimated as ex-date + 30 days">est.</span>
                    {/if}
                  </td>
                  <td class="num">{parseFloat(row.amountPerShare).toFixed(4)}</td>
                  <td class="num">{parseFloat(row.quantity).toLocaleString('en-GB')}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <div class="form-actions" style="margin-top: 1rem">
          <button type="button" onclick={() => view = 'list'}>Cancel</button>
          <button type="button" class="btn-primary" onclick={commitDividends} disabled={loading}>
            {loading ? 'Importing…' : `Import ${toInsert.length} rows`}
          </button>
        </div>
      {/if}

      {#if skipped.length > 0}
        <details class="skipped-details">
          <summary>{skipped.length} skipped</summary>
          <table>
            <thead><tr><th>Ex-date</th><th>Payment date</th><th>Reason</th></tr></thead>
            <tbody>
              {#each skipped as row}
                <tr>
                  <td>{row.exDate}</td>
                  <td>{row.paymentDate}</td>
                  <td class="skip-reason">{row.skipReason}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </details>
      {/if}
    {/if}
  {/if}

{:else}
  <div class="form-header">
    <button type="button" class="btn-link" onclick={() => view = 'list'}>← Back</button>
    <h2>{view === 'add' ? 'Add transaction' : 'Edit transaction'}</h2>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <form onsubmit={(e) => { e.preventDefault(); save() }} class="txn-form">
    <div class="row">
      <label>
        Instrument *
        <select bind:value={form.instrumentId} onchange={() => editingInst = false} required>
          <option value="">— select —</option>
          {#each instruments as inst (inst.id)}
            <option value={inst.id}>{inst.ticker} — {inst.name}</option>
          {/each}
          <option value="new">＋ Add new instrument…</option>
        </select>
        {#if form.instrumentId && form.instrumentId !== 'new'}
          <button type="button" class="btn-link edit-inst-btn" onclick={openEditInst} title="Edit ticker, name or currency">✎ Edit instrument</button>
        {/if}
      </label>

      <label>
        Type *
        <select bind:value={form.txnType} required>
          <option value="">— select —</option>
          {#each TXN_TYPES as t}
            <option value={t}>{t}</option>
          {/each}
        </select>
      </label>

      <label>
        Date *
        <input type="date" bind:value={form.txnDate} required />
      </label>
    </div>

    {#if editingInst && form.instrumentId && form.instrumentId !== 'new'}
      <div class="new-inst-panel edit-inst-panel">
        <p class="new-inst-title">Edit instrument</p>
        {#if editInstError}
          <div class="error" style="margin-bottom:.5rem">{editInstError}</div>
        {/if}
        <div class="row">
          <label>
            Ticker *
            <input type="text" bind:value={editInstForm.ticker} maxlength="32" style="text-transform:uppercase" />
          </label>
          <label class="wide">
            Name *
            <input type="text" bind:value={editInstForm.name} />
          </label>
          <label>
            Currency *
            <input type="text" bind:value={editInstForm.currency} maxlength="3" class="narrow" style="text-transform:uppercase" />
          </label>
        </div>
        <div style="display:flex;gap:.5rem">
          <button type="button" class="btn-primary" onclick={saveEditInst} disabled={savingEditInst}>
            {savingEditInst ? 'Saving…' : 'Save instrument'}
          </button>
          <button type="button" onclick={() => editingInst = false}>Cancel</button>
        </div>
      </div>
    {/if}

    {#if form.instrumentId === 'new'}
      <div class="new-inst-panel">
        <p class="new-inst-title">New instrument</p>
        {#if newInstError}
          <div class="error" style="margin-bottom:.5rem">{newInstError}</div>
        {/if}
        <div class="row">
          <label>
            Ticker *
            <input type="text" bind:value={newInstForm.ticker} placeholder="e.g. CSCO" maxlength="32" style="text-transform:uppercase" />
          </label>
          <label class="wide">
            Name *
            <input type="text" bind:value={newInstForm.name} placeholder="e.g. Cisco Systems" />
          </label>
          <label>
            Currency *
            <input type="text" bind:value={newInstForm.currency} placeholder="USD" maxlength="3" class="narrow" style="text-transform:uppercase" />
          </label>
        </div>
        <button type="button" class="btn-primary" onclick={createInstrument} disabled={savingInst}>
          {savingInst ? 'Creating…' : 'Create instrument'}
        </button>
      </div>
    {/if}

    <div class="row">
      <label>
        Quantity *
        <input type="text" bind:value={form.quantity} placeholder="e.g. 100 or 12.5" required pattern="^\d+(\.\d+)?$" />
      </label>

      <label>
        {form.txnType === 'ESPP_PURCHASE' ? 'Market value (native)' : 'Price (native currency)'}
        <input type="text" bind:value={form.unitPriceNative} placeholder="e.g. 195.50" pattern="^\d+(\.\d+)?$" />
      </label>

      {#if form.txnType === 'ESPP_PURCHASE'}
        <label>
          Discounted purchase price
          <input type="text" bind:value={form.esppDiscountPriceNative} placeholder="e.g. 166.18" pattern="^\d+(\.\d+)?$" />
        </label>
      {/if}

      <label>
        Currency
        <input type="text" bind:value={form.nativeCurrency} placeholder="USD" maxlength="3" class="narrow" />
      </label>
    </div>

    {#if form.txnType === 'ESPP_PURCHASE'}
      <p class="hint espp-hint">Market value = share price on purchase date. Discounted price = what you actually paid. The ESPP gain (discount) is computed automatically as employment income.</p>
    {/if}

    <div class="row">
      <label>
        Costs (GBP)
        <input type="text" bind:value={form.costsGbp} placeholder="0" pattern="^\d+(\.\d+)?$" />
      </label>

      <label class="wide">
        Notes
        <input type="text" bind:value={form.notes} placeholder="optional" />
      </label>
    </div>

    <p class="hint">FX rate and GBP values are computed automatically using the configured FX policy.</p>

    <div class="form-actions">
      <button type="button" onclick={() => view = 'list'}>Cancel</button>
      <button type="submit" class="btn-primary" disabled={loading}>
        {loading ? 'Saving…' : view === 'add' ? 'Add transaction' : 'Save changes'}
      </button>
    </div>
  </form>
{/if}

<style>
  h2 { margin-top: 0; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
  .toolbar-actions { display: flex; gap: .5rem; align-items: center; }
  .empty { color: var(--text-muted); }

  .btn-secondary { background: var(--surface); color: var(--accent); border: 1px solid var(--accent); padding: .5rem 1rem; border-radius: 4px; cursor: pointer; font-size: .9rem; }
  .btn-secondary:hover { background: var(--accent-bg); }
  .import-form { margin-bottom: 1.25rem; }
  .import-form label { display: flex; flex-direction: column; gap: .25rem; font-weight: 500; font-size: .9rem; max-width: 260px; }
  .import-form select { padding: .4rem .6rem; border: 1px solid var(--border-strong); border-radius: 4px; font-size: .9rem; background: var(--surface); color: var(--text); }

  .preview-summary { margin: 1rem 0 .5rem; font-size: .9rem; }
  .badge-warn { background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning); border-radius: 3px; font-size: .7rem; padding: .1rem .3rem; margin-left: .25rem; cursor: help; }

  .skipped-details { margin-top: 1rem; font-size: .85rem; color: var(--text-muted); }
  .skipped-details summary { cursor: pointer; margin-bottom: .5rem; }
  .skip-reason { font-style: italic; }

  .success {
    background: var(--success-bg-alt); border: 1px solid var(--success-border); border-radius: 4px;
    color: var(--success-text);
    padding: .75rem; margin-bottom: 1rem; font-size: .875rem;
  }

  /* ── Table ── */
  .table-wrap { overflow-x: auto; overflow-y: auto; max-height: calc(100vh - 160px); user-select: none; }
  table { border-collapse: collapse; font-size: .875rem; table-layout: fixed; min-width: 100%; }
  th, td { padding: .5rem .75rem; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  th { font-weight: 600; color: var(--text-secondary); background: var(--bg); position: sticky; top: 0; z-index: 1; padding: 0; }

  .fx-badge {
    display: inline-block; margin-left: .3rem; padding: .1rem .3rem;
    font-size: .65rem; font-weight: 600; border-radius: 3px;
    background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning);
    cursor: help; vertical-align: middle;
  }
  .num { text-align: right; }
  .negative { color: var(--danger); }

  /* ── Column header ── */
  .th-inner { display: flex; align-items: center; padding: .5rem .35rem .5rem .75rem; gap: .2rem; }
  .sort-btn {
    background: none; border: none; padding: 0; cursor: pointer;
    font-size: .875rem; font-weight: 600; color: var(--text-secondary); text-align: left;
    white-space: nowrap; flex: 1; min-width: 0;
  }
  .sort-btn:hover { color: var(--accent); }
  .sort-icon { color: var(--text-faint); font-size: .75rem; }

  /* Column tooltip */
  .tip {
    display: inline-flex; align-items: center; justify-content: center;
    width: 14px; height: 14px; border-radius: 50%; background: var(--border);
    color: var(--text-secondary); font-size: .65rem; font-weight: 700; cursor: help;
    flex-shrink: 0;
  }

  /* Resize handle */
  .resize-handle {
    width: 6px; height: 100%; cursor: col-resize;
    position: relative; right: 0; flex-shrink: 0;
    border: none; background: none; padding: 0;
    border-right: 2px solid transparent;
  }
  .resize-handle:hover, .resize-handle:active { border-right-color: var(--accent); }
  .resize-handle:focus { outline: none; }

  .badge {
    display: inline-block; padding: .125rem .4rem; border-radius: 3px;
    font-size: .75rem; font-weight: 600; background: var(--surface-alt); color: var(--text-secondary);
  }
  .badge-buy, .badge-rsu_vest, .badge-espp_purchase, .badge-transfer_in, .badge-drip { background: var(--info-bg); color: var(--info-text); }
  .badge-sell, .badge-transfer_out { background: var(--danger-bg); color: var(--danger-text); }
  .badge-div_pay { background: var(--success-bg); color: var(--success-text); }

  .actions { display: flex; gap: .5rem; }
  .btn-link { background: none; border: none; color: var(--accent); cursor: pointer; padding: 0; font-size: inherit; }
  .btn-link.danger { color: var(--danger); }
  .btn-primary { background: var(--accent); color: var(--on-accent); border: none; padding: .5rem 1rem; border-radius: 4px; cursor: pointer; font-size: .9rem; }
  button:disabled { opacity: .65; cursor: not-allowed; }

  .edit-inst-btn { font-size: .78rem; margin-top: .2rem; text-align: left; }

  .new-inst-panel {
    background: var(--accent-bg); border: 1px solid var(--accent-border); border-radius: 6px;
    padding: .75rem 1rem 1rem; margin-bottom: 1rem;
  }
  .edit-inst-panel { background: var(--warning-bg); border-color: var(--warning); }
  .edit-inst-panel .new-inst-title { color: var(--warning-text-alt); }
  .new-inst-title { margin: 0 0 .6rem; font-size: .875rem; font-weight: 600; color: var(--accent-text); }

  .form-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; }
  .txn-form { max-width: 700px; }
  .row { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
  label { display: flex; flex-direction: column; gap: .25rem; font-weight: 500; font-size: .9rem; flex: 1; min-width: 140px; }
  label.wide { flex: 2; }
  input, select { padding: .4rem .6rem; border: 1px solid var(--border-strong); border-radius: 4px; font-size: .9rem; background: var(--surface); color: var(--text); }
  .narrow { max-width: 80px; }
  .hint { color: var(--text-muted); font-size: .8rem; margin: .25rem 0 1rem; }
  .espp-hint { background: var(--info-bg-alt); border-left: 3px solid var(--accent); padding: .4rem .6rem; border-radius: 0 4px 4px 0; color: var(--info-text-alt); }
  .form-actions { display: flex; gap: .75rem; }
  .error {
    background: var(--danger-bg); border: 1px solid var(--danger-bg-alt); color: var(--danger-text); border-radius: 4px;
    padding: .75rem; margin-bottom: 1rem; font-size: .875rem;
  }
</style>

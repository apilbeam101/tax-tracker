<script lang="ts">
  import { onMount } from 'svelte'
  import { apiFetch } from '../lib/api.ts'

  type Tab = 'import' | 'export'
  let tab: Tab = $state('import')

  // ── Instruments ─────────────────────────────────────────────────────────────
  interface Instrument { id: number; ticker: string; currency: string }
  let instruments: Instrument[] = $state([])

  onMount(async () => {
    const res = await fetch('/api/instruments')
    if (res.ok) instruments = await res.json()
  })

  // ── Import ───────────────────────────────────────────────────────────────────

  interface ColumnMapping {
    source: string | number
    target: string
    transform?: object
  }

  interface MappedRow {
    index: number
    txnType: string | null
    txnDate: string | null
    quantity: string | null
    unitPriceNative: string | null
    nativeCurrency: string | null
    costsGbp: string | null
    notes: string | null
    errors: string[]
  }

  const MAPPABLE_FIELDS = [
    'ticker', 'txnType', 'txnDate', 'quantity',
    'unitPriceNative', 'nativeCurrency', 'costsGbp', 'notes',
  ]

  let importInstrumentId: number | '' = $state('')
  // Whether the mapping includes a ticker column (controls whether instrument selector is required)
  let hasTicker = $derived(mappingRows.some(r => r.target === 'ticker'))
  let csvText = $state('')
  let hasHeader = $state(true)
  let csvHeaders: string[] = $state([])

  // One mapping row per target field the user wants to map
  let mappingRows: { source: string; target: string }[] = $state([
    { source: '', target: 'txnType' },
    { source: '', target: 'txnDate' },
    { source: '', target: 'quantity' },
    { source: '', target: 'unitPriceNative' },
  ])

  let previewRows: MappedRow[] = $state([])
  let validCount = $state(0)
  let importLoading = $state(false)
  let importError = $state('')
  let importSuccess = $state('')

  function parseCsvHeaders(text: string): string[] {
    if (!text.trim()) return []
    const firstLine = text.split('\n')[0] ?? ''
    return firstLine.split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  }

  function onCsvChange() {
    csvHeaders = hasHeader ? parseCsvHeaders(csvText) : []
    previewRows = []
    validCount = 0
    importError = ''
    importSuccess = ''
  }

  function addMappingRow() {
    mappingRows = [...mappingRows, { source: '', target: MAPPABLE_FIELDS[0]! }]
  }

  function removeMappingRow(i: number) {
    mappingRows = mappingRows.filter((_, idx) => idx !== i)
  }

  function buildMappings(): ColumnMapping[] {
    return mappingRows
      .filter(r => r.source !== '')
      .map(r => ({
        source: /^\d+$/.test(r.source) ? parseInt(r.source, 10) : r.source,
        target: r.target,
      }))
  }

  async function preview() {
    importError = ''
    importSuccess = ''
    if (!csvText.trim()) { importError = 'Paste CSV text first.'; return }
    importLoading = true
    try {
      const res = await apiFetch('/api/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csvText, mappings: buildMappings(), hasHeader }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        importError = d.error ?? 'Preview failed.'
        return
      }
      const data = await res.json() as { rows: MappedRow[]; validCount: number }
      previewRows = data.rows.slice(0, 50) // show first 50
      validCount = data.validCount
    } catch (err) {
      importError = (err as Error).message
    } finally {
      importLoading = false
    }
  }

  async function commit() {
    importError = ''
    importSuccess = ''
    if (!hasTicker && !importInstrumentId) { importError = 'Select a default instrument or map a ticker column.'; return }
    importLoading = true
    try {
      const res = await apiFetch('/api/import/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csvText,
          mappings: buildMappings(),
          ...(importInstrumentId ? { instrumentId: Number(importInstrumentId) } : {}),
          hasHeader,
        }),
      })
      const data = await res.json() as { inserted?: number; errors?: {index:number;error:string}[]; error?: string }
      if (!res.ok) { importError = data.error ?? 'Import failed.'; return }
      importSuccess = `Imported ${data.inserted} transaction${data.inserted === 1 ? '' : 's'}.`
      if (data.errors && data.errors.length > 0) {
        importSuccess += ` (${data.errors.length} rows failed — see console for details.)`
        console.warn('Import row errors:', data.errors)
      }
      previewRows = []
    } catch (err) {
      importError = (err as Error).message
    } finally {
      importLoading = false
    }
  }

  // ── Export ───────────────────────────────────────────────────────────────────

  let exportFormat = $state('csv')
  let exportSection = $state('transactions')
  let exportInstrumentId = $state('')
  let exportTaxYear = $state('')
  let exportIncome = $state('0')

  function buildExportUrl(): string {
    if (exportSection === 'transactions') {
      const p = new URLSearchParams({ format: exportFormat })
      if (exportInstrumentId) p.set('instrumentId', exportInstrumentId)
      return `/api/export/transactions?${p}`
    }
    if (exportSection === 'disposals') {
      const p = new URLSearchParams()
      if (exportTaxYear) p.set('taxYear', exportTaxYear)
      if (exportInstrumentId) p.set('instrumentId', exportInstrumentId)
      return `/api/export/disposals?${p}`
    }
    // report
    const p = new URLSearchParams()
    if (exportTaxYear) p.set('taxYear', exportTaxYear)
    if (exportIncome) p.set('income', exportIncome)
    return `/api/export/report?${p}`
  }

  function downloadExport() {
    window.location.href = buildExportUrl()
  }
</script>

<div class="page">
  <h2>Import / Export</h2>

  <div class="tabs">
    <button class:active={tab === 'import'} onclick={() => tab = 'import'}>Import CSV</button>
    <button class:active={tab === 'export'} onclick={() => tab = 'export'}>Export</button>
  </div>

  <!-- ── Import ──────────────────────────────────────────────────────────────── -->
  {#if tab === 'import'}
    <section>
      <p class="hint">
        Paste CSV text, configure the column mapping, preview the rows, then commit.
        Run the tax engine after importing to recalculate CGT.
      </p>

      <div class="row">
        <label>
          Default instrument {hasTicker ? '(optional — ticker column mapped)' : '(required)'}
          <select bind:value={importInstrumentId}>
            <option value="">— auto-detect from ticker —</option>
            {#each instruments as inst}
              <option value={inst.id}>{inst.ticker} ({inst.currency})</option>
            {/each}
          </select>
        </label>
        <label class="checkbox">
          <input type="checkbox" bind:checked={hasHeader} onchange={onCsvChange} />
          First row is a header
        </label>
      </div>
      {#if !hasTicker}
        <p class="hint">Map a <strong>ticker</strong> column to import a multi-instrument CSV, or select a default instrument above.</p>
      {/if}

      <label>
        CSV data
        <textarea
          rows="8"
          placeholder="Paste CSV here…"
          bind:value={csvText}
          oninput={onCsvChange}
        ></textarea>
      </label>

      <!-- Column mapping -->
      <div class="mapping-section">
        <h4>Column mapping</h4>
        <p class="hint">For each field, enter the column header name (if CSV has a header row) or the 0-based column index.</p>
        <table class="mapping-table">
          <thead>
            <tr>
              <th>CSV column (header or index)</th>
              <th>Maps to field</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each mappingRows as row, i}
              <tr>
                <td>
                  {#if csvHeaders.length > 0}
                    <select bind:value={row.source}>
                      <option value="">— pick column —</option>
                      {#each csvHeaders as h, hi}
                        <option value={h}>{h} (col {hi})</option>
                      {/each}
                    </select>
                  {:else}
                    <input
                      type="text"
                      placeholder="header name or 0-based index"
                      bind:value={row.source}
                    />
                  {/if}
                </td>
                <td>
                  <select bind:value={row.target}>
                    {#each MAPPABLE_FIELDS as f}
                      <option value={f}>{f}</option>
                    {/each}
                  </select>
                </td>
                <td>
                  <button class="btn-link" onclick={() => removeMappingRow(i)}>✕</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <button class="btn-secondary" onclick={addMappingRow}>+ Add column</button>
      </div>

      {#if importError}
        <div class="error">{importError}</div>
      {/if}
      {#if importSuccess}
        <div class="success">{importSuccess}</div>
      {/if}

      <div class="actions">
        <button onclick={preview} disabled={importLoading}>Preview</button>
        <button onclick={commit} disabled={importLoading || validCount === 0} class="btn-primary">
          Import {validCount > 0 ? `${validCount} rows` : ''}
        </button>
      </div>

      <!-- Preview table -->
      {#if previewRows.length > 0}
        <div class="preview-section">
          <h4>Preview (first {previewRows.length} rows, {validCount} valid)</h4>
          <div class="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>ticker</th>
                  <th>txnType</th>
                  <th>txnDate</th>
                  <th>quantity</th>
                  <th>unitPriceNative</th>
                  <th>currency</th>
                  <th>costsGbp</th>
                  <th>notes</th>
                  <th>errors</th>
                </tr>
              </thead>
              <tbody>
                {#each previewRows as r}
                  <tr class:invalid={r.errors.length > 0}>
                    <td>{r.index + 1}</td>
                    <td>{r.ticker ?? ''}</td>
                    <td>{r.txnType ?? ''}</td>
                    <td>{r.txnDate ?? ''}</td>
                    <td>{r.quantity ?? ''}</td>
                    <td>{r.unitPriceNative ?? ''}</td>
                    <td>{r.nativeCurrency ?? ''}</td>
                    <td>{r.costsGbp ?? ''}</td>
                    <td class="notes-cell">{r.notes ?? ''}</td>
                    <td class="error-cell">{r.errors.join('; ')}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {/if}
    </section>
  {/if}

  <!-- ── Export ──────────────────────────────────────────────────────────────── -->
  {#if tab === 'export'}
    <section>
      <div class="export-grid">
        <label>
          Export type
          <select bind:value={exportSection}>
            <option value="transactions">Transactions</option>
            <option value="disposals">CGT Disposals</option>
            <option value="report">Annual PDF Report</option>
          </select>
        </label>

        {#if exportSection === 'transactions'}
          <label>
            Format
            <select bind:value={exportFormat}>
              <option value="csv">CSV (all fields)</option>
              <option value="cgtcalculator">cgtcalculator.com</option>
            </select>
          </label>
        {/if}

        {#if exportSection !== 'report'}
          <label>
            Instrument (optional)
            <select bind:value={exportInstrumentId}>
              <option value="">All instruments</option>
              {#each instruments as inst}
                <option value={inst.id}>{inst.ticker}</option>
              {/each}
            </select>
          </label>
        {/if}

        {#if exportSection === 'disposals' || exportSection === 'report'}
          <label>
            Tax year (optional)
            <input type="text" placeholder="e.g. 2025-26" bind:value={exportTaxYear} />
          </label>
        {/if}

        {#if exportSection === 'report'}
          <label>
            Annual income (£, for CGT rate band)
            <input type="number" min="0" step="1" bind:value={exportIncome} />
          </label>
        {/if}
      </div>

      <div class="actions">
        <button class="btn-primary" onclick={downloadExport}>
          {exportSection === 'report' ? 'Download PDF' : 'Download'}
        </button>
      </div>

    </section>
  {/if}
</div>

<style>
  .page { padding: 1.5rem; max-width: 900px; }
  h2 { margin-bottom: 1rem; }
  h4 { margin: 1rem 0 0.5rem; }

  .tabs { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; border-bottom: 1px solid var(--border); }
  .tabs button { padding: 0.5rem 1rem; border: none; background: none; cursor: pointer; border-bottom: 2px solid transparent; color: var(--text); }
  .tabs button.active { border-bottom-color: var(--link); font-weight: 600; color: var(--link); }

  section { display: flex; flex-direction: column; gap: 1rem; }

  .hint { color: var(--text-muted); font-size: 0.875rem; margin: 0; }

  .row { display: flex; gap: 1.5rem; align-items: flex-end; flex-wrap: wrap; }

  label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.875rem; font-weight: 600; }
  label.checkbox { flex-direction: row; align-items: center; gap: 0.5rem; font-weight: normal; margin-bottom: 0.25rem; }

  input[type="text"],
  input[type="number"],
  select,
  textarea {
    font-size: 0.875rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font-family: inherit;
    background: var(--surface);
    color: var(--text);
  }
  textarea { resize: vertical; width: 100%; box-sizing: border-box; }

  .mapping-section { background: var(--surface-alt); padding: 1rem; border-radius: 6px; }
  .mapping-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .mapping-table th { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border); font-weight: 600; }
  .mapping-table td { padding: 0.3rem 0.5rem; }
  .mapping-table select, .mapping-table input { width: 100%; }

  .btn-link { background: none; border: none; cursor: pointer; color: var(--loss); font-size: 0.85rem; padding: 0 0.3rem; }
  .btn-secondary { margin-top: 0.5rem; font-size: 0.8rem; padding: 0.3rem 0.8rem; border: 1px solid var(--text-faint); background: var(--surface); color: var(--text); border-radius: 4px; cursor: pointer; }

  .error { color: var(--danger-text); background: var(--danger-bg); padding: 0.5rem 0.75rem; border-radius: 4px; font-size: 0.875rem; }
  .success { color: var(--success-text); background: var(--success-bg); padding: 0.5rem 0.75rem; border-radius: 4px; font-size: 0.875rem; }

  .actions { display: flex; gap: 0.75rem; }
  button { padding: 0.5rem 1.25rem; border: 1px solid var(--text-faint); border-radius: 4px; cursor: pointer; background: var(--surface); color: var(--text); font-size: 0.875rem; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--link); color: var(--on-accent); border-color: var(--link); }
  .btn-primary:hover:not(:disabled) { background: var(--link-hover); }

  .preview-section { overflow: hidden; }
  .scroll-x { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th { background: var(--surface-alt); padding: 0.4rem 0.6rem; text-align: left; border-bottom: 2px solid var(--border); white-space: nowrap; }
  td { padding: 0.3rem 0.6rem; border-bottom: 1px solid var(--border); }
  tr.invalid td { background: var(--danger-bg); }
  .error-cell { color: var(--loss); font-size: 0.8rem; }
  .notes-cell { max-width: 160px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .export-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }
</style>

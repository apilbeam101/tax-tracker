<script lang="ts">
  import { onMount } from 'svelte'
  import { apiFetch } from '../lib/api.ts'

  interface Backup { name: string; bytes: number; createdAt: string; reason: string }
  interface PlaintextCopy { name: string; location: 'backups' | 'data'; bytes: number }

  let { oncopies }: { oncopies?: (count: number) => void } = $props()

  let backups: Backup[] = $state([])
  let plaintextCopies: PlaintextCopy[] = $state([])
  let unreadableCopies: PlaintextCopy[] = $state([])
  let selectedCopies: string[] = $state([])
  let restorePending = $state(false)
  let message = $state('')
  let error = $state('')
  let busy = $state(false)

  async function problem(res: Response): Promise<string> {
    const body = await res.json().catch(() => ({}))
    return body.message ?? `Request failed (${res.status})`
  }

  async function load() {
    const res = await apiFetch('/api/backup')
    if (res.ok) {
      const body = await res.json()
      backups = body.backups
      restorePending = body.restorePending
      plaintextCopies = body.plaintextCopies ?? []
      unreadableCopies = body.unreadableCopies ?? []
      selectedCopies = []
      oncopies?.(plaintextCopies.length)
    }
  }

  const copyKey = (c: PlaintextCopy) => `${c.location}/${c.name}`

  async function deleteCopies() {
    reset()
    const chosen = plaintextCopies.filter((c) => selectedCopies.includes(copyKey(c)))
    if (chosen.length === 0) return
    if (!confirm(`Permanently delete ${chosen.length} unencrypted ${chosen.length === 1 ? 'copy' : 'copies'}? This cannot be undone.`)) return
    busy = true
    try {
      const res = await apiFetch('/api/backup/plaintext-copies/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ copies: chosen.map(({ name, location }) => ({ name, location })) }),
      })
      if (!res.ok) {
        error = await problem(res)
      } else {
        const { removed } = await res.json()
        message = removed > 0 ? `Deleted ${removed}.` : 'Nothing was deleted: those files are no longer listed.'
      }
      await load()
    } finally {
      busy = false
    }
  }

  onMount(load)

  function reset() {
    message = ''
    error = ''
  }

  async function createBackup() {
    reset()
    busy = true
    try {
      const res = await apiFetch('/api/backup', { method: 'POST' })
      if (!res.ok) error = await problem(res)
      else message = 'Backup created.'
      await load()
    } finally {
      busy = false
    }
  }

  let restoreFile: FileList | null = $state(null)

  async function stageRestore() {
    reset()
    const file = restoreFile?.[0]
    if (!file) return
    if (!confirm('This stages the file to replace your current database the next time the app starts. Your current database is backed up first. Continue?')) return
    busy = true
    try {
      const res = await apiFetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      if (!res.ok) {
        error = await problem(res)
      } else {
        const staged = await res.json()
        const keys = staged.sameKeys === false
          ? ' This backup comes from a different installation, so it will ask for that installation\'s passphrase or recovery key, not the one you use now.'
          : ' It will then ask for the passphrase (or recovery key) that belongs to that backup.'
        message = staged.restarting
          ? `Backup staged. The app is restarting to apply it; sign in again in a moment.${keys}`
          : `Backup staged. Restart the app to apply it. Anything you change before then is discarded.${keys}`
      }
      await load()
    } finally {
      busy = false
    }
  }

  async function cancelRestore() {
    reset()
    const res = await apiFetch('/api/backup/restore', { method: 'DELETE' })
    if (!res.ok) error = await problem(res)
    await load()
  }

  function size(bytes: number): string {
    return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
  }

  // ── Archive ──────────────────────────────────────────────────────────────────
  let exportPassphrase = $state('')
  let exportPlaintext = $state(false)
  let archiveError = $state('')
  let archiveMessage = $state('')

  async function exportArchive() {
    archiveError = ''
    archiveMessage = ''
    if (exportPlaintext && !confirm('The archive will contain your data unencrypted. Anyone with the file can read it. Continue?')) return
    busy = true
    try {
      const res = await apiFetch('/api/export/archive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          exportPlaintext
            ? { plaintext: true, confirmPlaintext: true }
            : { passphrase: exportPassphrase },
        ),
      })
      if (!res.ok) {
        archiveError = await problem(res)
        return
      }
      const url = URL.createObjectURL(await res.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `tax-tracker-archive-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      exportPassphrase = ''
      archiveMessage = 'Archive downloaded.'
    } finally {
      busy = false
    }
  }

  let importFile: FileList | null = $state(null)
  let importPassphrase = $state('')
  let importMode: 'into-empty' | 'replace' = $state('into-empty')

  async function importArchive() {
    archiveError = ''
    archiveMessage = ''
    const file = importFile?.[0]
    if (!file) return
    if (importMode === 'replace' && !confirm('This deletes your current instruments and transactions and loads the archive instead. A backup is taken first. Continue?')) return
    busy = true
    try {
      const res = await apiFetch('/api/import/archive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          archive: await file.text(),
          mode: importMode,
          ...(importPassphrase ? { passphrase: importPassphrase } : {}),
          ...(importMode === 'replace' ? { confirmReplace: true } : {}),
        }),
      })
      if (!res.ok) {
        archiveError = await problem(res)
        return
      }
      const s = await res.json()
      archiveMessage = `Imported ${s.instruments} instruments, ${s.transactions} transactions, ${s.vestSchedule} scheduled vests and ${s.prices} prices. CGT was recalculated.`
      importPassphrase = ''
      await load()
    } finally {
      busy = false
    }
  }
</script>

<section>
  <h3>Backups</h3>
  <p class="hint">
    A backup is a snapshot of the whole database, including your encryption key slots. Restoring one
    needs the passphrase or recovery key that belongs to it. Backups are also taken automatically before
    an update changes the database, and (when enabled) once a day.
  </p>

  {#if error}<p class="error">{error}</p>{/if}
  {#if message}<p class="success">{message}</p>{/if}

  {#if plaintextCopies.length > 0}
    <div class="warning">
      <strong>Unencrypted copies of your data are still on disk.</strong>
      These files were made before your data was encrypted (or by another tool) and can be read by
      anyone who gets them. Delete the ones you no longer need.
      <ul>
        {#each plaintextCopies as c (copyKey(c))}
          <li>
            <label class="checkbox">
              <input type="checkbox" bind:group={selectedCopies} value={copyKey(c)} />
              {c.name} ({c.location === 'backups' ? 'backups folder' : 'data folder'}, {size(c.bytes)})
            </label>
          </li>
        {/each}
      </ul>
      <button onclick={deleteCopies} disabled={busy || selectedCopies.length === 0}>Delete selected</button>
    </div>
  {/if}

  {#if unreadableCopies.length > 0}
    <p class="hint">
      These files could not be opened to check them, so they are not offered for deletion (they may be
      encrypted but damaged): {unreadableCopies.map((c) => c.name).join(', ')}
    </p>
  {/if}

  <div class="actions">
    <button class="btn-primary" onclick={createBackup} disabled={busy}>Create backup now</button>
  </div>

  {#if backups.length > 0}
    <table>
      <thead><tr><th>Created</th><th>Reason</th><th>Size</th><th></th></tr></thead>
      <tbody>
        {#each backups as b (b.name)}
          <tr>
            <td>{new Date(b.createdAt).toLocaleString()}</td>
            <td>{b.reason}</td>
            <td>{size(b.bytes)}</td>
            <td><a href={`/api/backup/${encodeURIComponent(b.name)}`} download>Download</a></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="hint">No backups yet.</p>
  {/if}

  <h4>Restore from a backup file</h4>
  {#if restorePending}
    <p class="success">
      A restore is staged and will be applied the next time the app starts.
      <button onclick={cancelRestore}>Cancel it</button>
    </p>
  {/if}
  <div class="row">
    <input type="file" accept=".db" bind:files={restoreFile} />
    <button onclick={stageRestore} disabled={busy || !restoreFile?.length}>Stage restore</button>
  </div>
</section>

<section>
  <h3>Archive (export and import)</h3>
  <p class="hint">
    An archive is a portable JSON copy of your instruments, transactions, scheduled vests, tax year
    settings, exchange rates and cached prices. It is encrypted with an export passphrase you choose, which
    is separate from your login passphrase. It is meant for moving between installs, not for disaster recovery.
  </p>

  {#if archiveError}<p class="error">{archiveError}</p>{/if}
  {#if archiveMessage}<p class="success">{archiveMessage}</p>{/if}

  <h4>Export</h4>
  <div class="row">
    {#if !exportPlaintext}
      <label>
        Export passphrase (12 characters or more)
        <input type="password" autocomplete="new-password" bind:value={exportPassphrase} />
      </label>
    {/if}
    <label class="checkbox">
      <input type="checkbox" bind:checked={exportPlaintext} />
      Export without encryption
    </label>
    <button class="btn-primary" onclick={exportArchive} disabled={busy || (!exportPlaintext && exportPassphrase.length < 12)}>
      Download archive
    </button>
  </div>

  <h4>Import</h4>
  <div class="row">
    <input type="file" accept=".json" bind:files={importFile} />
    <label>
      Export passphrase (if encrypted)
      <input type="password" autocomplete="off" bind:value={importPassphrase} />
    </label>
    <label>
      Mode
      <select bind:value={importMode}>
        <option value="into-empty">Into an empty database</option>
        <option value="replace">Replace existing data</option>
      </select>
    </label>
    <button onclick={importArchive} disabled={busy || !importFile?.length}>Import</button>
  </div>
</section>

<style>
  section { display: flex; flex-direction: column; gap: 1rem; margin-bottom: 2rem; }
  h3 { margin: 0; }
  h4 { margin: 0.5rem 0 0; }
  .hint { color: var(--text-muted); font-size: 0.875rem; margin: 0; }
  .row { display: flex; gap: 1.5rem; align-items: flex-end; flex-wrap: wrap; }
  .actions { display: flex; gap: 0.75rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.875rem; font-weight: 600; }
  label.checkbox { flex-direction: row; align-items: center; gap: 0.5rem; font-weight: normal; margin-bottom: 0.25rem; }
  input[type="password"], select {
    font-size: 0.875rem; padding: 0.4rem 0.6rem; border: 1px solid var(--border-strong);
    border-radius: 4px; font-family: inherit; background: var(--surface); color: var(--text);
  }
  button { padding: 0.5rem 1.25rem; border: 1px solid var(--text-faint); border-radius: 4px; cursor: pointer; background: var(--surface); color: var(--text); font-size: 0.875rem; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--link); color: var(--on-accent); border-color: var(--link); }
  .btn-primary:hover:not(:disabled) { background: var(--link-hover); }
  .warning { background: var(--warning-bg); color: var(--warning-text); padding: 0.75rem 1rem; border-radius: 4px; font-size: 0.875rem; display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-start; }
  .warning ul { margin: 0; padding-left: 1.25rem; }
  .error { color: var(--danger-text); background: var(--danger-bg); padding: 0.5rem 0.75rem; border-radius: 4px; font-size: 0.875rem; }
  .success { color: var(--success-text); background: var(--success-bg); padding: 0.5rem 0.75rem; border-radius: 4px; font-size: 0.875rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th { background: var(--surface-alt); padding: 0.4rem 0.6rem; text-align: left; border-bottom: 2px solid var(--border); }
  td { padding: 0.3rem 0.6rem; border-bottom: 1px solid var(--border); }
</style>

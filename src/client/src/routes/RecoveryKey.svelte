<script lang="ts">
  import { apiFetch } from '../lib/api.ts'
  import type { PlaintextCopy, UpgradeResult } from './Upgrade.svelte'

  let {
    freshKey,
    onconfirmed,
    onlater,
  }: {
    // Null when returning later: the key from the upgrade is never shown a second time.
    freshKey: UpgradeResult | null
    onconfirmed: () => void
    onlater: () => void
  } = $props()

  // svelte-ignore state_referenced_locally
  let recoveryKey = $state(freshKey?.recoveryKey ?? '')
  // svelte-ignore state_referenced_locally
  let copies: PlaintextCopy[] = $state(freshKey?.plaintextCopies ?? [])
  let typedBack = $state('')
  let removed: string[] = $state([])
  let passphrase = $state('')
  let error = $state('')
  let busy = $state(false)

  async function postJson(url: string, body: unknown) {
    const res = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> }
  }

  async function confirm(e: SubmitEvent) {
    e.preventDefault()
    error = ''
    busy = true
    try {
      const { ok, data } = await postJson('/api/auth/upgrade/confirm', { recoveryKey: typedBack })
      if (!ok) {
        error = (data.error as string | undefined) ?? 'That recovery key was not accepted.'
        return
      }
      removed = (data.removed as string[] | undefined) ?? []
      copies = (data.plaintextCopies as PlaintextCopy[] | undefined) ?? []
      recoveryKey = ''
      typedBack = ''
      done = true
    } catch {
      error = 'Network error. Please try again.'
    } finally {
      busy = false
    }
  }

  async function makeNewKey(e: SubmitEvent) {
    e.preventDefault()
    error = ''
    busy = true
    try {
      const { ok, data } = await postJson('/api/auth/recovery-key/rotate', {
        currentPassword: passphrase,
      })
      if (!ok) {
        error = (data.error as string | undefined) ?? 'Could not create a new recovery key.'
        return
      }
      recoveryKey = data.recoveryKey as string
      passphrase = ''
    } catch {
      error = 'Network error. Please try again.'
    } finally {
      busy = false
    }
  }

  let done = $state(false)

  function download() {
    const blob = new Blob(
      [`UK Tax Tracker recovery key\n\n${recoveryKey}\n\nKeep this somewhere safe and separate from your passphrase.\n`],
      { type: 'text/plain' },
    )
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = 'tax-tracker-recovery-key.txt'
    link.click()
    URL.revokeObjectURL(link.href)
  }
</script>

<div class="container">
  <div class="card">
    {#if done}
      <h1>Your data is encrypted</h1>
      {#if removed.length > 0}
        <p>The unencrypted safety copy made before encryption has been removed.</p>
      {:else}
        <p>No unencrypted safety copy was found, so there was nothing to remove.</p>
      {/if}
      {#if copies.length > 0}
        <div class="warn">
          <strong>These older copies still hold your data unencrypted:</strong>
          <ul>
            {#each copies as copy}
              <li>{copy.name} <span class="muted">({copy.location === 'backups' ? 'backups folder' : 'data folder'})</span></li>
            {/each}
          </ul>
          Delete them, or replace them with a fresh backup, once you are happy with the result.
        </div>
      {/if}
      <button type="button" onclick={onconfirmed}>Continue</button>
    {:else}
      <h1>Save your recovery key</h1>
      {#if recoveryKey}
        <p>
          This key can unlock your data if you forget your passphrase. It is shown <strong>once</strong>.
          Store it somewhere safe, separate from your passphrase.
        </p>
        {#if freshKey}
          <div class="warn">
            An unencrypted safety copy of your data was saved as <strong>{freshKey.safetyCopy}</strong>
            in the backups folder. It is removed when you confirm your recovery key below.
            {#if freshKey.unattended}
              The server will unlock the data on its own at startup using its ENCRYPTION_KEY.
            {/if}
            {#if !freshKey.scrubbed}
              Clean-up of old unencrypted pages in the database file did not finish; it will be retried
              the next time the server starts.
            {/if}
          </div>
        {/if}
        <div class="key" aria-label="Recovery key">{recoveryKey}</div>
        <div class="row">
          <button type="button" class="secondary" onclick={() => navigator.clipboard?.writeText(recoveryKey)}>Copy</button>
          <button type="button" class="secondary" onclick={download}>Download</button>
        </div>
        <form onsubmit={confirm}>
          {#if error}<div class="error">{error}</div>{/if}
          <label>
            Type the recovery key back to confirm you have saved it
            <input type="text" bind:value={typedBack} autocomplete="off" spellcheck="false" required />
          </label>
          <button type="submit" disabled={busy}>{busy ? 'Checking…' : 'Confirm and continue'}</button>
        </form>
        <button
          type="button"
          class="link"
          onclick={() => {
            recoveryKey = ''
            typedBack = ''
            error = ''
          }}
        >
          This key was not accepted, or I could not save it: create a different one
        </button>
      {:else}
        <p>
          Your data is encrypted, but you have not yet confirmed a recovery key, and an unencrypted
          safety copy is still on disk. Create a new recovery key to finish.
        </p>
        <form onsubmit={makeNewKey}>
          {#if error}<div class="error">{error}</div>{/if}
          <label>
            Your passphrase
            <input type="password" bind:value={passphrase} autocomplete="current-password" required />
          </label>
          <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create a new recovery key'}</button>
        </form>
      {/if}
      <button type="button" class="link" onclick={onlater}>Later</button>
    {/if}
  </div>
</div>

<style>
  .container {
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 1rem;
  }
  .card {
    background: var(--surface); border-radius: 8px; padding: 2rem;
    width: 100%; max-width: 520px;
    box-shadow: 0 2px 12px var(--shadow);
  }
  h1 { margin-top: 0; font-size: 1.4rem; }
  p, li { color: var(--text-secondary); font-size: .9rem; }
  .key {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 1.05rem; letter-spacing: .04em; word-break: break-all;
    background: var(--surface-alt); border: 1px solid var(--border);
    border-radius: 4px; padding: .9rem; margin: .75rem 0; user-select: all;
  }
  .row { display: flex; gap: .5rem; margin-bottom: 1.25rem; }
  .error {
    background: var(--danger-bg); border: 1px solid var(--danger-bg-alt);
    color: var(--danger-text);
    border-radius: 4px; padding: .75rem; margin-bottom: 1rem;
    font-size: .875rem;
  }
  .warn {
    background: var(--accent-bg); border: 1px solid var(--accent-border);
    color: var(--accent-text); border-radius: 4px; padding: .75rem;
    margin: 1rem 0; font-size: .875rem;
  }
  .muted { color: var(--text-muted); }
  label { display: block; margin-bottom: 1rem; font-weight: 500; }
  input {
    display: block; width: 100%; margin-top: .25rem;
    padding: .5rem .75rem; border: 1px solid var(--border-strong);
    border-radius: 4px; font-size: 1rem;
    background: var(--surface); color: var(--text);
  }
  button {
    width: 100%; padding: .625rem; background: var(--accent);
    color: var(--on-accent); border: none; border-radius: 4px;
    font-size: 1rem; cursor: pointer;
  }
  button.secondary { background: var(--surface-alt); color: var(--text); border: 1px solid var(--border-strong); }
  button:disabled { opacity: .65; cursor: not-allowed; }
  button.link {
    background: none; color: var(--link); margin-top: .75rem;
    font-size: .875rem; text-decoration: underline;
  }
</style>

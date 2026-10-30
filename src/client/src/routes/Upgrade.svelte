<script lang="ts" module>
  export interface PlaintextCopy {
    name: string
    location: 'backups' | 'data'
    bytes: number
  }

  export interface UpgradeResult {
    recoveryKey: string
    safetyCopy: string
    plaintextCopies: PlaintextCopy[]
    scrubbed: boolean
    unattended: boolean
  }
</script>

<script lang="ts">
  import { apiFetch } from '../lib/api.ts'

  let {
    unattendedKeyAvailable,
    onupgraded,
    onalready,
    onskip,
  }: {
    // The server has an ENCRYPTION_KEY the user may choose to use for automatic unlock.
    unattendedKeyAvailable: boolean
    onupgraded: (result: UpgradeResult) => void
    // The data turned out to be encrypted already (e.g. a lost response): go and deal with the key.
    onalready: () => void
    onskip: () => void
  } = $props()

  let passphrase = $state('')
  let unattended = $state(false)
  let error = $state('')
  let busy = $state(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    error = ''
    busy = true
    try {
      const res = await apiFetch('/api/auth/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase, unattended: unattendedKeyAvailable && unattended }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409 && (data as { code?: string }).code === 'ALREADY_ENCRYPTED') {
        onalready()
      } else if (!res.ok) {
        error = (data as { error?: string }).error ?? `Encryption failed (${res.status}).`
      } else {
        passphrase = ''
        onupgraded(data as UpgradeResult)
      }
    } catch {
      error = 'Network error. Please try again.'
    } finally {
      busy = false
    }
  }
</script>

<div class="container">
  <div class="card">
    <h1>Encrypt your data</h1>
    <p>
      Your transactions, holdings and figures are currently stored unencrypted in the database
      file. Encrypting them protects that file if it is copied, backed up or lost.
    </p>
    <ul>
      <li>Your passphrase unlocks the data, so keep using the one you sign in with.</li>
      <li>You will be shown a recovery key once. If you lose both your passphrase and the recovery key, the data cannot be opened.</li>
      <li>An unencrypted safety copy is made first and removed once you confirm your recovery key.</li>
    </ul>
    <form onsubmit={submit}>
      {#if error}
        <div class="error">{error}</div>
      {/if}
      <label>
        Confirm your passphrase
        <input type="password" bind:value={passphrase} autocomplete="current-password" required />
      </label>
      {#if unattendedKeyAvailable}
        <label class="check">
          <input type="checkbox" bind:checked={unattended} />
          <span>
            Unlock automatically when the server starts, using the ENCRYPTION_KEY from its
            environment. Convenient for an always-on server, but the key then sits next to the
            data, so anyone who can read both can open it. Leave unticked on a laptop.
          </span>
        </label>
      {/if}
      <button type="submit" disabled={busy}>{busy ? 'Encrypting…' : 'Encrypt my data'}</button>
      <button type="button" class="link" onclick={onskip} disabled={busy}>Not now</button>
    </form>
  </div>
</div>

<style>
  .container {
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 1rem;
  }
  .card {
    background: var(--surface); border-radius: 8px; padding: 2rem;
    width: 100%; max-width: 480px;
    box-shadow: 0 2px 12px var(--shadow);
  }
  h1 { margin-top: 0; font-size: 1.4rem; }
  p, li { color: var(--text-secondary); font-size: .9rem; }
  ul { padding-left: 1.2rem; margin: .75rem 0 1.25rem; }
  .error {
    background: var(--danger-bg); border: 1px solid var(--danger-bg-alt);
    color: var(--danger-text);
    border-radius: 4px; padding: .75rem; margin-bottom: 1rem;
    font-size: .875rem;
  }
  label { display: block; margin-bottom: 1rem; font-weight: 500; }
  label.check { display: flex; gap: .6rem; align-items: flex-start; font-weight: 400; font-size: .85rem; color: var(--text-secondary); }
  label.check input { width: auto; margin-top: .2rem; }
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
  button:disabled { opacity: .65; cursor: not-allowed; }
  button.link {
    background: none; color: var(--link); margin-top: .75rem;
    font-size: .875rem; text-decoration: underline;
  }
</style>

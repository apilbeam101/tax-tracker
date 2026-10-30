<script lang="ts" module>
  export interface SetupResult {
    user: { username: string }
    // Null when the database already held data: the sign-in then offers the in-app upgrade.
    recoveryKey: string | null
    unattended: boolean
  }
</script>

<script lang="ts">
  let {
    unattendedKeyAvailable,
    oncomplete,
    onalready,
  }: {
    // The server has an ENCRYPTION_KEY the user may choose to use for automatic unlock.
    unattendedKeyAvailable: boolean
    oncomplete: (result: SetupResult) => void
    // Setup had already been completed (e.g. by a request from before a reload): go and sign in.
    onalready: () => void
  } = $props()

  let password = $state('')
  let unattended = $state(false)
  let confirm  = $state('')
  let error    = $state('')
  let loading  = $state(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    error = ''
    if (password.length < 12) {
      error = 'Passphrase must be at least 12 characters.'
      return
    }
    if (password !== confirm) {
      error = 'Passphrases do not match.'
      return
    }
    loading = true
    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, unattended: unattendedKeyAvailable && unattended }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409 && (data as { error?: string }).error === 'Setup already completed') {
        onalready()
      } else if (!res.ok) {
        error = (data as { error?: string }).error ?? 'Setup failed.'
      } else {
        password = ''
        confirm = ''
        oncomplete(data as SetupResult)
      }
    } catch {
      error = 'Network error. Please try again.'
    } finally {
      loading = false
    }
  }
</script>

<div class="container">
  <div class="card">
    <h1>Welcome to UK Tax Tracker</h1>
    <p>
      This is your first run. Set a passphrase to protect your financial data. It signs you in and
      unlocks your data.
    </p>
    <p class="hint">Use a strong passphrase of at least 12 characters.</p>

    <form onsubmit={submit}>
      {#if error}
        <div class="error">{error}</div>
      {/if}
      <label>
        Passphrase
        <input type="password" bind:value={password} autocomplete="new-password" required />
      </label>
      <label>
        Confirm passphrase
        <input type="password" bind:value={confirm} autocomplete="new-password" required />
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
      <button type="submit" disabled={loading}>
        {loading ? 'Setting up…' : 'Create passphrase & continue'}
      </button>
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
    width: 100%; max-width: 420px;
    box-shadow: 0 2px 12px var(--shadow);
  }
  h1 { margin-top: 0; font-size: 1.4rem; }
  .hint { color: var(--text-muted); font-size: .875rem; }
  .error {
    background: var(--warning-bg); border: 1px solid var(--warning);
    color: var(--warning-text);
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
</style>

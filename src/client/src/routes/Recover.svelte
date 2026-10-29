<script lang="ts">
  import { clearCsrfToken } from '../lib/api.ts'

  let {
    onsuccess,
    oncancel,
  }: {
    onsuccess: (user: { username: string }) => void
    oncancel: () => void
  } = $props()

  let recoveryKey = $state('')
  let newPassphrase = $state('')
  let confirm = $state('')
  let error = $state('')
  let loading = $state(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    error = ''
    if (newPassphrase !== confirm) {
      error = 'The two passphrases do not match.'
      return
    }
    loading = true
    try {
      // The CSRF token is bound to the session this request replaces, so fetch a fresh one.
      clearCsrfToken()
      const tokenRes = await fetch('/api/auth/csrf')
      const { csrfToken } = (await tokenRes.json()) as { csrfToken: string }
      const res = await fetch('/api/auth/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'csrf-token': csrfToken },
        body: JSON.stringify({ recoveryKey, newPassphrase }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        error = (data as { error?: string }).error ?? `Recovery failed (${res.status}).`
      } else {
        onsuccess((data as { user: { username: string } }).user)
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
    <h1>Reset your passphrase</h1>
    <p class="hint">
      Enter the recovery key you saved when you set up encryption, then choose a new passphrase.
      Your data is not changed.
    </p>
    <form onsubmit={submit}>
      {#if error}
        <div class="error">{error}</div>
      {/if}
      <label>
        Recovery key
        <input type="text" bind:value={recoveryKey} autocomplete="off" spellcheck="false" required />
      </label>
      <label>
        New passphrase
        <input type="password" bind:value={newPassphrase} autocomplete="new-password" minlength="12" required />
      </label>
      <label>
        Confirm new passphrase
        <input type="password" bind:value={confirm} autocomplete="new-password" minlength="12" required />
      </label>
      <button type="submit" disabled={loading}>
        {loading ? 'Resetting…' : 'Reset passphrase and sign in'}
      </button>
      <button type="button" class="link" onclick={oncancel}>Back to sign in</button>
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
  .hint { color: var(--text-secondary); font-size: .875rem; }
  .error {
    background: var(--danger-bg); border: 1px solid var(--danger-bg-alt);
    color: var(--danger-text);
    border-radius: 4px; padding: .75rem; margin-bottom: 1rem;
    font-size: .875rem;
  }
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
  button:disabled { opacity: .65; cursor: not-allowed; }
  button.link {
    background: none; color: var(--link); margin-top: .75rem;
    font-size: .875rem; text-decoration: underline;
  }
</style>

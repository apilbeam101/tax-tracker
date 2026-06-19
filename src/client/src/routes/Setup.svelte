<script lang="ts">
  let { oncomplete }: { oncomplete: () => void } = $props()

  let password = $state('')
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
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        const data = await res.json()
        error = data.error ?? 'Setup failed.'
      } else {
        oncomplete()
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
    <p>This is your first run. Set a passphrase to protect your financial data.</p>
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
    background: white; border-radius: 8px; padding: 2rem;
    width: 100%; max-width: 420px;
    box-shadow: 0 2px 12px rgba(0,0,0,.08);
  }
  h1 { margin-top: 0; font-size: 1.4rem; }
  .hint { color: #6c757d; font-size: .875rem; }
  .error {
    background: #fff3cd; border: 1px solid #ffc107;
    border-radius: 4px; padding: .75rem; margin-bottom: 1rem;
    font-size: .875rem;
  }
  label { display: block; margin-bottom: 1rem; font-weight: 500; }
  input {
    display: block; width: 100%; margin-top: .25rem;
    padding: .5rem .75rem; border: 1px solid #ced4da;
    border-radius: 4px; font-size: 1rem;
  }
  button {
    width: 100%; padding: .625rem; background: #0d6efd;
    color: white; border: none; border-radius: 4px;
    font-size: 1rem; cursor: pointer;
  }
  button:disabled { opacity: .65; cursor: not-allowed; }
</style>

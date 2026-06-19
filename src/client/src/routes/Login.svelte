<script lang="ts">
  let { onsuccess }: { onsuccess: (user: { username: string }) => void } = $props()

  let username = $state('admin')
  let password = $state('')
  let error    = $state('')
  let loading  = $state(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    error = ''
    loading = true
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        error = (data as { error?: string }).error ?? `Login failed (${res.status}).`
      } else {
        const data = await res.json()
        onsuccess(data.user)
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
    <h1>UK Tax Tracker</h1>
    <form onsubmit={submit}>
      {#if error}
        <div class="error">{error}</div>
      {/if}
      <label>
        Username
        <input type="text" bind:value={username} autocomplete="username" required />
      </label>
      <label>
        Passphrase
        <input type="password" bind:value={password} autocomplete="current-password" required />
      </label>
      <button type="submit" disabled={loading}>
        {loading ? 'Signing in…' : 'Sign in'}
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
    width: 100%; max-width: 380px;
    box-shadow: 0 2px 12px rgba(0,0,0,.08);
  }
  h1 { margin-top: 0; font-size: 1.4rem; }
  .error {
    background: #f8d7da; border: 1px solid #f5c2c7;
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

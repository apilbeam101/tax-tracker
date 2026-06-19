<script lang="ts">
  import { onMount } from 'svelte'
  import Setup from './routes/Setup.svelte'
  import Login from './routes/Login.svelte'
  import Dashboard from './routes/Dashboard.svelte'
  import { apiFetch, clearCsrfToken } from './lib/api.ts'

  type AppState = 'loading' | 'setup' | 'login' | 'app'

  let state: AppState = $state('loading')
  let currentUser: { username: string } | null = $state(null)

  onMount(async () => {
    try {
      const res = await fetch('/api/auth/status')
      const data = await res.json()
      if (data.setupRequired) {
        state = 'setup'
      } else if (!data.authenticated) {
        state = 'login'
      } else {
        currentUser = data.user
        state = 'app'
      }
    } catch {
      state = 'login'
    }
  })

  function onSetupComplete() {
    state = 'login'
  }

  function onLoginSuccess(user: { username: string }) {
    currentUser = user
    state = 'app'
  }

  async function onLogout() {
    const res = await apiFetch('/api/auth/logout', { method: 'POST' })
    if (!res.ok) return
    clearCsrfToken()
    currentUser = null
    state = 'login'
  }
</script>

{#if state === 'loading'}
  <div class="loading">Loading…</div>

{:else if state === 'setup'}
  <Setup oncomplete={onSetupComplete} />

{:else if state === 'login'}
  <Login onsuccess={onLoginSuccess} />

{:else}
  <Dashboard user={currentUser} onlogout={onLogout} />
{/if}

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, sans-serif;
    background: #f8f9fa;
    color: #212529;
  }
  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    color: #6c757d;
  }
</style>

<script lang="ts">
  import { onMount } from 'svelte'
  import Setup from './routes/Setup.svelte'
  import Login from './routes/Login.svelte'
  import Recover from './routes/Recover.svelte'
  import Dashboard from './routes/Dashboard.svelte'
  import Upgrade from './routes/Upgrade.svelte'
  import RecoveryKey from './routes/RecoveryKey.svelte'
  import ApiKeys from './routes/ApiKeys.svelte'
  import type { SetupResult } from './routes/Setup.svelte'
  import type { UpgradeResult } from './routes/Upgrade.svelte'
  import { apiFetch, clearCsrfToken, watchSessionLoss } from './lib/api.ts'

  type AppState = 'loading' | 'setup' | 'login' | 'recover' | 'upgrade' | 'recovery-key' | 'api-keys' | 'app'

  let state: AppState = $state('loading')
  let currentUser: { username: string } | null = $state(null)
  // The data is encrypted and currently locked: signing in is also what unlocks it.
  let locked = $state(false)
  // Key slots exist, so a recovery key can reset a forgotten passphrase.
  let canRecover = $state(false)
  // 'available': not encrypted yet. 'confirm': encrypted, recovery key not yet proven.
  let upgrade: 'none' | 'available' | 'confirm' = $state('none')
  let upgradeSkipped = $state(false)
  let unattendedKeyAvailable = $state(false)
  // Set only in the session that ran the upgrade: the recovery key is never shown again.
  let freshKey: UpgradeResult | null = $state(null)

  // Asks the server where things stand, e.g. whether signing out re-locked the data.
  async function refreshStatus() {
    try {
      const data = await (await fetch('/api/auth/status')).json()
      locked = !!data.locked
      canRecover = data.unlockMode !== 'none'
      upgrade = data.upgrade ?? 'none'
      unattendedKeyAvailable = !!data.unattendedKeyAvailable
    } catch {
      /* keep the previous values */
    }
  }

  function stateAfterSignIn(): AppState {
    if (upgrade === 'confirm') return 'recovery-key'
    if (upgrade === 'available' && !upgradeSkipped) return 'upgrade'
    return 'app'
  }

  onMount(() => {
    watchSessionLoss({
      locked: () => {
        currentUser = null
        freshKey = null
        locked = true
        canRecover = true
        state = 'login'
      },
      ended: () => {
        if (state === 'loading' || state === 'setup' || state === 'login' || state === 'recover') {
          return
        }
        currentUser = null
        // The recovery key from the upgrade is shown once, in the session that made it.
        freshKey = null
        state = 'login'
        void refreshStatus()
      },
    })
    void init()
    return () => watchSessionLoss(null)
  })

  async function init() {
    try {
      const res = await fetch('/api/auth/status')
      const data = await res.json()
      locked = !!data.locked
      canRecover = data.unlockMode !== 'none'
      upgrade = data.upgrade ?? 'none'
      unattendedKeyAvailable = !!data.unattendedKeyAvailable
      if (data.setupRequired) {
        state = 'setup'
      } else if (!data.authenticated) {
        state = 'login'
      } else {
        currentUser = data.user
        state = stateAfterSignIn()
      }
    } catch {
      state = 'login'
    }
  }

  async function onSetupComplete(result: SetupResult) {
    currentUser = result.user
    locked = false
    clearCsrfToken()
    if (!result.recoveryKey) {
      await refreshStatus()
      state = stateAfterSignIn()
      return
    }
    canRecover = true
    freshKey = {
      recoveryKey: result.recoveryKey,
      safetyCopy: '',
      plaintextCopies: [],
      scrubbed: true,
      unattended: result.unattended,
      firstRun: true,
    }
    upgrade = 'confirm'
    state = 'recovery-key'
  }

  async function onLoginSuccess(user: { username: string }) {
    currentUser = user
    locked = false
    clearCsrfToken()
    await refreshStatus()
    state = stateAfterSignIn()
  }

  function onUpgraded(result: UpgradeResult) {
    freshKey = result
    upgrade = 'confirm'
    state = 'recovery-key'
  }

  function onKeyConfirmed() {
    const firstRun = freshKey?.firstRun === true
    freshKey = null
    upgrade = 'none'
    state = firstRun ? 'api-keys' : 'app'
  }

  async function onLogout() {
    const res = await apiFetch('/api/auth/logout', { method: 'POST' })
    if (!res.ok) return
    clearCsrfToken()
    currentUser = null
    freshKey = null
    state = 'login'
    await refreshStatus()
  }
</script>

{#if state === 'loading'}
  <div class="loading">Loading…</div>

{:else if state === 'setup'}
  <Setup {unattendedKeyAvailable} oncomplete={onSetupComplete} onalready={() => void init()} />

{:else if state === 'login'}
  <Login
    onsuccess={onLoginSuccess}
    {locked}
    {canRecover}
    onrecover={() => (state = 'recover')}
  />

{:else if state === 'recover'}
  <Recover onsuccess={onLoginSuccess} oncancel={() => (state = 'login')} />

{:else if state === 'upgrade'}
  <Upgrade
    {unattendedKeyAvailable}
    onupgraded={onUpgraded}
    onalready={async () => {
      await refreshStatus()
      freshKey = null
      state = 'recovery-key'
    }}
    onskip={() => {
      upgradeSkipped = true
      state = 'app'
    }}
  />

{:else if state === 'recovery-key'}
  <RecoveryKey {freshKey} onconfirmed={onKeyConfirmed} onlater={() => (state = 'app')} />

{:else if state === 'api-keys'}
  <div class="step">
    <div class="step-card">
      <ApiKeys ondone={() => (state = 'app')} />
    </div>
  </div>

{:else}
  <Dashboard user={currentUser} onlogout={onLogout} />
{/if}

<style>
  :global(:root) {
    --bg: #f8f9fa;
    --surface: #ffffff;
    --surface-alt: #f1f3f5;
    --text: #212529;
    --text-secondary: #495057;
    --text-muted: #6c757d;
    --text-faint: #adb5bd;
    --border: #dee2e6;
    --border-strong: #ced4da;
    --accent: #0d6efd;
    --accent-alpha: #0d6efd33;
    --accent-bg: #f0f4ff;
    --accent-border: #b6c8f9;
    --accent-text: #0d47a1;
    --on-accent: #ffffff;
    --link: #0066cc;
    --link-hover: #0055aa;
    --success: #198754;
    --success-bg: #d4edda;
    --success-bg-alt: #d1e7dd;
    --success-text: #155724;
    --success-border: #a3cfbb;
    --danger: #dc3545;
    --danger-bg: #f8d7da;
    --danger-bg-alt: #f5c2c7;
    --danger-text: #721c24;
    --danger-text-alt: #842029;
    --loss: #cc0000;
    --gain: #198754;
    --warning: #ffc107;
    --warning-bg: #fff3cd;
    --warning-text: #856404;
    --warning-text-alt: #664d03;
    --info: #0c5460;
    --info-bg: #d1ecf1;
    --info-bg-alt: #cff4fc;
    --info-text: #0c5460;
    --info-text-alt: #055160;
    --info-border: #90caf9;
    --neutral-bg: #e2e3e5;
    --neutral-text: #41464b;
    --projected-bg: #e8d5f7;
    --projected-bg-alt: #faf5ff;
    --projected-text: #5b21b6;
    --projected-text-alt: #5a1d8a;
    --projected-border: #a78bfa;
    --projected-accent: #7c3aed;
    --nav-bg: #1a1a2e;
    --nav-text: #ffffff;
    --shadow: rgba(0, 0, 0, 0.1);
    color-scheme: light;
  }

  :global(:root[data-theme='dark']) {
    --bg: #15171a;
    --surface: #1e2124;
    --surface-alt: #26292d;
    --text: #e9ecef;
    --text-secondary: #ced4da;
    --text-muted: #9aa1a8;
    --text-faint: #6c757d;
    --border: #343a40;
    --border-strong: #495057;
    --accent: #4d94ff;
    --accent-alpha: #4d94ff33;
    --accent-bg: #1a2740;
    --accent-border: #2f4d80;
    --accent-text: #9cc2ff;
    --on-accent: #ffffff;
    --link: #6fb1ff;
    --link-hover: #8fc4ff;
    --success: #40c977;
    --success-bg: #12291a;
    --success-bg-alt: #17331f;
    --success-text: #7be3a0;
    --success-border: #2d6b45;
    --danger: #ff6b7a;
    --danger-bg: #33131a;
    --danger-bg-alt: #3d181f;
    --danger-text: #ff9caa;
    --danger-text-alt: #ffb0bc;
    --loss: #ff6b6b;
    --gain: #40c977;
    --warning: #ffcd39;
    --warning-bg: #332a0a;
    --warning-text: #ffd873;
    --warning-text-alt: #f0c34d;
    --info: #5fd0e6;
    --info-bg: #0e2a30;
    --info-bg-alt: #123640;
    --info-text: #8fdcec;
    --info-text-alt: #a3e5f0;
    --info-border: #2e5f7a;
    --neutral-bg: #2a2d31;
    --neutral-text: #c1c6cb;
    --projected-bg: #2a1a3d;
    --projected-bg-alt: #211530;
    --projected-text: #c9a8f7;
    --projected-text-alt: #d3b8fa;
    --projected-border: #7c5bb5;
    --projected-accent: #a685e0;
    --nav-bg: #0e0f1a;
    --nav-text: #e9ecef;
    --shadow: rgba(0, 0, 0, 0.4);
    color-scheme: dark;
  }

  :global(*) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  .step {
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 1rem;
  }
  .step-card {
    background: var(--surface); border-radius: 8px; padding: 2rem;
    width: 100%; max-width: 620px; box-shadow: 0 2px 12px var(--shadow);
  }
  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    color: var(--text-muted);
  }
</style>

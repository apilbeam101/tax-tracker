<script lang="ts">
  import { onMount } from 'svelte'
  import { apiFetch } from '../lib/api.ts'

  let {
    ondone,
  }: {
    // Set when shown as a step of first-run setup: adds a Continue button.
    ondone?: () => void
  } = $props()

  type Source = 'env' | 'stored' | 'unset'
  interface KeyState { name: string; source: Source; editable: boolean }

  const LABELS: Record<string, { title: string; help: string }> = {
    TIINGO_API_KEY: { title: 'Tiingo', help: 'Share prices. Free key at tiingo.com. Without one, prices come from a fallback source.' },
    ALPHA_VANTAGE_API_KEY: { title: 'Alpha Vantage', help: 'Dividend history lookup. Free key at alphavantage.co.' },
  }

  let keys: KeyState[] = $state([])
  let drafts: Record<string, string> = $state({})
  let error = $state('')
  let busy = $state('')

  async function load() {
    try {
      const res = await fetch('/api/settings')
      if (res.ok) keys = ((await res.json()) as { apiKeys: KeyState[] }).apiKeys
      else error = 'Could not load your API key settings. Try signing in again.'
    } catch {
      error = 'Network error. Please try again.'
    }
  }

  onMount(load)

  async function save(name: string) {
    error = ''
    busy = name
    try {
      const res = await apiFetch(`/api/settings/api-keys/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: drafts[name] ?? '' }),
      })
      if (!res.ok) {
        error = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Could not save (${res.status}).`
        return
      }
      drafts[name] = ''
      await load()
    } catch {
      error = 'Network error. Please try again.'
    } finally {
      busy = ''
    }
  }

  async function remove(name: string) {
    error = ''
    busy = name
    try {
      const res = await apiFetch(`/api/settings/api-keys/${name}`, { method: 'DELETE' })
      if (!res.ok) {
        error = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Could not remove (${res.status}).`
        return
      }
      await load()
    } catch {
      error = 'Network error. Please try again.'
    } finally {
      busy = ''
    }
  }
</script>

<div class="panel">
  <h2>API keys</h2>
  <p class="hint">Optional. Keys entered here are stored encrypted with the rest of your data.</p>
  {#if error}<div class="error">{error}</div>{/if}
  {#each keys as key (key.name)}
    <div class="key">
      <strong>{LABELS[key.name]?.title ?? key.name}</strong>
      <span class="hint">{LABELS[key.name]?.help ?? ''}</span>
      {#if !key.editable}
        <input
          type="text"
          value={key.source === 'env'
            ? 'Set via environment'
            : key.source === 'stored'
              ? 'A saved key is in use. Manage it via the environment'
              : 'Not set. Set it via the environment'}
          disabled
        />
        {#if key.source === 'stored'}
          <button type="button" class="secondary" disabled={busy === key.name} onclick={() => remove(key.name)}>Remove saved key</button>
        {/if}
      {:else}
        <form onsubmit={(e) => { e.preventDefault(); void save(key.name) }}>
          <input
            type="password"
            placeholder={key.source === 'stored' ? 'Saved. Enter a new key to replace it' : 'Paste key'}
            bind:value={drafts[key.name]}
            autocomplete="off"
            spellcheck="false"
          />
          <button type="submit" disabled={busy === key.name || !drafts[key.name]?.trim()}>Save</button>
          {#if key.source === 'stored'}
            <button type="button" class="secondary" disabled={busy === key.name} onclick={() => remove(key.name)}>Remove</button>
          {/if}
        </form>
      {/if}
    </div>
  {/each}
  {#if ondone}
    <button type="button" class="continue" onclick={ondone}>Continue</button>
  {/if}
</div>

<style>
  .panel { max-width: 560px; }
  h2 { margin-top: 0; font-size: 1.2rem; }
  .hint { color: var(--text-muted); font-size: .85rem; }
  .key { margin-bottom: 1.25rem; display: flex; flex-direction: column; gap: .35rem; }
  form { display: flex; gap: .5rem; }
  input {
    flex: 1; padding: .5rem .75rem; border: 1px solid var(--border-strong);
    border-radius: 4px; font-size: 1rem; background: var(--surface); color: var(--text);
  }
  input:disabled { opacity: .7; }
  button {
    padding: .5rem 1rem; background: var(--accent); color: var(--on-accent);
    border: none; border-radius: 4px; font-size: .95rem; cursor: pointer;
  }
  button.secondary { background: var(--surface-alt); color: var(--text); border: 1px solid var(--border-strong); }
  button.continue { width: 100%; padding: .625rem; font-size: 1rem; margin-top: .5rem; }
  button:disabled { opacity: .65; cursor: not-allowed; }
  .error {
    background: var(--danger-bg); border: 1px solid var(--danger-bg-alt);
    color: var(--danger-text); border-radius: 4px; padding: .75rem;
    margin-bottom: 1rem; font-size: .875rem;
  }
</style>

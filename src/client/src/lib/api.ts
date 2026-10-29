/**
 * Thin fetch wrapper that attaches the CSRF token to every non-GET request.
 * The token is fetched once per session and cached in memory.
 */

let csrfToken: string | null = null

async function getToken(): Promise<string> {
  if (csrfToken) return csrfToken
  const res = await fetch('/api/auth/csrf')
  const data = (await res.json()) as { csrfToken: string }
  csrfToken = data.csrfToken
  return csrfToken
}

export interface SessionLostHandlers {
  /** The server answered 423 Locked: show the unlock screen. */
  locked: () => void
  /** The server answered 401 for a data request: the session ended (idle, revoked, restarted). */
  ended: () => void
}

let handlers: SessionLostHandlers | null = null
let interceptorInstalled = false

function pathOf(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return new URL(raw, window.location.origin).pathname
}

/**
 * Wraps window.fetch once, so every data request in the app (not only the ones that go through
 * apiFetch) reports a locked or ended session. /api/auth/* is excluded: sign-in and recovery
 * report their own failures inline.
 */
export function watchSessionLoss(next: SessionLostHandlers | null) {
  handlers = next
  if (interceptorInstalled) return
  interceptorInstalled = true
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const res = await nativeFetch(input, init)
    const path = pathOf(input)
    if (!path.startsWith('/api/') || path.startsWith('/api/auth/')) return res
    if (res.status === 423) {
      const body = (await res
        .clone()
        .json()
        .catch(() => ({}))) as { code?: string }
      if (body.code === 'LOCKED') {
        clearCsrfToken()
        handlers?.locked()
      }
    } else if (res.status === 401) {
      clearCsrfToken()
      handlers?.ended()
    }
    return res
  }
}

/** Drop the cached token (call after logout or on 403). */
export function clearCsrfToken() {
  csrfToken = null
}

/**
 * Drop-in replacement for fetch that automatically adds the `csrf-token`
 * header on POST, PATCH, PUT, and DELETE requests.
 */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    const token = await getToken()
    init = {
      ...init,
      headers: {
        ...init.headers,
        'csrf-token': token,
      },
    }
  }
  const res = await fetch(url, init)
  // Token expired or rotated — clear cache so next call refetches
  if (res.status === 403) {
    clearCsrfToken()
  }
  return res
}

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

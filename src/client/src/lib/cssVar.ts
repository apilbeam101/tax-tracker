/** Reads a CSS custom property's current computed value (theme-aware). */
export function cssVar(name: string, fallback = '#888888'): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/**
 * Resolves a `var(--token)` string to its current value for use in contexts
 * (Canvas 2D) that can't consume `var()` directly; passes through anything
 * else unchanged. Falls back to a real color, never the unresolved `var()`
 * string, since callers that append a hex alpha suffix (e.g. `color + '33'`)
 * would otherwise get an invalid value.
 */
export function resolveColor(value: string, fallback = '#888888'): string {
  const match = value.match(/^var\((--[\w-]+)\)$/)
  return match ? cssVar(match[1], fallback) : value
}

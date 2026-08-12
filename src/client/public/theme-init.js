// Runs synchronously in <head>, before first paint, so the correct theme
// applies immediately instead of flashing light before theme.svelte.ts loads.
// A same-origin external file (not inline) so it's allowed by the CSP's
// script-src 'self' without needing 'unsafe-inline'.
;(() => {
  try {
    const stored = localStorage.getItem('theme')
    const theme =
      stored === 'light' || stored === 'dark'
        ? stored
        : matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
    document.documentElement.dataset.theme = theme
  } catch (_e) {
    // localStorage/matchMedia unavailable — default light styling applies.
  }
})()

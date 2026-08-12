type Theme = 'light' | 'dark'

function initial(): Theme {
  const stored = localStorage.getItem('theme')
  if (stored === 'light' || stored === 'dark') return stored
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme
}

function createTheme() {
  const startingTheme = initial()
  let value = $state<Theme>(startingTheme)
  apply(startingTheme)
  return {
    get theme() {
      return value
    },
    toggle() {
      value = value === 'dark' ? 'light' : 'dark'
      localStorage.setItem('theme', value)
      apply(value)
    },
  }
}

export const themeStore = createTheme()

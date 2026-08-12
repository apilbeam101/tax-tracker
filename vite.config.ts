import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/client',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  plugins: [svelte()],
  test: {
    // Run server-side (non-browser) tests from src/server and src/shared
    // Tests live alongside source files as *.test.ts
    include: ['../server/**/*.test.ts', '../shared/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['../server/**/*.ts', '../shared/**/*.ts'],
      exclude: ['**/*.test.ts', '**/main.ts'],
    },
  },
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/server/**/*.test.ts', 'src/shared/**/*.test.ts'],
    environment: 'node',
    // Provide stub values for required env vars so tests run without a .env file
    env: {
      SESSION_SECRET: 'test-session-secret-for-unit-tests-only',
      ENCRYPTION_KEY: 'test-encryption-key-for-unit-tests-only',
    },
    coverage: {
      provider: 'v8',
      include: ['src/server/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['**/*.test.ts', '**/main.ts'],
    },
  },
})

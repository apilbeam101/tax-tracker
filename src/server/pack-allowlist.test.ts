import { describe, expect, it } from 'vitest'
import { checkPackFiles, REQUIRED } from '../../scripts/check-pack-allowlist.ts'

describe('checkPackFiles', () => {
  it('passes when every required file is present and nothing forbidden is', () => {
    expect(checkPackFiles([...REQUIRED, 'dist/server/app.js'])).toEqual([])
  })

  it('reports each missing required file', () => {
    const problems = checkPackFiles(REQUIRED.filter((f) => f !== 'dist/server/cli.js'))
    expect(problems).toEqual(['missing: dist/server/cli.js'])
  })

  it.each([
    '.env',
    'data/taxtracker.db',
    'dist/server/app.test.js',
    'src/server/app.ts',
    'dist/server/config.json',
    'backups/taxtracker-1.db',
    '.claude/settings.local.json',
  ])('rejects %s', (file) => {
    expect(checkPackFiles([...REQUIRED, file]).some((p) => p.includes(file))).toBe(true)
  })

  it('does not mistake .env.example-style lookalikes for nothing: it also rejects .env.local', () => {
    expect(checkPackFiles([...REQUIRED, '.env.local']).length).toBeGreaterThan(0)
  })
})

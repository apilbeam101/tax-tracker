/**
 * Fails if the npm tarball is missing a file the CLI needs at runtime, or carries something that
 * must never be published (secrets, local data, tests, sources).
 * Usage: npm run build && npm run pack:check
 */
import { pathToFileURL } from 'node:url'
import { runNpm } from './run-npm.ts'

export const REQUIRED = [
  'package.json',
  'LICENSE',
  'README.md',
  'dist/server/cli.js',
  'dist/server/main.js',
  'dist/client/index.html',
  'dist/server/db/migrations/001_core_schema.sql',
]

const FORBIDDEN: Array<[RegExp, string]> = [
  [/(^|\/)\.env($|\.)/, 'environment file'],
  [/(^|\/)data\//, 'data directory'],
  [/\.(db|db-wal|db-shm|bak)$/, 'database file'],
  [/(^|\/)config\.json$/, 'config file'],
  [/\.test\.(js|ts)$/, 'test file'],
  [/^src\//, 'source file'],
  [/(^|\/)\.claude\//, 'editor/agent settings'],
]

export function checkPackFiles(files: string[]): string[] {
  const problems: string[] = []
  for (const required of REQUIRED) {
    if (!files.includes(required)) problems.push(`missing: ${required}`)
  }
  for (const file of files) {
    for (const [pattern, why] of FORBIDDEN) {
      if (pattern.test(file)) problems.push(`forbidden (${why}): ${file}`)
    }
  }
  return problems
}

function packedFiles(): string[] {
  const [pack] = JSON.parse(runNpm(['pack', '--dry-run', '--json', '--ignore-scripts'])) as Array<{
    files: Array<{ path: string }>
  }>
  return (pack?.files ?? []).map((f) => f.path.replace(/\\/g, '/'))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = packedFiles()
  const problems = checkPackFiles(files)
  if (problems.length > 0) {
    console.error(`Pack allowlist check failed:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`Pack allowlist check passed (${files.length} files).`)
}

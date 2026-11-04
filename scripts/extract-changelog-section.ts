import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Matches a Keep a Changelog release heading for the exact version given, e.g. "1.2.0" matches
// "## [1.2.0] - 2026-01-01" but not "## [1.2.0-rc.1]". The caller always passes a real released
// version parsed from a git tag, never the literal string "Unreleased".
export function extractChangelogSection(changelog: string, version: string): string | undefined {
  const headingPattern = new RegExp(`^## \\[${escapeRegExp(version)}\\].*$`, 'm')
  const start = changelog.search(headingPattern)
  if (start === -1) return undefined

  const rest = changelog.slice(start)
  const nextHeading = rest.slice(1).search(/^## /m)
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading + 1)
  return section.trim()
}

function main(): void {
  const version = process.argv[2]
  if (version === undefined) {
    console.error('usage: extract-changelog-section.ts <version>')
    process.exit(2)
  }

  const section = extractChangelogSection(readFileSync('CHANGELOG.md', 'utf8'), version)
  if (section === undefined) {
    console.error(`CHANGELOG.md has no "## [${version}]" section: promote [Unreleased] first.`)
    process.exit(1)
  }
  console.log(section)
}

const entryPoint = process.argv[1]
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main()
}

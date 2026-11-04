/**
 * Checks that CHANGELOG.md keeps the format the release workflow depends on: an [Unreleased]
 * section first, then released sections as "## [x.y.z] - YYYY-MM-DD" in strictly descending order.
 * Usage: npm run changelog:check
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/
const RELEASE_HEADING = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})\s*$/

function compare(a: string, b: string): number {
  const pa = (SEMVER.exec(a) ?? []).slice(1, 4).map(Number)
  const pb = (SEMVER.exec(b) ?? []).slice(1, 4).map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  // Same x.y.z: a release outranks its own pre-releases.
  const prerelease = (v: string) => v.split('-').slice(1).join('-')
  const [pre1, pre2] = [prerelease(a), prerelease(b)]
  if (pre1 === pre2) return 0
  if (pre1 === '') return 1
  if (pre2 === '') return -1
  return pre1.localeCompare(pre2, 'en', { numeric: true })
}

export function checkChangelog(text: string): string[] {
  const problems: string[] = []
  const headings = text.split('\n').filter((line) => line.startsWith('## '))
  if (!text.startsWith('# Changelog')) problems.push('must start with "# Changelog"')
  if (headings[0]?.trim() !== '## [Unreleased]') {
    problems.push('the first "## " section must be "## [Unreleased]"')
  }

  const versions: string[] = []
  for (const heading of headings.slice(1)) {
    const match = RELEASE_HEADING.exec(heading)
    const version = match?.[1]
    if (!match || !version || !SEMVER.test(version)) {
      problems.push(`not a release heading ("## [x.y.z] - YYYY-MM-DD"): ${heading}`)
      continue
    }
    if (versions.includes(version)) problems.push(`duplicate release ${version}`)
    versions.push(version)
  }
  for (let i = 1; i < versions.length; i++) {
    if (compare(versions[i - 1] as string, versions[i] as string) <= 0) {
      problems.push(
        `releases must be in descending order: ${versions[i - 1]} before ${versions[i]}`,
      )
    }
  }
  return problems
}

const entryPoint = process.argv[1]
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  const problems = checkChangelog(readFileSync('CHANGELOG.md', 'utf8'))
  if (problems.length > 0) {
    console.error(`CHANGELOG.md format check failed:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  console.log('CHANGELOG.md format check passed.')
}

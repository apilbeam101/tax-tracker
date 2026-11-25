import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { extractChangelogSection } from './extract-changelog-section.ts'

export function releaseNotesPath(version: string): string {
  return `docs/releases/v${version}.md`
}

export interface NotesInput {
  version: string
  changelog: string
  notes: string | undefined
}

// The text of a GitHub Release. A written notes file for the version always wins. A stable release
// must have one: the changelog is a development log, which says little to someone meeting the
// project for the first time. A pre-release can fall back to its changelog section.
export function chooseReleaseNotes({ version, changelog, notes }: NotesInput): string {
  const stable = !version.includes('-')
  if (notes !== undefined) {
    const body = notes.trim()
    if (body === '') throw new Error(`${releaseNotesPath(version)} is empty`)
    if (!body.includes(version)) {
      throw new Error(
        `${releaseNotesPath(version)} never mentions ${version}; is it the right file?`,
      )
    }
    return body
  }
  if (stable) {
    throw new Error(
      `${releaseNotesPath(version)} is missing: a stable release needs written release notes.`,
    )
  }
  const section = extractChangelogSection(changelog, version)
  if (section === undefined) {
    throw new Error(`CHANGELOG.md has no "## [${version}]" section: promote [Unreleased] first.`)
  }
  return section
}

function main(): void {
  const version = process.argv[2]
  if (version === undefined) {
    console.error('usage: release-notes.ts <version>')
    process.exit(2)
  }
  const path = releaseNotesPath(version)
  const body = chooseReleaseNotes({
    version,
    changelog: readFileSync('CHANGELOG.md', 'utf8'),
    notes: existsSync(path) ? readFileSync(path, 'utf8') : undefined,
  })
  console.log(body)
}

const entryPoint = process.argv[1]
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  try {
    main()
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

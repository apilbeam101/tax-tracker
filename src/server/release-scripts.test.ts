import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkChangelog } from '../../scripts/check-changelog.ts'
import { extractChangelogSection } from '../../scripts/extract-changelog-section.ts'
import { resolvePlatformDigests } from '../../scripts/resolve-image-platforms.ts'

const SAMPLE = `# Changelog

## [Unreleased]

### Added

- Next thing.

## [1.2.0] - 2026-03-01

### Added

- Two.

## [1.2.0-rc.1] - 2026-02-20

- Candidate.

## [1.1.0] - 2026-01-01

- One.
`

describe('extractChangelogSection', () => {
  it('returns exactly the requested release', () => {
    const section = extractChangelogSection(SAMPLE, '1.2.0')
    expect(section).toContain('## [1.2.0] - 2026-03-01')
    expect(section).toContain('- Two.')
    expect(section).not.toContain('1.2.0-rc.1')
    expect(section).not.toContain('Next thing')
  })

  it('does not treat a pre-release heading as the release, and finds the last section', () => {
    expect(extractChangelogSection(SAMPLE, '1.2.0-rc.1')).toContain('Candidate')
    expect(extractChangelogSection(SAMPLE, '1.1.0')).toBe('## [1.1.0] - 2026-01-01\n\n- One.')
    expect(extractChangelogSection(SAMPLE, '9.9.9')).toBeUndefined()
    expect(extractChangelogSection(SAMPLE, '1.2')).toBeUndefined()
  })
})

describe('checkChangelog', () => {
  it('accepts the project changelog and a well-formed sample', () => {
    expect(checkChangelog(SAMPLE)).toEqual([])
    expect(checkChangelog(readFileSync('CHANGELOG.md', 'utf8'))).toEqual([])
  })

  it('rejects the usual mistakes', () => {
    expect(
      checkChangelog(SAMPLE.replace('## [Unreleased]', '## [1.3.0] - 2026-04-01')),
    ).not.toEqual([])
    expect(checkChangelog(SAMPLE.replace('- 2026-03-01', ''))).not.toEqual([])
    expect(checkChangelog(SAMPLE.replace('[1.1.0]', '[1.2.0]'))).not.toEqual([])
    expect(checkChangelog(SAMPLE.replace('[1.1.0]', '[1.3.0]'))).not.toEqual([])
    expect(checkChangelog(SAMPLE.replace('# Changelog', 'Changes'))).not.toEqual([])
  })
})

describe('resolvePlatformDigests', () => {
  it('keeps real platforms and drops attestation entries', () => {
    expect(
      resolvePlatformDigests({
        manifests: [
          { digest: 'sha256:a', platform: { os: 'linux', architecture: 'amd64' } },
          { digest: 'sha256:b', platform: { os: 'linux', architecture: 'arm64' } },
          { digest: 'sha256:c', platform: { os: 'unknown', architecture: 'unknown' } },
          { digest: 'sha256:d' },
        ],
      }),
    ).toEqual([
      { platform: 'linux/amd64', digest: 'sha256:a' },
      { platform: 'linux/arm64', digest: 'sha256:b' },
    ])
  })
})

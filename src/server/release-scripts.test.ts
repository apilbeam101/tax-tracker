import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkChangelog } from '../../scripts/check-changelog.ts'
import { extractChangelogSection } from '../../scripts/extract-changelog-section.ts'
import { resolvePlatformDigests } from '../../scripts/resolve-image-platforms.ts'
import { checksumFile, INSTALLERS, stampInstaller } from '../../scripts/stamp-installers.ts'

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

describe('installers', () => {
  const sources = Object.fromEntries(
    INSTALLERS.map((name) => [name, readFileSync(`install/${name}`, 'utf8')]),
  )

  it('carry the version placeholder exactly once, so a release can stamp them', () => {
    for (const name of INSTALLERS) {
      expect(stampInstaller(name, sources[name] as string, '1.2.3')).toContain('1.2.3')
      expect(stampInstaller(name, sources[name] as string, '1.2.3')).not.toContain('__VERSION__')
    }
  })

  it('refuse a malformed version or a missing placeholder', () => {
    expect(() => stampInstaller('install.sh', 'VERSION="__VERSION__"', 'v1.2.3')).toThrow(/version/)
    expect(() => stampInstaller('install.sh', 'VERSION="1"', '1.2.3')).toThrow(/exactly once/)
    expect(() => stampInstaller('install.sh', '__VERSION__ __VERSION__', '1.2.3')).toThrow(
      /exactly once/,
    )
  })

  it('write the shell script with Unix line endings', () => {
    expect(stampInstaller('install.sh', '#!/bin/sh\r\nV=__VERSION__\r\n', '1.2.3')).toBe(
      '#!/bin/sh\nV=1.2.3\n',
    )
  })

  it('stay plain ASCII, which Windows PowerShell 5.1 needs in a file without a byte-order mark', () => {
    for (const name of INSTALLERS) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find anything outside 7-bit ASCII
      expect(sources[name]).not.toMatch(/[^\x00-\x7F]/)
    }
  })

  it('install.sh does nothing until its last line, so a truncated download runs nothing', () => {
    const lines = (sources['install.sh'] as string).split('\n')
    expect(lines.filter((line) => line.trim() !== '').at(-1)).toBe('main "$@"')
    expect(lines.filter((line) => line === 'main "$@"')).toHaveLength(1)
    // Function bodies are indented, so a command that starts in column 0 would run as soon as
    // the shell reads it.
    expect(
      lines.filter((line) =>
        /^(trap|rm|curl|sudo|npm|node|launchctl|brew|mkdir|cat|cd) /.test(line),
      ),
    ).toEqual([])
  })

  it('write checksums in the format sha256sum reads', () => {
    expect(checksumFile([{ name: 'a.txt', contents: 'abc' }])).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  a.txt\n',
    )
  })

  it('install.sh writes the same launchd file as deploy/launchd', () => {
    const embedded = /<<'PLIST_EOF'\n([\s\S]*?)\nPLIST_EOF/.exec(
      sources['install.sh'] as string,
    )?.[1]
    const template = readFileSync('deploy/launchd/com.apilbeam101.tax-tracker.plist', 'utf8')
    // Comments differ by design (the template explains hand use); everything else must match.
    const withoutComments = (xml: string) =>
      xml
        .split('<!--')
        .map((part, index) => (index === 0 ? part : part.slice(part.indexOf('-->') + 3)))
        .join('')
    const canonical = (xml: string) =>
      withoutComments(xml).replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
    expect(embedded).toBeDefined()
    expect(canonical(embedded as string)).toBe(canonical(template))
  })
})

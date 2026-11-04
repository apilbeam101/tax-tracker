import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { imageTags } from '../../scripts/image-tags.ts'
import { chooseReleaseNotes, releaseNotesPath } from '../../scripts/release-notes.ts'

describe('imageTags', () => {
  const all = { exact: true, latest: true, moving: true }

  it('gives a stable release its exact, minor, major and latest tags', () => {
    expect(imageTags('1.2.3', all)).toEqual(['1.2.3', '1.2', '1', 'latest'])
    expect(imageTags('0.1.0', all)).toEqual(['0.1.0', '0.1', '0', 'latest'])
  })

  it('leaves out what was not asked for, so the monthly rebuild never touches the exact tag', () => {
    expect(imageTags('1.2.3', { exact: false, latest: true, moving: true })).toEqual([
      '1.2',
      '1',
      'latest',
    ])
    expect(imageTags('1.2.3', { exact: true, latest: false, moving: false })).toEqual(['1.2.3'])
  })

  it('gives a pre-release only its exact tag, and refuses to move anything', () => {
    expect(imageTags('1.2.3-rc.1', { exact: true, latest: false, moving: false })).toEqual([
      '1.2.3-rc.1',
    ])
    expect(() => imageTags('1.2.3-rc.1', all)).toThrow(/pre-release/)
    expect(() => imageTags('1.2.3-rc.1', { exact: true, latest: true, moving: false })).toThrow(
      /pre-release/,
    )
    expect(() => imageTags('1.2.3-rc.1', { exact: true, latest: false, moving: true })).toThrow(
      /pre-release/,
    )
  })

  it('rejects things that are not versions, and an empty request', () => {
    expect(() => imageTags('v1.2.3', all)).toThrow(/not a version/)
    expect(() => imageTags('1.2', all)).toThrow(/not a version/)
    expect(() => imageTags('1.2.3', { exact: false, latest: false, moving: false })).toThrow(
      /no tags/,
    )
  })
})

describe('chooseReleaseNotes', () => {
  const changelog =
    '# Changelog\n\n## [Unreleased]\n\n## [1.0.0-rc.1] - 2026-01-01\n\n- Candidate.\n'

  it('uses the written notes for a release', () => {
    expect(chooseReleaseNotes({ version: '1.0.0', changelog, notes: '# 1.0.0\n\nHello.\n' })).toBe(
      '# 1.0.0\n\nHello.',
    )
  })

  it('refuses to publish a stable release from the changelog alone', () => {
    expect(() => chooseReleaseNotes({ version: '1.0.0', changelog, notes: undefined })).toThrow(
      /needs written release notes/,
    )
  })

  it('lets a pre-release fall back to its changelog section', () => {
    expect(chooseReleaseNotes({ version: '1.0.0-rc.1', changelog, notes: undefined })).toContain(
      'Candidate.',
    )
    expect(() =>
      chooseReleaseNotes({ version: '1.0.0-rc.2', changelog, notes: undefined }),
    ).toThrow(/no "## \[1.0.0-rc.2\]" section/)
  })

  it('rejects empty notes and notes written for another version', () => {
    expect(() => chooseReleaseNotes({ version: '1.0.0', changelog, notes: '  \n' })).toThrow(
      /empty/,
    )
    expect(() =>
      chooseReleaseNotes({ version: '1.0.1', changelog, notes: '# 1.0.0\n\nHello.\n' }),
    ).toThrow(/never mentions 1.0.1/)
  })

  it('accepts the notes that are written for the first release', () => {
    const notes = readFileSync(releaseNotesPath('0.1.0'), 'utf8')
    expect(chooseReleaseNotes({ version: '0.1.0', changelog, notes })).toContain(
      '# UK Tax Tracker 0.1.0',
    )
  })
})

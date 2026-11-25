import { pathToFileURL } from 'node:url'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/

export interface TagOptions {
  exact: boolean
  latest: boolean
  moving: boolean
}

// The tags one image gets: the exact version, the minor and major tags (1.2 and 1) that follow
// patch releases and the monthly base-image rebuild, and latest. A pre-release must never move a
// tag that users follow, so asking for one is an error rather than a quiet skip.
export function imageTags(version: string, options: TagOptions): string[] {
  if (!SEMVER.test(version)) throw new Error(`not a version: ${version}`)
  const stable = STABLE.exec(version)
  if (!stable && (options.latest || options.moving)) {
    throw new Error(`${version} is a pre-release and must not get a moving tag (latest, X.Y or X)`)
  }
  const tags: string[] = []
  if (options.exact) tags.push(version)
  if (options.moving && stable) {
    const [, major, minor] = stable
    tags.push(`${major}.${minor}`, `${major}`)
  }
  if (options.latest) tags.push('latest')
  if (tags.length === 0) throw new Error('no tags were requested')
  return tags
}

function main(): void {
  const [version, ...flags] = process.argv.slice(2)
  const known = new Set(['--exact', '--latest', '--moving'])
  if (version === undefined || flags.some((f) => !known.has(f))) {
    console.error('usage: image-tags.ts <version> [--exact] [--latest] [--moving]')
    process.exit(2)
  }
  const tags = imageTags(version, {
    exact: flags.includes('--exact'),
    latest: flags.includes('--latest'),
    moving: flags.includes('--moving'),
  })
  console.log(tags.join('\n'))
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

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLACEHOLDER = '__VERSION__'
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
export const INSTALLERS = ['install.sh', 'install.ps1'] as const

export interface InstallerFile {
  name: string
  contents: string
}

export function stampInstaller(name: string, source: string, version: string): string {
  if (!SEMVER.test(version)) throw new Error(`not a version: ${version}`)
  const occurrences = source.split(PLACEHOLDER).length - 1
  if (occurrences !== 1) {
    throw new Error(`${name} must contain ${PLACEHOLDER} exactly once, found ${occurrences}`)
  }
  const stamped = source.replace(PLACEHOLDER, version)
  // A carriage return after the shebang or inside a here-document breaks the shell script.
  return name.endsWith('.sh') ? stamped.replace(/\r\n/g, '\n') : stamped
}

// The format `sha256sum -c` and `shasum -a 256 -c` read.
export function checksumFile(files: InstallerFile[]): string {
  return files
    .map((f) => `${createHash('sha256').update(f.contents, 'utf8').digest('hex')}  ${f.name}\n`)
    .join('')
}

function main(): void {
  const [version, outDir] = process.argv.slice(2)
  if (version === undefined || outDir === undefined) {
    console.error('usage: stamp-installers.ts <version> <output-dir>')
    process.exit(2)
  }
  const files = INSTALLERS.map((name) => ({
    name,
    contents: stampInstaller(name, readFileSync(join('install', name), 'utf8'), version),
  }))
  mkdirSync(outDir, { recursive: true })
  for (const f of files) writeFileSync(join(outDir, f.name), f.contents, 'utf8')
  writeFileSync(join(outDir, 'SHA256SUMS'), checksumFile(files), 'utf8')
  console.log(`Stamped ${files.map((f) => f.name).join(', ')} with ${version} into ${outDir}`)
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

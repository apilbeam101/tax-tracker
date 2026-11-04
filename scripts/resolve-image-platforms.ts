import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export type OCIManifestEntry = {
  digest: string
  platform?: { os?: string; architecture?: string }
}

export type OCIImageIndex = { manifests: OCIManifestEntry[] }

export type PlatformDigest = { platform: string; digest: string }

// A multi-arch OCI index also lists non-image entries (buildx attestation referrers, provenance)
// tagged with platform "unknown/unknown": those are not a real platform to attest an SBOM for.
export function resolvePlatformDigests(index: OCIImageIndex): PlatformDigest[] {
  return index.manifests
    .filter(
      (entry) => entry.platform?.os !== undefined && entry.platform.architecture !== 'unknown',
    )
    .map((entry) => ({
      platform: `${entry.platform?.os}/${entry.platform?.architecture}`,
      digest: entry.digest,
    }))
}

function main(): void {
  const path = process.argv[2]
  if (path === undefined) {
    console.error('usage: resolve-image-platforms.ts <manifest-index.json>')
    process.exit(2)
  }

  const platforms = resolvePlatformDigests(JSON.parse(readFileSync(path, 'utf8')) as OCIImageIndex)
  // A workflow feeds this into a matrix: an empty result makes GitHub Actions silently skip the
  // job instead of failing it, so nothing would be attested and nothing would say so.
  if (platforms.length === 0) throw new Error(`no real platform entries found in ${path}`)
  console.log(JSON.stringify(platforms))
}

const entryPoint = process.argv[1]
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main()
}

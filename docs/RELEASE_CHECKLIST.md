# Release checklist

For maintainers. A release is a `vX.Y.Z` tag (or `vX.Y.Z-rc.N` for a pre-release) on a commit on
`master`. The tag runs [`release.yml`](../.github/workflows/release.yml): it re-verifies the commit,
publishes the image, publishes to npm, and creates the GitHub Release with the installers attached.

## Before tagging

1. CI is green on the `master` commit you will tag, including the `installers`, `docker` and
   `package` jobs.
2. On a branch, in one commit:
   - set the version: `npm pkg set version=X.Y.Z && npm install --package-lock-only`;
   - in `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and add an empty
     `## [Unreleased]` above it (when cutting a release after release candidates, rename the newest
     `-rc.N` section instead, folding in anything added since and dropping notes that only applied
     to the candidates);
   - if this is a new minor or major version, update the default image tag in
     `deploy/compose/docker-compose.yml`, `deploy/kubernetes/statefulset.yaml` and
     `deploy/kubernetes/cronjob-backup.example.yaml`.
   - Check `npm run changelog:check` passes.
3. Refresh the Node.js package the macOS installer falls back to, if a newer LTS release exists:
   `NODE_PKG_VERSION` and `NODE_PKG_SHA256` in [`install/install.sh`](../install/install.sh), with
   the checksum taken from `https://nodejs.org/dist/<version>/SHASUMS256.txt` for
   `node-<version>.pkg`.
4. Merge to `master`, wait for CI, and confirm `NPM_PUBLISH_ENABLED` is still `true` under the
   repository's Actions variables.

## Tag

```sh
git switch master && git pull
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
gh run watch
```

The workflow fails before publishing anything if the tag does not match `package.json` or the
changelog has no section for the version.

## Check the release

npm needs a few minutes before a new version shows up; do not read its absence straight after the
job as a failure.

```sh
# Image: both platforms, provenance, and one SBOM per platform
docker buildx imagetools inspect ghcr.io/apilbeam101/tax-tracker:X.Y.Z
gh attestation verify oci://ghcr.io/apilbeam101/tax-tracker:X.Y.Z --repo apilbeam101/tax-tracker
gh attestation verify oci://ghcr.io/apilbeam101/tax-tracker@<platform digest> \
  --repo apilbeam101/tax-tracker --predicate-type https://spdx.dev/Document/v2.3

# Anonymous pull works (the package is public)
docker logout ghcr.io; docker pull ghcr.io/apilbeam101/tax-tracker:X.Y.Z

# npm: version, dist-tag and provenance
npm view uk-tax-tracker@X.Y.Z version dist.attestations.provenance
npm view uk-tax-tracker dist-tags

# Installers attached and attested
gh release download vX.Y.Z -p 'install.*' -p SHA256SUMS -D /tmp/release-check
gh attestation verify /tmp/release-check/install.sh --repo apilbeam101/tax-tracker
```

Expect:

- **Release:** the image tags `X.Y.Z`, `X.Y`, `X` and `latest`, an npm version on `latest`, and a
  GitHub Release with `install.sh`, `install.ps1` and `SHA256SUMS`.
- **Pre-release:** only the exact image tag, an npm version on `next`, and a GitHub pre-release.
- **Docker Hub:** the same tags under `apilbeam101/tax-tracker`. The mirror job never fails the
  release, so check the tags on Docker Hub rather than the job's colour.
- **`--repo`, not `--owner`:** `gh attestation verify` needs `--repo` for a user-owned repository.
  The SBOM attestations are made per platform, so verify them against each platform's digest from
  `imagetools inspect`, not the multi-platform index.

If the npm publish fails, the GitHub Release is still created, but without the installers (they
would install a version npm does not have). Fix the cause and re-run the failed jobs. A version
that npm accepted can never be published again, so a fix that needs a new commit needs a new
version.

## Monthly jobs

`rebuild.yml` (1st of the month) rebuilds the newest release on a fresh base image, smoke-tests it,
pushes the moving tags (never the exact version) and scans what it pushed. `scan.yml` also runs on
the 15th against `latest`. GitHub disables scheduled workflows after 60 days without repository
activity; the mid-month scan reporting a stale image is the sign. After the first release from a
new set of workflows, start each once with "Run workflow".

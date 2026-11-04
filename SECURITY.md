# Security policy

## Supported versions

UK Tax Tracker is before 1.0. Only the latest release receives security fixes, so please check
whether a problem still exists in the newest version before reporting it.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Report it privately instead: on this
repository's **Security** tab, choose **Report a vulnerability**
(<https://github.com/apilbeam101/tax-tracker/security/advisories/new>). That opens a private
conversation with the maintainer.

Please include:

- the version (`tax-tracker --version`) and how you installed it;
- what you found, the steps to reproduce it, and what an attacker could do with it;
- anything you already know about a fix.

**Do not include real financial data, passphrases, recovery keys or secrets** in a report. If the
problem depends on data, describe it with made-up figures.

This is a personal project with a single maintainer, so reports are handled on a best-effort basis.
You will be told when a report has been seen and kept informed while it is investigated. A fix is
released as a new version, and the release notes say what was fixed once users have had a chance to
upgrade. If you would like credit for the report, say so.

## What counts

In scope: the application and its API, the installer scripts, the container image, the deployment
files in `deploy/`, and the release artefacts.

Some things are limits of the design, not vulnerabilities. The
[security model](docs/SECURITY_MODEL.md#what-this-does-not-protect-against) lists them, for example
that a machine which is compromised while the app is unlocked can be read, and that dates and
transaction types are not encrypted. Reports that the design could be better are welcome as
ordinary issues.

## Checking what you download

Releases are built by GitHub Actions with build provenance. You can check that a file or image came
from this repository's release workflow:

```sh
gh attestation verify oci://ghcr.io/apilbeam101/tax-tracker:<version> --repo apilbeam101/tax-tracker
gh attestation verify install.sh --repo apilbeam101/tax-tracker
npm view uk-tax-tracker@<version> dist.attestations.provenance
```

See [Desktop install](docs/INSTALL_DESKTOP.md#check-the-script-before-running-it) and
[Docker install](docs/INSTALL_DOCKER.md#image-tags) for the details.

## How the project looks for problems

Dependencies are checked with `npm audit` and Dependabot, the code with CodeQL, the history and
every change with secret scanning, and the published container image is rebuilt and scanned for
fixable vulnerabilities every month.

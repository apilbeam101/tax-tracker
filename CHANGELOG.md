# Changelog

All notable changes to this project are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows SemVer.

## [Unreleased]

### Added

- CI (`.github/workflows/ci.yml`): lint, typecheck, test, build on every push/PR, plus a separate `npm audit --omit=dev --audit-level=high` job.
- Secret scanning (`.github/workflows/secrets.yml`, `.gitleaks.toml`): gitleaks on every push/PR (diff-range) plus a monthly full-history scan.
- Dependabot (`.github/dependabot.yml`): monthly npm and GitHub Actions dependency updates, grouped minor/patch.
- Centralized Fastify error handling (`src/server/errors.ts`): a typed `HttpError` taxonomy (`BadRequestError`/`UnauthorizedError`/`NotFoundError`/`ConflictError`) plus a global error handler, so unrecognized errors no longer leak internal detail (e.g. a raw SQLite constraint message) to the client, while known/plugin-classified errors (rate limiting, CSRF, validation) still surface their real status and message.
- Structured environment-config validation (`src/server/config/env.ts`): collects every missing/invalid variable into one error instead of failing on the first, with real validation for `PORT` and `FX_RATE_POLICY`.
- Log redaction (`src/server/config/logging.ts`): cookies, auth headers, API keys, and secrets are scrubbed from Pino logs before they hit stdout.
- Fixture-based tests for the Tiingo, HMRC monthly CSV, and Frankfurter response parsers, which previously had thin or no coverage of their actual parsing logic.
- Docker packaging (`Dockerfile`, `.dockerignore`, `deploy/docker-compose.yml`, a new "Docker" section in the README) as an additional self-hosting option alongside the existing bare-Node/reverse-proxy setup. Non-root UID, `read_only` root filesystem with a `tmpfs` `/tmp` and a bind-mounted `/app/data`, `init: true` for correct SIGTERM handling, and the published port bound to `127.0.0.1` only (same posture as the non-Docker reverse-proxy setup).
- `PRAGMA temp_store = MEMORY` (`src/server/db/database.ts`) so SQLite never needs a writable temp directory for large queries, regardless of deployment mode.

### Changed

- Linting moved from ESLint (which had no working config — `npm run lint` failed outright) to Biome. `typescript-eslint`'s peer dependency doesn't yet support this project's TypeScript `^7`, and Biome has no such constraint.
- `npm run typecheck` now covers `scripts/` in addition to `src/server`/`src/shared` (previously ungated — two pre-existing type errors there are fixed).

[Unreleased]: https://github.com/apilbeam101/tax-tracker/commits/master

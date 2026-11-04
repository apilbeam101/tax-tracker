# Changelog

All notable changes to this project are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows SemVer.

## [Unreleased]

## [0.1.0-rc.1] - 2026-11-04

### Added

- Dark mode: a nav-bar toggle (next to the number-masking toggle) switches the whole UI between light and dark themes via a CSS custom-property token palette (`src/client/src/App.svelte`), including `color-scheme` for native form controls/scrollbars. Preference persists in `localStorage` and defaults to the OS `prefers-color-scheme` on first visit; a small same-origin bootstrap script (`public/theme-init.js`, CSP-safe — no inline script needed) applies it before first paint to avoid a light-theme flash. Canvas-based charts (`BarChart.svelte`, `LineChart.svelte`) resolve theme colors at draw time and redraw automatically when the theme changes.
- Automatic IRS dividend withholding: `DIV_PAY` transactions on USD-currency instruments now default `dividend_withholding_gbp` to 15% of gross (the US-UK tax treaty portfolio-dividend rate for a UK resident with a valid W-8BEN on file) when no withholding amount was explicitly entered or imported, on create, edit, CSV import, and Alpha Vantage dividend import alike. An explicitly entered value is never overwritten; if a gross-affecting edit is made to a transaction whose withholding still matches what auto-withholding would have computed (i.e. it was never hand-edited), it's recomputed from the new gross rather than left stale. New `src/server/services/tax/withholding.ts`. A startup reconciliation (`backfillAutoWithholding`, same file) backports this to USD dividends already in the database from before this feature existed — restarting the server after upgrading is enough to apply it, no manual data migration needed.
- Startup reconciliation (`backfillRealisedProjections` in `src/server/services/tax/recalc.ts`) retroactively links any pending RSU vest / ESPP purchase projection to a matching transaction that already existed before automatic linking was introduced, so pre-existing "stuck" projections stop showing as duplicates alongside their real transaction. Matching never crosses a UK tax-year boundary, even within the date tolerance below.
- CI (`.github/workflows/ci.yml`): lint, typecheck, test, build on every push/PR, plus a separate `npm audit --omit=dev --audit-level=high` job.
- Secret scanning (`.github/workflows/secrets.yml`, `.gitleaks.toml`): gitleaks on every push/PR (diff-range) plus a monthly full-history scan.
- Dependabot (`.github/dependabot.yml`): monthly npm and GitHub Actions dependency updates, grouped minor/patch.
- Centralized Fastify error handling (`src/server/errors.ts`): a typed `HttpError` taxonomy (`BadRequestError`/`UnauthorizedError`/`NotFoundError`/`ConflictError`) plus a global error handler, so unrecognized errors no longer leak internal detail (e.g. a raw SQLite constraint message) to the client, while known/plugin-classified errors (rate limiting, CSRF, validation) still surface their real status and message.
- Structured environment-config validation (`src/server/config/env.ts`): collects every missing/invalid variable into one error instead of failing on the first, with real validation for `PORT` and `FX_RATE_POLICY`.
- Log redaction (`src/server/config/logging.ts`): cookies, auth headers, API keys, and secrets are scrubbed from Pino logs before they hit stdout.
- Fixture-based tests for the Tiingo, HMRC monthly CSV, and Frankfurter response parsers, which previously had thin or no coverage of their actual parsing logic.
- Docker packaging (`Dockerfile`, `.dockerignore`, `deploy/docker-compose.yml`, a new "Docker" section in the README) as an additional self-hosting option alongside the existing bare-Node/reverse-proxy setup. Non-root UID, `read_only` root filesystem with a `tmpfs` `/tmp` and a bind-mounted `/app/data`, `init: true` for correct SIGTERM handling, and the published port bound to `127.0.0.1` only (same posture as the non-Docker reverse-proxy setup).
- `PRAGMA temp_store = MEMORY` (`src/server/db/database.ts`) so SQLite never needs a writable temp directory for large queries, regardless of deployment mode.
- Secret settings (`SESSION_SECRET`, `ENCRYPTION_KEY`, `TIINGO_API_KEY`, `ALPHA_VANTAGE_API_KEY`) accept a `_FILE` variant for Docker secrets, Kubernetes secret volumes and systemd `LoadCredential=`. Setting both forms is a configuration error (`src/server/config/secrets.ts`).
- `SECURE_COOKIES` (`auto` | `true` | `false`, default `auto`) controls the session cookie `Secure` flag. `auto` marks it Secure only when the request arrived over HTTPS (`src/server/session.ts`).
- `TRUST_PROXY` (`true`, `false`, or a comma-separated list of IPs, CIDRs or `loopback`/`linklocal`/`uniquelocal`) is passed to Fastify so reverse-proxy deployments see the original protocol. Numeric hop counts are rejected.
- Per-user data directory resolution (`src/server/config/paths.ts`): `DB_PATH`, then `DATA_DIR`, then an existing `./data/taxtracker.db`, otherwise the OS default (`%APPDATA%\tax-tracker`, `~/Library/Application Support/tax-tracker`, or `$XDG_DATA_HOME`/`~/.local/share/tax-tracker`). The resolved path is printed at startup, and the `scripts/` utilities use the same resolution.
- `LOG_LEVEL` (default `info`), validated at startup.
- `GET /health` also returns `version` and `commit` (from `GIT_COMMIT`, default `unknown`). The Dockerfile accepts a `GIT_COMMIT` build argument and sets `DATA_DIR=/app/data` and `LOG_LEVEL=warn`.
- Key slots (`src/server/crypto/`, migration `006_key_slot.sql`): the data encryption key (DEK) is wrapped by one key-encryption key per slot, stored in a new `key_slot` table. A passphrase slot uses argon2id. A recovery slot uses a 256-bit random key, shown once as 55 Crockford base32 characters in groups of five with a 16-bit checksum, and derives its key with HKDF-SHA256. An optional unattended slot stretches `ENCRYPTION_KEY` with argon2id. Wrapping is AES-256-GCM with a random 96-bit nonce, and the associated data binds the slot type and key id. The module can create slots, unlock through any slot, change the passphrase, reset it with the recovery key, rotate the recovery key, and set or remove the unattended key. Slot writes are recorded in `audit_log` without key material and can run inside a caller's transaction. The primitives are covered by known-answer tests: AES-256-GCM against NIST GCM test case 15, HKDF against RFC 5869 test case 1, and the argon2id parameter mapping cross-checked against `node:crypto` `argon2Sync`.
- Lock state (`src/server/crypto/keyring.ts`, `src/server/crypto/session-tracker.ts`, `src/server/lock.ts`): the data encryption key lives in one in-memory keyring that is overwritten on lock. A session tracker mirrors the 8-hour idle window and drops the key when the last live session ends, by logout, idle timeout or sweep. While locked, API routes return `423` with `code: "LOCKED"` before authentication or body parsing; `/health`, `/api/auth/*` and the static client stay available.
- Account recovery and passphrase change: `POST /api/auth/recover` takes a recovery key and a new passphrase, and `POST /api/auth/change-passphrase` takes the current and new passphrase. Each updates the login hash and the passphrase key slot in one transaction and signs out every other session. Sign-in opens the passphrase slot, so it also unlocks the data; if the passphrase is accepted but does not open the slot, login returns `423` with code `UNLOCK_FAILED`. A "Forgot your passphrase?" link on the sign-in page opens a new Recover screen when key slots exist.
- The client shows a notice on the sign-in page when the data is locked, and any data request that returns `423` (locked) or `401` (session ended) returns the app to sign-in (`src/client/src/lib/api.ts`).
- `GET /api/auth/status` reports `locked` and `unlockMode` (`none`, `passphrase` or `unattended`). `HttpError` takes an optional `code`, which the error handler returns alongside `error` and `message`.
- API keys entered through the UI are stored in a new encrypted `app_secret` table.
- Upgrade flow for existing databases: a signed-in user migrates an existing database to the current storage format from an upgrade screen (`src/client/src/routes/Upgrade.svelte`) by confirming their passphrase, or defers it with "Not now".
  - Automatic unlock with `ENCRYPTION_KEY` is set up only if the user opts in.
  - The recovery key screen (`src/client/src/routes/RecoveryKey.svelte`) shows the key once and requires it to be typed back before the safety copy made before the upgrade is removed. A user who did not save the key can create a new one.
  - Requests against an already-upgraded database return code `ALREADY_ENCRYPTED`.
- Endpoints `POST /api/auth/upgrade`, `POST /api/auth/upgrade/confirm` and `POST /api/auth/recovery-key/rotate`.
  - `GET /api/auth/status` adds `upgrade` (`none`, `available` or `confirm`) and `unattendedKeyAvailable`.
  - The upgrade lists older copies of the database (backup-script output, `.bak` files, Ghostfolio exports) so the user can review them.
- First-run setup creates the key slots itself, reusing the upgrade's recovery key screen: choosing a passphrase signs the user in and shows a recovery key that must be typed back before continuing, so a fresh install starts in the current storage format and never sees the upgrade screen. If the database already holds data, setup only creates the user and the in-app upgrade is offered at sign-in. Confirming a recovery key after a fresh install does not remove any safety copies.
- `AUTO_CONFIG` (default `false`): when `true` ("self-configured" mode), a generated `SESSION_SECRET` and the non-secret settings `HOST`, `PORT`, `FX_RATE_POLICY`, `LOG_LEVEL`, `SECURE_COOKIES` and `TRUST_PROXY` are kept in `config.json` in the data directory, written atomically (mode `0600` on Linux and macOS). The file never holds key material or API keys, and environment variables always override it. The default mode reads only the environment and writes nothing.
- Settings page for API keys: Tiingo and Alpha Vantage keys can be entered in a new Settings page and are stored encrypted. A saved key applies without a restart. Keys supplied through the environment (including `_FILE` variants) always take precedence, and in the default environment-supplied mode the API key fields are read-only.
- `runInit()` (`src/server/init.ts`) prepares the config file and reports where data lives; the `init` command will use it once the CLI is added.
- `tax-tracker` command-line tool (`src/server/cli.ts`, `src/server/cli-args.ts`, `src/server/commands/`), shipped as the `uk-tax-tracker` package with bin `tax-tracker`. Commands: `start` (the default), `init` (`--interactive` prompts for `FX_RATE_POLICY` in self-configured mode), `info`, `doctor` (never prints or asks for key material), `backup` (writes a snapshot to `<data dir>/backups` via SQLite's backup API), `backfill-fx`, and `keys add-unattended`, `keys remove-unattended`, `keys rotate-recovery`.
- `tax-tracker` flags: `--port` (0 picks a free port), `--host`, `--data-dir`, `--env-file`, `--open` (opens the browser once the server is listening), `--interactive`.
- `PORT=0` is accepted and lets the OS pick a free port (`src/server/config/env.ts`).
- `scripts/check-pack-allowlist.ts` (`npm run pack:check`) fails the build if the packed tarball is missing a runtime file or contains environment files, databases, config files, tests or sources. `scripts/smoke-pack.ts` (`npm run pack:smoke`) installs the packed tarball into an empty directory, starts it on a free port and probes `/health`. Both run in CI (`.github/workflows/ci.yml`), and the smoke test runs on Ubuntu, macOS and Windows.
- README and `.env.example` document `AUTO_CONFIG`, the Settings page and first-run setup.
- `tax-tracker keys rotate` (`src/server/crypto/rotate.ts`, `src/server/commands/rotate.ts`): replaces the data encryption key. Offline only; it takes a `pre-rotation` backup, then in one verified transaction re-encrypts every encrypted column and the blind index under a new key, re-wraps the passphrase slot, issues a new recovery key (shown once, unconfirmed until typed back) and carries an existing unattended slot over only with the `ENCRYPTION_KEY` that opens it (`--drop-unattended` removes it; a slot is never created). A failure or interruption leaves the database as it was, and old ciphertext is scrubbed from free pages and the write-ahead log afterwards.
- Release pipeline (`.github/workflows/release.yml`, `_publish-image.yml`, `rebuild.yml`, `scan.yml`): a `v*.*.*` tag re-verifies the commit (lint, typecheck, tests, build, package allowlist, tag matches `package.json`, CHANGELOG has the section), publishes a multi-arch (`linux/amd64`, `linux/arm64`) image to GHCR with build provenance and per-platform SBOM attestations, optionally publishes to npm with trusted publishing and provenance (`NPM_PUBLISH_ENABLED`), and creates a GitHub Release from the CHANGELOG section. The same multi-arch image is also copied to Docker Hub as a best-effort mirror using the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets; a mirror failure does not fail the release, and attestations stay on GHCR. The latest release's image is rebuilt monthly, smoke-tested (version and commit) before the moving tags are pushed, and then scanned with Trivy by digest; a second scan of `:latest` runs mid-month as a backstop and only fixable high/critical findings are reported.
- `scripts/extract-changelog-section.ts`, `scripts/check-changelog.ts` (`npm run changelog:check`) and `scripts/resolve-image-platforms.ts`, with tests; CI builds the image for both platforms and smoke-tests the amd64 one.
- Backup service (`src/server/services/backup/`): snapshots are taken with `VACUUM INTO` (one consistent snapshot even while another process keeps writing), verified before they are listed, and named `taxtracker-<timestamp>-<reason>.db`. Reasons are `manual`, `scheduled`, `pre-migration`, `pre-restore` and `pre-import`. Only `manual` and `scheduled` backups are pruned, to 14 of each.
- Automatic `pre-migration` backup, taken before pending migrations run on an existing database. Migration list helpers live in `src/server/db/migration-files.ts`.
- Restore: a backup is validated (SQLite header, integrity check, migrations known to this version, tenant, and key slots plus an account when it has key slots), staged as `restore-pending.db` and swapped in before the database is opened. The current database is backed up first. An unprotected backup can replace an unprotected database but not a protected one, and a restore is refused when the server's `ENCRYPTION_KEY` cannot open the backup.
- `tax-tracker restore` runs offline. It checks and holds `server.lock`, a heartbeat file that works across containers, and a starting server waits for a fresh foreign lock and then refuses to start.
- `BACKUP_SCHEDULE` (`daily` or `off`): `daily` is the default only in self-configured mode. It can also be set in `config.json`.
- `RESTORE_RESTART` (`manual` or `exit`): `exit` makes the server exit after staging a restore so a supervisor can restart it. The default is `manual`.
- Versioned JSON archive export and import (`src/server/services/backup/archive.ts`): `tax-tracker export` and `tax-tracker import`, `POST /api/export/archive` and `POST /api/import/archive`, and a "Backups & archive" tab on the Import / Export page (`src/client/src/routes/Backups.svelte`). Archives are encrypted with an export passphrase by default, and a plaintext export requires explicit confirmation.
- Import validates every field, runs in a single transaction, remaps ids, recalculates CGT and never changes existing tax year settings. It can load into an empty database or replace the current data, and replace takes a backup first.
- A navigation badge and a list on the Backups tab flag leftover unencrypted copies of the data (earlier backups, `.bak` files, Ghostfolio exports) once the database itself is encrypted, and `POST /api/backup/plaintext-copies/delete` removes selected ones. Files that cannot be opened are listed but never offered for deletion, and the upgrade's own safety copy is held back until its recovery key is confirmed.
- `export`, `import` and `keys` accept the recovery key as well as the passphrase at the prompt.
- `--yes` skips the confirmation prompts of `restore`, `export --plaintext` and `import --replace`, for scripts and shells without a terminal.
- API routes `GET /api/backup`, `POST /api/backup`, `GET /api/backup/:name` and `POST`/`DELETE /api/backup/restore` (`src/server/routes/backup.ts`).
- README and `.env.example` document backup, restore, export and import, including container recipes.

### Changed

- `SESSION_SECRET` and `ENCRYPTION_KEY` are rejected at startup if they are `CHANGE_ME` placeholders, hex strings under 64 characters, or other strings under 32 characters. `ENCRYPTION_KEY` is now optional. A `.env` copied unedited from `.env.example` will fail to start until the placeholders are replaced.
- The cookie `Secure` flag no longer follows `NODE_ENV=production`. Deployments behind a TLS proxy should set `TRUST_PROXY` (for example `loopback`, or `uniquelocal` for Docker) so `auto` detects HTTPS.
- A fresh install with no `DB_PATH` or `DATA_DIR` stores its database in the OS data directory rather than `./data`. An existing `./data/taxtracker.db` is still used.
- Logging level comes from `LOG_LEVEL` instead of `NODE_ENV`, so a non-Docker production start now logs at `info` by default. `pino-pretty` is used only when stdout is a TTY and the module resolves, which fixes a crash on production installs without dev dependencies.
- Log redaction now also scrubs `body` fields and `passphrase`, `newPassphrase`, `recoveryKey`, `dataKey`, `dek` and `wrappedDek`, at the top level and one level deep.
- The client bundle path is resolved from the package root rather than `process.cwd()`.
- Secrets supplied through a plain environment variable now have surrounding whitespace trimmed, matching `_FILE` behaviour, so a trailing newline no longer changes a secret's bytes (`src/server/config/secrets.ts`).
- The startup recalc and backfill jobs run through an unlock hook, once per process: at boot when the data is unprotected or an unattended key opens it, otherwise on first unlock, and retried after a failed run.
- An `ENCRYPTION_KEY` that does not open the unattended key slot now stops the server from starting. If no unattended slot exists, the key is ignored with a warning.
- New password hashes are NFKC-normalised. Verification still accepts hashes made from the raw string.
- Login, recover and change-passphrase request bodies have length limits: usernames 255 characters, passphrases 1024, recovery keys 200.
- Log redaction also scrubs `currentPassword`.
- Sensitive columns, audit log snapshots and cached prices are encrypted with AES-256-GCM by the repository stores, each value bound to its table, column and row. Keys, dates, transaction types, currencies, tax-year config and FX rates stay readable; `src/server/crypto/fields.ts` lists every column. This applies to databases that have key slots.
- Ticker lookups and uniqueness use a keyed blind index (`instrument.ticker_bidx`, migration `007_field_encryption.sql`).
- `backfill-fx`, `fetch-dividends` and `import-ghostfolio` refuse to run against an encrypted database, since they cannot unlock it. Use the app's Import / Export page instead.
- Startup logs no longer include instrument tickers.
- The upgrade is verified before it commits, so a failure leaves the database as it was, and the running app switches to the new format in the same step as the commit.
- After an upgrade, a WAL checkpoint, `VACUUM` and a further checkpoint clear superseded data from the database file and its WAL. The result is verified (a blocked checkpoint counts as not done) and retried at each start until it completes.
- `secure_delete` is always on, and the database connection sets a busy timeout. Maintenance scripts take the write lock and re-check before writing.
- `npm run backup` uses SQLite's backup API instead of a file copy, since a plain copy of a WAL database can miss committed transactions.
- The README and `.env.example` describe `ENCRYPTION_KEY` as an optional automatic-unlock key; it is commented out in `.env.example`.

- Linting moved from ESLint (which had no working config — `npm run lint` failed outright) to Biome. `typescript-eslint`'s peer dependency doesn't yet support this project's TypeScript `^7`, and Biome has no such constraint.
- `npm run typecheck` now covers `scripts/` in addition to `src/server`/`src/shared` (previously ungated — two pre-existing type errors there are fixed).
- The Tax Summary dividend and confirmed-ESPP-purchase transaction tables now show the transaction date instead of a bare, unlinked transaction ID.
- Package renamed from `claude-tax` to `uk-tax-tracker`, with a `bin` entry for `tax-tracker` and a `files` allowlist (`dist`, `LICENSE`, `README.md`) (`package.json`).
- `npm start` runs the CLI (`dist/server/cli.js`) and no longer loads `.env` implicitly. Pass `--env-file .env` or set the environment instead. `npm run start:dev` runs the CLI from source.
- The CLI defaults to self-configured mode (`AUTO_CONFIG=true`) unless `AUTO_CONFIG` is already set, including an explicit `false`. `.env.example` now sets `AUTO_CONFIG=false` so a `.env`-driven setup keeps its settings in the environment.
- `npm run build` removes `dist` before building.
- `pino-pretty` moved from devDependencies to optionalDependencies.
- The loaded-config singleton moved from `src/server/config/env.ts` to `src/server/config/current.ts`, so importing `env.ts` no longer loads configuration or creates `config.json`.
- Config file JSON parse errors report that the file is not valid JSON without quoting its content (`src/server/config/file.ts`).
- `tsconfig.server.json` excludes tests, the client and `test-harness.ts` from the server build.
- The Docker image's entrypoint is now the `tax-tracker` command (default command `start`), so `docker compose run --rm tax-tracker restore ...` and `docker compose exec tax-tracker tax-tracker backup` work; `tax-tracker` is on the image's `PATH`. Containers stay in env-supplied mode (`AUTO_CONFIG=false` in the image). Production dependencies are now installed per target platform (the native argon2 binary), and the image carries `GIT_COMMIT` / `IMAGE_VERSION` build arguments and OCI labels.
- `tax-tracker backup` uses the shared backup service and names files by reason, replacing the earlier script output naming.
- `BadRequestError` (`src/server/errors.ts`) accepts an optional `code`, as `HttpError` does.
- `recalcAllInstruments` (`src/server/services/tax/recalc.ts`) takes a narrower dependency type.
- `createTestDb` (`src/server/db/testdb.ts`) records applied migrations in `_migrations`.
- The price and FX stores are available on the app instance (`src/server/app.ts`).

### Fixed

- Projection-to-transaction linking (`src/server/services/tax/recalc.ts`) required the scheduled date and the transaction date to match exactly, so any real-world settlement drift (weekends, broker lag) silently left the projection duplicated forever. Widened to a ±7-day tolerance, preferring the closest date and then the closest quantity.
- The Projections page's delete action (`src/client/src/routes/Projections.svelte`) silently ignored a failed `DELETE` request (e.g. an expired CSRF token) and reloaded the list as if it had succeeded, making a failed delete indistinguishable from a real bug. It now surfaces a visible error instead.

### Removed

- The `npm run backup` script and `scripts/backup.ts`; use `tax-tracker backup`.
- `scripts/backfill-fx.ts`; use `tax-tracker backfill-fx`.

[Unreleased]: https://github.com/apilbeam101/tax-tracker/commits/master

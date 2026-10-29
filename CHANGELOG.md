# Changelog

All notable changes to this project are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows SemVer.

## [Unreleased]

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

- Linting moved from ESLint (which had no working config — `npm run lint` failed outright) to Biome. `typescript-eslint`'s peer dependency doesn't yet support this project's TypeScript `^7`, and Biome has no such constraint.
- `npm run typecheck` now covers `scripts/` in addition to `src/server`/`src/shared` (previously ungated — two pre-existing type errors there are fixed).
- The Tax Summary dividend and confirmed-ESPP-purchase transaction tables now show the transaction date instead of a bare, unlinked transaction ID.

### Fixed

- Projection-to-transaction linking (`src/server/services/tax/recalc.ts`) required the scheduled date and the transaction date to match exactly, so any real-world settlement drift (weekends, broker lag) silently left the projection duplicated forever. Widened to a ±7-day tolerance, preferring the closest date and then the closest quantity.
- The Projections page's delete action (`src/client/src/routes/Projections.svelte`) silently ignored a failed `DELETE` request (e.g. an expired CSRF token) and reloaded the list as if it had succeeded, making a failed delete indistinguishable from a real bug. It now surfaces a visible error instead.

[Unreleased]: https://github.com/apilbeam101/tax-tracker/commits/master

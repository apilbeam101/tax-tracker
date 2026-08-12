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

### Changed

- Linting moved from ESLint (which had no working config — `npm run lint` failed outright) to Biome. `typescript-eslint`'s peer dependency doesn't yet support this project's TypeScript `^7`, and Biome has no such constraint.
- `npm run typecheck` now covers `scripts/` in addition to `src/server`/`src/shared` (previously ungated — two pre-existing type errors there are fixed).
- The Tax Summary dividend and confirmed-ESPP-purchase transaction tables now show the transaction date instead of a bare, unlinked transaction ID.

### Fixed

- Projection-to-transaction linking (`src/server/services/tax/recalc.ts`) required the scheduled date and the transaction date to match exactly, so any real-world settlement drift (weekends, broker lag) silently left the projection duplicated forever. Widened to a ±7-day tolerance, preferring the closest date and then the closest quantity.
- The Projections page's delete action (`src/client/src/routes/Projections.svelte`) silently ignored a failed `DELETE` request (e.g. an expired CSRF token) and reloaded the list as if it had succeeded, making a failed delete indistinguishable from a real bug. It now surfaces a visible error instead.

[Unreleased]: https://github.com/apilbeam101/tax-tracker/commits/master

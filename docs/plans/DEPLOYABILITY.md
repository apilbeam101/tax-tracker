# Deployability plan

Branch: `feat/deployability`

Goal: someone who is comfortable installing an app, but not with Node, Docker or `.env` files, can install tax-tracker with one command, keep their data safe, and upgrade without losing anything. The ops-style deployments (Docker, Kubernetes, systemd) become first-class at the same time, published from one tagged release. Encryption and secret handling are extended alongside, so that every install path gets the same protection for data at rest.

Target install paths, in order of expected audience size:

| Audience | Install | Run | Upgrade |
|---|---|---|---|
| Laptop user, macOS | `curl -fsSL …/install.sh \| sh` | Login item, or `tax-tracker` | `tax-tracker upgrade` / re-run installer |
| Laptop user, Windows | `irm …/install.ps1 \| iex` | Login task, or `tax-tracker` | same |
| Has Node 24 already | `npx uk-tax-tracker` | same command | `npx uk-tax-tracker@latest` |
| Home server / NAS | `docker compose up -d` (published image) | always-on | `docker compose pull && up -d` |
| Kubernetes | `kubectl apply -k deploy/kubernetes` | single replica + PVC | bump image tag |
| Linux server, no containers | npm global install + systemd unit | always-on | `npm i -g uk-tax-tracker@latest` |

Commit messages, CHANGELOG entries and user-facing doc wording are approved by the maintainer before every commit or push.

---

## Phase 1: Runtime foundations and secret handling

These changes help every install path, so they come first. No packaging yet.

1. **Resolve assets from the package, not the cwd.** [app.ts:31](../../src/server/app.ts#L31) resolves `dist/client` from `process.cwd()`. Replace it with a `packageRoot()` helper that walks up from `import.meta.url` to the nearest `package.json`. That works the same from `src/server` (tsx) and from `dist/server` (compiled). Migrations keep resolving relative to [database.ts](../../src/server/db/database.ts) itself, which is already correct under both tsx and the compiled build (`build:server` copies them into `dist/server/db/migrations`).
2. **Per-user data directory.** New `config/paths.ts`, used in this order:
   - `DB_PATH` / `DATA_DIR` env vars, or the `--data-dir` flag (Phase 3)
   - `./data` if it already contains `taxtracker.db`, so existing source installs keep working
   - the OS default: `%APPDATA%\tax-tracker`, `~/Library/Application Support/tax-tracker`, or `${XDG_DATA_HOME:-~/.local/share}/tax-tracker`

   Log the resolved path at startup, every time.
3. **Decouple `NODE_ENV`.** Today it controls two unrelated things:
   - **Logging:** use `pino-pretty` only when stdout is a TTY *and* the module resolves; otherwise use plain JSON. This removes the crash when a production install lacks dev dependencies.
   - **Secure cookies:** new `SECURE_COOKIES` setting (`auto` | `true` | `false`). `auto` means secure when the request arrived over HTTPS (with `trustProxy` configured), which covers the reverse-proxy, Caddy and Kubernetes ingress cases without ever breaking `http://localhost`.
4. **Secret input hardening.**
   - Every secret env var accepts a `_FILE` variant (`SESSION_SECRET_FILE`, `ENCRYPTION_KEY_FILE`, `TIINGO_API_KEY_FILE`, …) for Docker secrets, Kubernetes secret volumes and systemd `LoadCredential=`.
   - `buildConfig()` rejects placeholder values (`CHANGE_ME…`) and secrets shorter than 32 bytes (64 hex chars).
   - `ENCRYPTION_KEY` becomes optional. It's the unattended-unlock key for server deployments (Phase 2).
   - Extend the Pino redaction paths ([logging.ts](../../src/server/config/logging.ts)) to cover key material and the request bodies of the setup and unlock routes.
5. **Version endpoint.** `/health` returns `{ status, version, commit }`. `version` comes from `package.json`, and `commit` from a `GIT_COMMIT` build arg/env var, matching the exporters.

Tests: unit tests for `packageRoot()`, data-dir precedence, `_FILE` resolution, placeholder rejection, the logger fallback, and cookie `secure` resolution (using a live Fastify instance with `trustProxy`, not mocks; see the phased-review memory). A redaction test checks that logging a fake unlock request emits no key material.

## Phase 2: First-run setup and key management

Key handling has to work the same way across every install path before self-configuration (and later backup/restore) can rely on it, so this phase covers both.

### 2a. Key slots
- The data encryption key (DEK) is wrapped by one or more key-encryption keys, each stored as a row in a `key_slot` table (`slot_type`, `kdf_params`, `salt`, `wrapped_dek`, `key_id`, `created_at`):

| Slot | Key source | Presence |
|---|---|---|
| `passphrase` | argon2id over the login passphrase, with its own salt and parameters (separate from the password-verification hash) | Always |
| `recovery` | 256-bit random recovery key, shown once at setup as grouped base32 with a checksum | Always |
| `unattended` | `ENCRYPTION_KEY` / `ENCRYPTION_KEY_FILE`, supplied by the deployment, stretched with argon2id (a leaked database must not expose a weak operator-chosen key to fast offline guessing) | Optional |

- Unlocking unwraps the DEK from any one slot, and the DEK is held only in memory.
- Changing the passphrase rewraps that slot; no field data is re-encrypted. "Forgot passphrase" uses the recovery key to set a new one. A lost or exposed recovery key is replaced by rotating it while unlocked.
- Slot changes are audited in `audit_log` (action only, no key material) and can be applied inside a caller's transaction, so a passphrase change updates the login hash and the slot together.
- The unattended key must live outside the data volume, so a volume snapshot or a DB backup never carries the key that opens it. `doctor` (Phase 3) warns otherwise.

| Deployment | Slots | After restart |
|---|---|---|
| Laptop (installer, npx) | passphrase + recovery | Locked until login. No key material on disk. |
| Docker / compose (default) | passphrase + recovery | Locked until login |
| Docker / compose, Kubernetes, systemd (opt-in) | + unattended via Docker secret, `Secret` volume or `LoadCredential=` | Unlocks at boot |

### 2b. Lock state
- **Locked:** only `/health`, `/api/auth/*` and the static client are served. Other API routes return `423 Locked` with a stable error code, and the client ([api.ts](../../src/client/src/lib/api.ts)) shows the unlock screen.
- **Existing databases without key slots** are unprotected and behave as before until 2d creates the slots. Any `key_slot` row marks a database as protected, so deleting one slot cannot silently downgrade it.
- **Sign-in is unlock:** the login passphrase is also the passphrase slot, so `POST /api/auth/login` verifies the hash and opens the slot; `POST /api/auth/recover` (recovery key plus new passphrase) and `POST /api/auth/change-passphrase` update the hash and the slot in one transaction. A credential change signs out every other session.
- **Unlocked:** the DEK is held while any session is valid. Logout of the last session, or the 8-hour idle timeout, drops it. Unattended mode stays unlocked for the process lifetime.
- **Startup work:** `recalcAllInstruments()`, `backfillRealisedProjections()` and `backfillAutoWithholding()` ([app.ts](../../src/server/app.ts)) move to an `onUnlock` hook, so they run at boot in unattended mode and on first unlock otherwise.
- **While locked:** scheduled backups still run, since they copy ciphertext. FX fetches still run, since that's public data. Price refresh waits for unlock.
- One module holds the DEK and overwrites the buffer on lock. Document this as best-effort, since strings derived from it can't be zeroised.

### 2c. Field coverage and format
- Encrypt on write and decrypt on read in the repository stores ([repositories/](../../src/server/repositories/)) only. Services keep receiving plaintext domain objects, so the tax engine is unchanged. SQL elsewhere that read, filtered or wrote an encrypted column (the projections, Tax Summary and chart routes, projection linking and the auto-withholding backfill) was moved into the stores or into code over decrypted objects, with a new `VestScheduleStore`.
- Until the CLI can unlock a database (Phase 3), the maintenance scripts that write columns directly (`backfill-fx`, `fetch-dividends`, `import-ghostfolio`) refuse to run against an encrypted database.
- Format: `v1.<keyId>.<base64url(nonce ‖ ciphertext ‖ tag)>`, AES-256-GCM with a 96-bit random nonce per value. The plaintext is length-prefixed and padded to a multiple of 32 bytes first, so ciphertext length does not reveal short enumerated values or the size of amounts. The AES key is derived from the DEK by HKDF, separate from the key id and the blind-index key.
  - AAD = `<table>.<column>.<rowId>`, so values can't be swapped between rows or columns.
  - Row IDs are allocated explicitly before the insert (what `AUTOINCREMENT` would assign), and upserts update the existing row rather than replacing it, so a value's row ID never changes.
  - `NULL` stays `NULL`.
  - Decryption failure is a hard error.
- A column registry (`crypto/fields.ts`) classifies every column as encrypted or deliberately plaintext. A test fails if any schema column is unclassified.

| Table | Encrypted columns |
|---|---|
| `instrument` | `ticker`, `isin`, `name`, `exchange`, `is_employer_stock`, `rsu_withholding_method`, `notes` |
| `txn` | `quantity`, `unit_price_native`, `fx_rate`, `unit_price_gbp`, `total_gbp`, `costs_gbp`, `net_gbp`, `income_amount_gbp`, all `rsu_*`, all `dividend_*`, `split_ratio`, `capreturn_per_share_gbp`, `notes`, `import_source` |
| `s104_pool` | `pool_quantity`, `pool_cost_gbp` |
| `cgt_disposal` | `quantity`, `proceeds_gbp`, `allowable_cost_gbp`, `selling_costs_gbp`, `gain_gbp` |
| `vest_schedule` | `quantity`, `expected_price_usd`, `notes` |
| `price` | `close_price` (`instrument_id` stays a plain foreign key; the instrument's identity is protected because its ticker, name and ISIN are encrypted) |
| `audit_log` | `old_data`, `new_data`, `ip_address` |
| `app_secret` (new) | API keys entered through the UI |

- Plaintext: keys, `tenant_id`, dates, `txn_type`, currencies, `instrument_type`, `match_type`, `tax_year`, `tax_year_config`, the `fx_rate` table, and timestamps. These are needed for indexing and tax-year bucketing.
- **Blind index:** `instrument` has `UNIQUE(tenant_id, ticker)` and a ticker lookup in [InstrumentStore.ts:56](../../src/server/repositories/sqlite/InstrumentStore.ts#L56).
  - Add `ticker_bidx = HMAC-SHA256(K_bidx, table.column.tenant ‖ ticker)`, with `K_bidx` derived from the DEK via HKDF. The ticker is matched exactly (case-sensitive), as the original `UNIQUE(tenant_id, ticker)` did.
  - A trigger refuses an instrument row without `ticker_bidx` once any key slot exists, so a writer that forgets the index cannot silently lose the uniqueness rule. The 2d upgrade must set `ticker` and `ticker_bidx` in the same `UPDATE`.
  - Uniqueness moves to `UNIQUE(tenant_id, ticker_bidx)`.
  - `ORDER BY ticker` moves into the store.
  - No SQL arithmetic, range query or other ordering touches these columns (checked 2026-10-26; all arithmetic is in-app via big.js).

### 2d. Upgrading existing databases
- On the first unlock after upgrading, in one transaction:
  1. Create the key slots if absent. Existing installs get a one-time screen that confirms the passphrase and shows the recovery key.
  2. Rewrite every classified column into the current format and build the blind indexes.
  3. Then run `PRAGMA secure_delete = ON` (kept on permanently), `wal_checkpoint(TRUNCATE)` and `VACUUM`, so no superseded values remain in freed pages or the WAL.
- The upgrade is user-initiated (a signed-in user confirms their passphrase on an "Encrypt your data" screen; "Not now" defers it to the next sign-in). It verifies every rewritten value by reading it back before it commits, so a failure or interruption leaves the database exactly as it was. The running app starts encrypting in the same synchronous step as the commit, so no request can write a plaintext row in between. If `ENCRYPTION_KEY` is configured, the user may opt in to also creating the unattended slot; it is never created implicitly.
- Backups taken before the upgrade aren't in the current format. The app lists them (backup-script output, `.bak` files, Ghostfolio exports, other leftover safety copies) and prompts the user to delete or replace them; a backup that carries key slots is not listed. A persistent badge is a Phase 4 item.
- Before anything changes, a plaintext safety copy is written through SQLite's backup API (not a file copy) so a failed upgrade is recoverable. It is removed only after the user types the recovery key back. Whether the recovery key was confirmed is recorded in the database (audit log), not inferred from files, so deleting the safety copy cannot hide an unconfirmed key; a user who closed the window can create a new recovery key and confirm that.
- The clean-up (checkpoint, `VACUUM`, checkpoint) is verified rather than assumed: a blocked checkpoint or leftover free pages count as not done. A pending clean-up is recorded and retried at every start until it completes.

### 2e. Self-configuring first run (optional mode)
Two config modes, chosen explicitly:

- **Env-supplied** (current behaviour; the default for Docker and Kubernetes). Secrets come from the environment or `_FILE` paths, and the app never writes config.
- **Self-configured** (the default for the CLI and installers; opt-in for containers via `AUTO_CONFIG=true`). On first start, if no `SESSION_SECRET` is supplied, generate it into `<dataDir>/config.json` and reuse it on later starts. Env vars always override file values.

`config.json` holds `SESSION_SECRET` and non-secret settings only, **never** key material. API keys entered through the UI go to the encrypted `app_secret` table.

Details:
- Write `config.json` with mode `0600` on POSIX. On Windows, rely on `%APPDATA%` being per-user, and have the installer tighten the ACL with `icacls`, since Node's `mode` is ignored there.
- Write the file atomically (temp file + rename) so an interrupted first run can't leave a half-written config.
- `tax-tracker init` runs the same generation explicitly and prints where everything lives. With `--interactive` it also prompts for the optional API keys and the FX policy.
- Setup flow ([Setup.svelte](../../src/client/src/routes/Setup.svelte), [auth.ts](../../src/server/routes/auth.ts)):
  1. Choose a passphrase.
  2. Confirm the recovery key: it's shown once and must be typed back.
  3. Optionally enter API keys.
  - In env-supplied mode the API key fields are read-only, with "set via environment".
- Containers with `AUTO_CONFIG=true` keep `config.json` on the same volume as the database, so it survives a container recreate.

As built (2e):
- **Switch:** `AUTO_CONFIG=true|false`, default false. `loadConfig()` ([env.ts](../../src/server/config/env.ts)) is the only place that reads `config.json` ([file.ts](../../src/server/config/file.ts)); env-supplied mode never touches the file. Phase 3's `cli.ts` must set `AUTO_CONFIG=true` by default (unless the user set it) before importing the config, and the installers must too. Containers keep the explicit opt-in: an auto-detect on a missing `SESSION_SECRET` would hide a mistyped Secret name or missing `env_file`. SQLite means one container and one volume, so replica races are not a concern.
- **File contents:** `SESSION_SECRET` plus an allowlist (`HOST`, `PORT`, `FX_RATE_POLICY`, `LOG_LEVEL`, `SECURE_COOKIES`, `TRUST_PROXY`). Reading refuses any other name (key material, API keys, `DB_PATH`), which is also the check `doctor` should reuse. Created with a hard-link exclusive create (temp file then `link`, falling back to `rename` where links are unsupported), so a racing second start reads the winner's secret. Env wins; an empty env var does not shadow the file; `SESSION_SECRET_FILE` beats the file's secret. A file that cannot be parsed fails the boot.
- **Setup:** `POST /api/auth/setup` creates the user and the passphrase + recovery slots (unattended only on request) in one `BEGIN IMMEDIATE`, regenerates the session before that write, then commits, calls `keyring.protect()` and starts the session with no `await` in between. It records `database.created` (counts as an unconfirmed recovery key like `database.encrypted`), returns the recovery key once, and signs the user in. `/upgrade/confirm` does not delete safety copies after a fresh install (`keysCreatedAtSetup`). If the database already holds values in encrypted columns (imported before setup), setup only creates the user and the sign-in offers the normal in-app upgrade, because wrapping plaintext rows in a new key would make them unreadable.
- **API keys:** `GET /api/settings`, `PUT|DELETE /api/settings/api-keys/:name`. Env value always wins. Per field `editable` is true only in self-configured mode and when the environment does not supply that key; in env-supplied mode every field is read-only ("set via environment"), so Docker/Kubernetes deployments stay reproducible from their env. Stored keys are in the encrypted `app_secret` table (the store refuses a database that is not encrypting) and are treated as absent while locked. The Tiingo provider and the Alpha Vantage route resolve their key per call, so a UI-entered key applies without a restart.
- **`init`:** `runInit()` ([init.ts](../../src/server/init.ts)) is the logic; Phase 3's CLI exposes it as `tax-tracker init`. `--interactive` can only cover non-secret settings (API keys have nowhere safe to go before setup).

Tests:
- crypto round trip, tamper detection (ciphertext, tag, nonce, AAD), swapped-row/column rejection, wrong-key rejection, recovery-key checksum, known-answer vectors for AES-GCM and HKDF
- live Fastify: locked routes return 423; unlock via passphrase and via recovery key; passphrase change keeps data readable; idle timeout re-locks; unattended boot unlocks without login
- raw-bytes check: after a full fixture load, no fixture ticker, name, ISIN, quantity or amount appears in the DB file, the `-wal` file or a backup. Run it again after the 2d upgrade path.
- an interrupted upgrade leaves the DB in its original readable state
- existing tax-engine and computation tests pass unchanged through the stores

Self-configured mode is the default for `npx` / global installs, because a one-command start is the point.

## Phase 3: CLI and npm package

- `src/server/cli.ts` with `#!/usr/bin/env node`, registered as `bin: { "tax-tracker": "dist/server/cli.js" }`.
- Uses `node:util` `parseArgs`, so no new dependency. Subcommands:
  - `tax-tracker` / `start`: run the server. Flags: `--port`, `--host`, `--data-dir`, `--open` (open the browser once listening).
  - `init`: Phase 2e.
  - `backup`, `restore`, `export`, `import`: Phase 4.
  - `keys add-unattended`, `keys remove-unattended`, `keys rotate`: manage key slots and rotate the DEK. Each needs an unlock first, and rotation runs offline.
  - `info`: version, data dir, config mode, unlock mode, DB size, last backup.
  - `doctor`: checks the Node version, data-dir permissions, DB `integrity_check`, port availability, secret validity and key-slot integrity. It also confirms that `config.json` contains no key material and that the unattended key file isn't inside the data dir. It never prints or asks for key material. This is the first thing a support issue would ask for.
- Rename the package to `uk-tax-tracker` (free on npm as of 2026-10-28). The `bin` name stays `tax-tracker`; `npx uk-tax-tracker` still works because it's the package's only bin.
- `"files": ["dist", "LICENSE", "README.md"]`. Also move `pino-pretty` to `optionalDependencies` or leave it dev-only, given the Phase 1 fallback.
- Port `scripts/check-pack-allowlist.ts` from the exporters. Required entries: `dist/server/cli.js`, `dist/server/main.js`, `dist/client/index.html`, `dist/server/db/migrations/001_core_schema.sql`. Run it in CI. It also guards against `.env` or `data/` ever reaching the tarball.
- **Don't** port `check-no-native-addons.ts`, because `@node-rs/argon2` is a native addon. Instead, add a CI matrix job (`ubuntu`, `macos`, `windows`) that runs `npm pack`, installs the tarball into a clean dir, starts `tax-tracker --port 0` and probes `/health`. That proves the prebuilt argon2 binary resolves on each OS.
- `scripts/backup.ts` and `scripts/backfill-fx.ts` become CLI subcommands. Delete the npm scripts that wrapped them, along with the `--env-file` dependency.

As built (Phase 3):
- **Entry:** [cli.ts](../../src/server/cli.ts) only statically imports [cli-args.ts](../../src/server/cli-args.ts) and `commands/util.ts`. Flags (`--port` incl. 0, `--host`, `--data-dir`, `--env-file`) and the `AUTO_CONFIG=true` default are applied to `process.env`, then `start.ts` is imported lazily. The `config` singleton moved from `env.ts` to [config/current.ts](../../src/server/config/current.ts), so `doctor`, `info` and `keys` can load without creating `config.json` or failing on bad config. `main.ts` still starts the server (Docker entrypoint, `npm run dev`) through `startServer()`. `PORT=0` is now valid (the OS picks a port; the printed URL has the real one).
- **Commands** (`src/server/commands/`): `start`, `init` (`--interactive` covers only the FX policy, defaulting to the current value), `info`, `doctor`, `backup`, `backfill-fx`, `keys add-unattended|remove-unattended|rotate-recovery`. `keys` prompts for the passphrase (hidden on a TTY; one stdin line, with a notice, otherwise) and reads the unattended key from `ENCRYPTION_KEY`/`_FILE`, refusing a key file inside the data dir. `doctor` never prints key material, survives a broken `config.json`, and checks that `ENCRYPTION_KEY` opens the unattended slot. Commands read `config.json` only when `AUTO_CONFIG=true`, as the server does.
- **Deferred (now Phase 5a):** DEK rotation (`keys rotate`) is not implemented. It re-seals every encrypted column under a new key and re-wraps every slot in one verified transaction (the shape of `upgrade.ts` `rewriteAll`, plus key-id and blind-index changes), which is its own change. `rotate-recovery` replaces the recovery key only. `backfill-fx` still refuses encrypted databases; `fetch-dividends` and `import-ghostfolio` remain scripts and also refuse.
- **Backup:** `backup` is the old script's logic (backup API), moved as is; Phase 4 replaces it with the shared `services/backup/` module.
- **Packaging:** package `uk-tax-tracker`, `bin.tax-tracker`, `files` allowlist, `pino-pretty` moved to `optionalDependencies` (still ships in installs and the image, still falls back to JSON), `npm run build` now cleans `dist/` first, tests are excluded from the server build. [check-pack-allowlist.ts](../../scripts/check-pack-allowlist.ts) runs in the `test` CI job; [smoke-pack.ts](../../scripts/smoke-pack.ts) runs in a new ubuntu/macos/windows `package` job.
- **Behaviour change to remember:** `npm start` is now the CLI and no longer loads `.env` implicitly (`npm start -- --env-file .env`), and an unset `AUTO_CONFIG` means true for the CLI only. `.env.example` sets `AUTO_CONFIG=false` so existing `.env` setups keep env-supplied mode. Dockerfile still runs `main.js` (Phase 5 switches it to the CLI).
- **Hand-offs:** Phase 4 reuses `commands/backup.ts` as the seed of `services/backup/` and needs `keys`-style unlock for any CLI command that reads decrypted data (`export`, `import`). Phase 5 must make the Dockerfile entrypoint the CLI. Phase 7 installers call `tax-tracker init` and rely on the CLI defaulting to self-configured mode. Known and accepted: `checkUnattendedKeyLocation` does no realpath/case folding; `keys` does not warn that a running server must be restarted for a changed unattended key.

## Phase 4: Backup, restore, import and export

Two distinct things that users conflate, kept separate in the UI and docs:

| | Backup / restore | Export / import |
|---|---|---|
| Format | SQLite snapshot (`.db`) | Versioned JSON archive (`.json`, optionally gzip) |
| Purpose | Disaster recovery, same or newer app version | Portability, inspection, moving between installs, migrating off the app |
| Contents | Everything, byte-for-byte, including the wrapped key slots | Domain data: instruments, transactions, vest schedule, tax-year config, cached FX and prices. Excludes sessions, the user password hash and derived tables (`s104_pool`, `cgt_disposal`, which are rebuilt by `recalcAllInstruments()`) |
| Encryption | Encrypted fields stay encrypted. Restoring needs the passphrase or recovery key. Taking a backup does not need the app to be unlocked. | Encrypted by default with an export passphrase (same envelope format). Plaintext export is opt-in, with an explicit confirmation. Export needs the app to be unlocked. |

### Backup
- Replace `copyFileSync` in [scripts/backup.ts](../../scripts/backup.ts). In WAL mode a raw file copy can miss committed transactions still in `-wal`. Use `node:sqlite`'s `backup()` (available on the Node 24 floor), which gives a consistent online snapshot.
- Shared `services/backup/` module, used by the CLI, the API and the scheduler:
  - `createBackup(reason)` writes to `<dataDir>/backups/taxtracker-<ts>-<reason>.db`, then runs `PRAGMA integrity_check` on the copy.
  - Retention: keep the last N (default 14) plus every pre-migration backup.
- **Automatic pre-migration backup:** [database.ts](../../src/server/db/database.ts) takes a backup before applying any pending migration to a non-empty DB. That's the safety net for `npx uk-tax-tracker@latest`-style upgrades.
- **Scheduled backups:** an optional in-process daily backup (`BACKUP_SCHEDULE=daily|off`, default `daily` in self-configured mode). This removes the cron instruction from the README for laptop users. Containers and Kubernetes can keep it on (the backups land on the volume) or use the CronJob below.
- API and UI: `POST /api/backup` (create), `GET /api/backup` (list), `GET /api/backup/:name` (download). Add a "Backups" section to [ImportExport.svelte](../../src/client/src/routes/ImportExport.svelte).

### Restore
- **CLI (offline):** `tax-tracker restore <file>`. Refuses while the server is running (checked via a lock file in the data dir). It validates the file, backs up the current DB, then swaps.
- **UI / API (online):** upload a `.db` file, which is validated and staged as `<dataDir>/restore-pending.db`. On the next boot, `initDb` checks integrity, backs up the current DB, swaps atomically, runs migrations, then `recalcAllInstruments()` on unlock. The UI says "restart to apply". Docker, Kubernetes and systemd restart automatically if the server exits after staging; the CLI prints instructions. This one design works the same in every deployment mode.
- Validation:
  - SQLite header and `integrity_check`
  - a `_migrations` table must exist
  - schema version ≤ the current app's (refuse backups from a newer version with a clear message)
  - `tenant_id = 1` present
  - a `key_slot` table with a passphrase slot and a recovery slot. After a restore the app starts locked, and the backup's own passphrase or recovery key unlocks it. A backup from a different install keeps that install's passphrase, and the UI says so before the swap.

### Export / import
- `GET /api/export/archive` and `tax-tracker export [--out file]` write `{ format: "tax-tracker-archive", formatVersion: 1, appVersion, exportedAt, data: {...} }`. Money stays as strings, matching the precision rule.
- `POST /api/import/archive` and `tax-tracker import <file>`:
  - **into-empty:** the default, refused if any transactions exist.
  - **replace:** auto-backup first, then truncate and load.

  Runs in one SQLite transaction. Writes to `audit_log`. Ends with `recalcAllInstruments()`.
- `formatVersion` gets a migration table of its own, so archives from older versions stay importable after schema changes.
- The existing CSV transaction import and the CSV/PDF exports are unchanged. They are plaintext by nature, since they're meant for HMRC and cgtcalculator.com, and the download button says so.

Tests: backup consistency under concurrent writes in WAL mode, a restore round trip, refusing a newer-schema backup, archive round trip (export → import into a fresh DB → disposals identical), and replace-mode rollback on a mid-import failure.

As built (Phase 4):
- **Backup:** [services/backup/backups.ts](../../src/server/services/backup/backups.ts) `createBackup(db, dataDir, reason)` (reasons `manual`, `scheduled`, `pre-migration`, `pre-restore`, `pre-import`) writes a consistent snapshot (`VACUUM INTO`) to a `.partial` file, verifies it (journal mode DELETE, `integrity_check`) and only then gives it its final name `taxtracker-<ms timestamp>-<reason>.db`. Only `manual` and `scheduled` are pruned, each in its own pool of 14, ordered by the timestamp in the name (never the file time) and never removing the backup just made. The upgrade's `-pre-encryption` safety copy is neither listed, downloadable nor restorable here. `database.ts` takes a `pre-migration` backup before pending migrations on a non-empty database (reused if one was made in the last 10 minutes, so a crash loop cannot fill the disk); if it cannot be made the app does not start. The scheduler (`BACKUP_SCHEDULE=daily|off`, default daily only in self-configured mode, allowed in `config.json`) checks 30 s after start and hourly.
- **Restore:** `stageRestore` copies the file to `restore-pending.db`, validates the copy (SQLite header, `integrity_check`, `_migrations` table, no migration this build does not know, `tenant` 1, and for protected backups a passphrase and a recovery slot **and a user row**), refuses a source with a `-wal` beside it, and returns `{protected, keyId, sameKeys}`. `applyPendingRestore` runs inside `initDb` before the file is opened (and from `tax-tracker restore`): it re-validates, takes a `pre-restore` backup (raw file copy if the live file is unreadable), checkpoints the WAL, removes only sidecars and renames over the database. Any failure moves the staged file to `backups/` as `*-rejected-restore.db` (so a plaintext copy is listed with the others) rather than retrying each start.
- **Deviations from the plan:** (1) the plan required key slots in every restorable backup; an **unprotected** backup is also accepted over an unprotected database (so a pre-migration backup of an old version stays restorable) and refused over a protected one. An unreadable live file counts as unprotected, since that is the case a restore exists for. (2) Staging does not exit by default; `RESTORE_RESTART=exit` (also in `config.json`) makes the server exit 200 ms after the response so a supervisor restarts it, `manual` (default) tells the user to restart. (3) Archives are not gzipped. (4) `ENCRYPTION_KEY` that cannot open a backup's unattended slot makes the restore be refused at staging and at boot, because `unlockAtBoot` would otherwise refuse to start and the pod would crash-loop.
- **Containers:** the offline `restore`/`import` refuse while a server is running, detected by `server.lock` in the data dir, which the server rewrites every 5 s (stale after 30 s; written before migrations; removed on exit, and on SIGINT/SIGTERM before the signal is re-raised so exit statuses are unchanged). Ownership is a random instance id, never the process id (pids collide across containers: both are 1 on Kubernetes). It also records the host name: on the same host/container a dead or identical pid makes a lock stale at once (supervisor restarts, `tsx watch`); otherwise only the clock counts, and a lock that merely looks stale (under 10 min old) is watched for one heartbeat to absorb clock skew. A starting server waits up to 35 s for a fresh foreign lock and then refuses to start; the offline `restore`/`import` hold the lock themselves while they run, and `restore` re-checks it just before the swap. `applyPendingRestore` claims the staged file by renaming it to `restore-applying.db` (a claim older than 5 min is treated as an interrupted attempt and requeued), only copies the raw file when SQLite reports the live file as damaged (busy/unreadable puts the staged file back for a retry), and never throws from the set-aside path. Known: a synchronous stretch over 30 s on slow storage (huge `integrity_check`, migrations) can make a running server's lock look stale. Recipes (README): stop the app container and `docker compose run --rm --entrypoint node app dist/server/cli.js restore ... --yes`; on Kubernetes scale to zero and run a Job/pod on the same claim. Phase 5/6 manifests should set `RESTORE_RESTART=exit` with a restart policy that restarts on exit code 0.
- **Archive:** [archive.ts](../../src/server/services/backup/archive.ts) `{format:'tax-tracker-archive', formatVersion:1, appVersion, exportedAt, encrypted, data}`; encrypted = AES-256-GCM under argon2id of the export passphrase (12+ chars; AAD from the file's own `formatVersion`; the KDF cost in a file is capped at 256 MiB / 10 passes / 8 lanes). `ARCHIVE_MIGRATIONS` is the per-version migration table (empty while only v1 exists). [archive-validate.ts](../../src/server/services/backup/archive-validate.ts) checks every field before anything is written. Import runs in one `BEGIN IMMEDIATE`; `replace` clears the portfolio inside it. Ids are remapped (instruments, transactions, scheduled-vest `realisedTxnId`); `tax_year_config` rows are **insert-only** (an archive can add a year, never alter one); `importSource` and `createdAt` are not carried. The caller recalculates afterwards (`recalcAllInstruments` now takes a narrow `RecalcDeps`).
- **Surfaces:** `GET|POST /api/backup`, `GET /api/backup/:name`, `POST|DELETE /api/backup/restore` (raw `application/octet-stream`, 500 MB), `POST /api/export/archive` (passphrase, or `plaintext` + `confirmPlaintext`), `POST /api/import/archive` (`mode`, `confirmReplace`); CLI `restore`, `export`, `import`, `--yes`, plus `backup` on the shared service; UI tab "Backups & archive". `fx` and `prices` stores are now decorated on the app. `createTestDb` records `_migrations`.
- **Completed after the first commit:** (1) `createBackup` uses `VACUUM INTO` (one consistent snapshot) instead of the backup API, which restarted for ever when another process wrote continuously (reproduced with a cross-process writer test); it is synchronous, so it must not run inside a transaction and costs a fraction of a second at personal-database sizes. The upgrade's pre-encryption safety copy still uses the backup API. (2) The 2d "persistent badge": `GET /api/backup` lists leftover unencrypted copies (`plaintextCopies`, plus `unreadableCopies`), `POST /api/backup/plaintext-copies/delete` removes selected ones, the nav shows "N unencrypted copies" and the Backups tab lists them with checkboxes. Rules: nothing is listed or deletable while the database itself is unprotected; only copies that were opened and seen to have no key slots are deletable (an unreadable file may be a damaged encrypted one); the upgrade safety copy is held back only while its recovery key is unconfirmed on a non-fresh install. (3) The CLI (`export`, `import`, `keys`) takes the recovery key as well as the passphrase at the same prompt. (4) `app.ts` closes the database on `app.close()`. (5) The scheduler waits until an account exists, so no unencrypted copy is made before first-run setup. (6) A test boots the real `buildApp` over a staged restore (`restore-boot.test.ts`).
- **Known gaps / hand-offs:** the Backups tab and the badge were checked through the real HTTP API and a Svelte compile, but not in a browser (no Chrome available to the Playwright tool here). Uploads are buffered whole and validated synchronously. A synchronous `VACUUM INTO` on a multi-GB database would stall requests and the lock heartbeat. `listPlaintextCopies` opens every `.db` in `backups/` on each `GET /api/backup`.

## Phase 5: Release pipeline and image publication

### 5a. Data key rotation (carried over from Phase 3; done first)

`tax-tracker keys rotate` was planned in Phase 3 and deferred there; it is the first piece of work in Phase 5, before any release machinery, because a release should ship with the full key-management surface. `rotate-recovery`, `add-unattended` and `remove-unattended` already exist.

- **What it does:** replaces the data encryption key (DEK). Offline only (refuses while `server.lock` is fresh, and holds the lock itself while it runs, like `restore`/`import`). It unlocks with the passphrase or recovery key, then in one `BEGIN IMMEDIATE` transaction: generates a new DEK; re-seals every classified column (the registry in `crypto/fields.ts`) with the new key's cipher, reading each value back through it before commit (the shape of `rewriteAll` in `crypto/upgrade.ts`); recomputes `ticker_bidx` in the same `UPDATE` as the sealed ticker (the trigger from migration 007 requires it); and replaces the key slots.
- **Slots:** the passphrase slot is re-wrapped with the passphrase just typed; a **new recovery key** is generated and printed once (the old one cannot be re-wrapped because only its wrapping is stored, so the old recovery key stops working, and the recovery key counts as unconfirmed until typed back); an unattended slot is re-wrapped from `ENCRYPTION_KEY`/`_FILE` if the environment supplies it, otherwise removed with a clear message (the server would otherwise refuse to start).
- **Safety:** a `pre-rotation` backup is taken first (kept, like the other `pre-*` reasons); an interruption or verification failure rolls everything back; `PRAGMA secure_delete` is on and the checkpoint/`VACUUM` clean-up from 2d runs afterwards (recorded as pending in the audit log and retried at boot, as for the upgrade), so no old ciphertext lingers in free pages or the WAL.
- **Consequences to document:** backups and archives made before a rotation still open with the passphrase/recovery key they were made under (their slots hold the old DEK), which is also why they keep restoring; `restore` of such a backup brings the old DEK back, so rotate again if the point was to retire a key. Rotation does not re-encrypt exported archives (they have their own passphrase).
- **Tests:** round trip (every table readable and identical after rotation, new key id on all slots, old recovery key refused, new one opens), raw-bytes check that no pre-rotation ciphertext remains in the file or WAL after the clean-up, an interrupted rotation leaves the database readable with the old key, an unattended slot with and without the key supplied, a locked-out run (wrong passphrase) changes nothing.

### 5b. Release pipeline and image publication

Ported from technitium/kea-metrics-exporter, which are already SHA-pinned and match this repo's CI.

- `scripts/extract-changelog-section.ts` and a CHANGELOG format check.
- `.github/workflows/release.yml`, triggered on a `v*.*.*` tag:
  - **verify:** lint, typecheck, test, build, pack-allowlist; the tag must match `package.json`; CHANGELOG must have that section.
  - **publish image:** calls `_publish-image.yml`.
  - **npm publish:** uses npm trusted publishing (OIDC) with `--provenance`, rather than a long-lived `NPM_TOKEN`. Gated on `vars.NPM_PUBLISH_ENABLED`.
  - **GitHub Release:** notes taken from CHANGELOG, plus `install.sh`, `install.ps1` and their SHA-256 sums attached as assets (Phase 7).
- `.github/workflows/_publish-image.yml`: multi-arch (`linux/amd64`, `linux/arm64`; arm64 covers Raspberry Pi and Apple-silicon NAS boxes). Pushes to GHCR with build provenance attestation and SBOM.
- `rebuild.yml`: monthly base-image rebuild of the latest release tag. It smoke-tests an amd64 build (`--version` and the baked-in commit) before pushing, then calls `scan.yml` with the digest it pushed.
- `scan.yml`: Trivy scan uploaded as SARIF, fixable high/critical findings only, with a pinned SARIF category. It is called by `rebuild.yml` with the rebuilt digest, and also runs on its own mid-month schedule against `:latest` as the backstop for a silently disabled rebuild.
- Dockerfile changes:
  - `GIT_COMMIT` / `IMAGE_VERSION` build args and OCI labels.
  - Entrypoint becomes the CLI (`node dist/server/cli.js start`), so `docker compose exec tax-tracker tax-tracker backup` works.
  - **Native-addon caveat:** the exporters run `npm ci` in a `--platform=$BUILDPLATFORM` stage and copy `node_modules` across. That's only safe because they have no native addons. Here the prod-deps stage must run on the *target* platform, so the correct argon2 prebuilt is installed. The TS/Vite build stage can stay on `$BUILDPLATFORM`.

As built (Phase 5):
- **5a, `keys rotate`:** [crypto/rotate.ts](../../src/server/crypto/rotate.ts) `rotateDataKey` and [commands/rotate.ts](../../src/server/commands/rotate.ts). Needs the **passphrase** (not the recovery key): it is wrapped around the new key and must remain what sign-in accepts. The command refuses while a server is running and holds `server.lock` itself (`commands/data-dir-lock.ts`, shared with `restore`/`import`), checks the schema is current, takes a `pre-rotation` backup (new `BackupReason`, kept like the other `pre-*`), then re-seals every classified column through `createRowCodec` under the new key, recomputes `ticker_bidx` in the same `UPDATE`, reads every row back, replaces the key slots (`prepareInitialSlots`: new DEK, new recovery key, passphrase slot; an existing unattended slot is carried over only if the supplied `ENCRYPTION_KEY` opens it, is dropped only with `--drop-unattended`, and is never created; a mistyped passphrase is rejected before the backup is taken, so failed attempts leave no `pre-rotation` copies; a COMMIT error that actually landed is reported as success, as in the upgrade), records the same audit events as a recovery-key rotation (so the new key is unconfirmed until typed back) plus `scrub_pending`, commits, then runs the 2d clean-up. Verified end to end with the built CLI against a real server (sign-in with the same passphrase, data intact, recovery key flagged for confirmation).
- **5b, release pipeline:** ported from `apilbeam101/kea-metrics-exporter`, reusing its SHA pins (checked line by line against that repo's workflows). `release.yml` (verify, image, optional npm publish by OIDC trusted publishing with an npm >= 11.5.1 check and no stored token, GitHub Release from the CHANGELOG section), `_publish-image.yml` (amd64+arm64, GHCR, build provenance, per-platform SPDX SBOM attestations; the exporters' Docker Hub mirror is not ported), `rebuild.yml` (monthly, `:latest` only, never the version tag), `scan.yml` (monthly Trivy to SARIF). `ci.yml` gains `changelog:check`, and a `docker` job that builds both platforms without pushing, then starts the amd64 image and probes `/health`, checks no `.env`/data/source is in the layers, and runs a one-off CLI command. Scripts: `extract-changelog-section.ts`, `check-changelog.ts`, `resolve-image-platforms.ts` (tests in `release-scripts.test.ts`).
- **Dockerfile:** production dependencies are installed in a stage running on the target platform; the build stage stays on `$BUILDPLATFORM`; `GIT_COMMIT` / `IMAGE_VERSION` build args, OCI labels, `ENTRYPOINT ["node","dist/server/cli.js"]` with `CMD ["start"]`, and `tax-tracker` on `PATH`. `AUTO_CONFIG=false` is set in the image so containers keep the env-supplied default now that the CLI (which defaults to self-configured) is the entrypoint; Phase 6's compose file opts in with `AUTO_CONFIG=true`.
- **Review follow-ups (Opus):** `release.yml` has a `concurrency` group and publishes pre-releases to the npm `next` dist-tag; the `deps` stage runs `node -e "require('@node-rs/argon2')"` so a missing arm64 prebuilt fails the build; the entrypoint path is absolute and the commit/version build args sit after the cached layers. **Accepted and recorded:** `:latest` is set by any non-pre-release tag and `rebuild.yml` picks the most recently created release, so a backport tag on an older line would move `:latest` back; Trivy scans the runner's platform (amd64) only; the lock heartbeat cannot fire during a synchronous stretch longer than 30 s (large databases); `keys add-unattended`/`rotate-recovery` do not take the data-dir lock, so running one at the same time as `keys rotate` is unsupported; base images are tracked by tag, not digest (the monthly rebuild is the mitigation); the reusable workflow runs the tagged commit's `scripts/` when rebuilding an old tag. The trivy-action pin is the one already used in the exporter repositories; its provenance was not independently re-verified.
- **Pin verification (2026-11-02):** every pinned action in `.github/workflows/` was resolved through the GitHub API; each version tag still points at exactly the pinned commit. For `aquasecurity/trivy-action` v0.36.0 (`ed142fd0...`): the commit has a verified signature, is an ancestor of the default branch (`master`), and the tag is an annotated tag on it. The repository has one published advisory, GHSA-9p44-j4g5-cfx5 / CVE-2026-26189 (command injection through unsanitised inputs, affects 0.31.0 to 0.34.0, fixed in 0.34.1), so v0.36.0 is patched, and `scan.yml` only passes constant inputs anyway. A search of the repository for reports of a compromise or force-pushed tags found nothing; that does not prove none occurred elsewhere.
- **Not verifiable here:** no Docker is installed on the development machine, so the Dockerfile, the multi-arch build and every workflow have only been checked for YAML syntax and by reading; the first real run is CI on the pull request, and the first release run is the first tag. Before the first tag, also: configure the npm trusted publisher for this repository and workflow, and set `NPM_PUBLISH_ENABLED`; promote `[Unreleased]` to a release section (the release job fails without one); the package version is still `0.1.0`.

### First release runbook

Done by the maintainer after Phase 5 is committed (Claude does not push, tag or change repository settings without being asked). Order matters: each step proves the one before it.

1. **Push the branch and open a pull request.** `ci.yml` runs on pull requests, so this is the first real run of the `docker` job (two-platform build under QEMU, the argon2 load check, the layer hygiene check, the `/health` probe), the three-OS `package` job and `changelog:check`. Fix whatever it finds before anything else; none of it has run yet.
2. **Repository settings** (Settings on GitHub): enable code scanning (the monthly Trivy job uploads SARIF and needs `security-events: write` to be accepted); confirm Actions may create artifact attestations; under Rulesets, protect the `v*` tag pattern so only maintainers can create release tags.
3. **npm, first publish and trusted publisher.** The package name `uk-tax-tracker` was free on 2026-10-28; re-check. npm's documentation configures a trusted publisher from the package's own settings page, and describes no way to do that for a package that has never been published, so plan on one manual first publish. Use a version the rehearsal in step 4 will not reuse, such as `0.1.0-rc.0`, because npm refuses to publish a version twice and the workflow's publish of `0.1.0-rc.1` would otherwise fail. Publish it under `--tag next` from an authenticated shell with 2FA, from a scratch checkout where `package.json` is set to that version (do not commit the change). Then on npmjs.com, package Settings, Trusted Publisher, GitHub Actions: organization or user `apilbeam101`, repository `tax-tracker`, workflow filename `release.yml` exactly (case-sensitive, with the extension), environment blank, and **tick "allow npm publish"** (configurations created after 3 September 2026 default to staged publishing only, and `release.yml` runs plain `npm publish`). npm does not validate the form when it is saved, so double-check it. Then set the repository variable `NPM_PUBLISH_ENABLED=true` (Settings, Secrets and variables, Actions, Variables). Optionally restrict token publishing on the package afterwards, as npm recommends. Requirements already handled by the workflow: npm 11.5.1 or later (asserted), Node 22.14 or later, GitHub-hosted runner, `id-token: write`, no caching.
4. **Rehearse with a pre-release tag from the branch.** A tag's workflow file is the one in the tagged commit, so this can be done before merging. On a commit that sets `package.json` to `0.1.0-rc.1` and renames `[Unreleased]` to `## [0.1.0-rc.1] - YYYY-MM-DD` in `CHANGELOG.md`, leaving a fresh empty `## [Unreleased]` above it (`npm run changelog:check`), tag `v0.1.0-rc.1` and push the tag. Expected: image `ghcr.io/apilbeam101/tax-tracker:0.1.0-rc.1` for both platforms and no `:latest` (pre-releases never get it), per-platform SBOM attestations, an npm publish on the `next` tag, and a GitHub pre-release with the CHANGELOG section as notes. The GitHub Release depends only on the image job, not on the npm job, so a failed npm publish still leaves a published release; read the run, not just the Releases page. As soon as the image is pushed, do step 5 (make the package public) so the checks below can be made anonymously. Check: `gh run watch`; `docker buildx imagetools inspect ghcr.io/apilbeam101/tax-tracker:0.1.0-rc.1` lists amd64 and arm64; `gh attestation verify oci://ghcr.io/apilbeam101/tax-tracker:0.1.0-rc.1 --owner apilbeam101`; run the image (`docker run --rm ghcr.io/apilbeam101/tax-tracker:0.1.0-rc.1 info`); the npm page shows provenance.
5. **GHCR package visibility (do this during step 4, right after the first push).** A first push creates the package; make it public in the package's settings if it is not (the image carries the `org.opencontainers.image.source` label that links it to the repository). Pulling anonymously is the test.
6. **Cut 0.1.0.** On a commit that sets the version and renames the `## [0.1.0-rc.1]` section to `## [0.1.0] - YYYY-MM-DD` (the release notes live there, since step 4 already moved them out of `[Unreleased]`; fold in anything added since, and drop rc-only notes), keeps `[Unreleased]` empty above it, and passes `npm run changelog:check`, merge to `master`, then `git tag v0.1.0` and push the tag. Repeat the checks from step 4, now expecting `:latest` and `:0.1.0`.
7. **Scheduled workflows.** `rebuild.yml` and `scan.yml` run from the default branch (`rebuild.yml` on the 1st of each month at 06:00 UTC, which then calls the scan; `scan.yml` on its own on the 15th at 08:00 UTC); they only exist once merged. After the first release, start each once with "Run workflow" to prove them before the schedule does.
8. **Phase 6** then points the compose file, the Kubernetes manifests and the install docs at `ghcr.io/apilbeam101/tax-tracker:<version>`.

## Phase 6: Deployment artefacts and docs

### Compose (`deploy/compose/`)
- `docker-compose.yml`: uses `image: ghcr.io/apilbeam101/tax-tracker:<version>`, a **named volume** (removes the `chown 10001` step), `AUTO_CONFIG=true`, `init: true`, `read_only`, `cap_drop`, and a loopback-only port. It keeps every item from the docker-packaging-gotchas memory.
- Unlock mode: passphrase by default, so the app is locked after each restart until someone logs in. A commented-out `secrets:` block shows the unattended option via `ENCRYPTION_KEY_FILE`, with the trade-off spelled out.
- Profile `https`: a Caddy sidecar driven by `DOMAIN`, with automatic TLS. `SECURE_COOKIES=auto` plus `trustProxy` make the cookies correct.
- `docker-compose.build.yml`: an override for building from source (today's behaviour).
- Bind-mount users get a documented alternative with the `chown` step, kept out of the default path.

### Kubernetes (`deploy/kubernetes/`)
Adapted from the exporter manifests, with SQLite-specific constraints:
- A `StatefulSet` with `replicas: 1` and a `ReadWriteOnce` PVC (or a Deployment with `strategy: Recreate`). SQLite must never have two writers, so a rolling update must not overlap pods.
- `secret.example.yaml` (`SESSION_SECRET`, plus optional `ENCRYPTION_KEY` for unattended unlock, mounted as files rather than env vars), `configmap.yaml`, `service.yaml`, `networkpolicy.yaml` (ingress from the ingress controller only, egress to DNS plus the FX and price providers on 443), and `ingress.example.yaml`.
- `cronjob-backup.example.yaml`: runs `tax-tracker backup` against the same PVC. Optional, since the in-process schedule also works.
- `kustomization.yaml`, so it's `kubectl apply -k`. No Helm chart; that's more upkeep than a single-replica app justifies.
- Pod security: `runAsNonRoot`, `readOnlyRootFilesystem`, `emptyDir` for `/tmp`, and `seccompProfile: RuntimeDefault`.

### Bare metal
- `deploy/systemd/tax-tracker.service`: a hardened unit (`ProtectSystem=strict`, `StateDirectory=tax-tracker`, so the data dir is managed by systemd). Secrets come via `LoadCredential=` rather than `EnvironmentFile=`.
- `deploy/launchd/com.apilbeam101.tax-tracker.plist`: used by the macOS installer.

### Docs
- `docs/INSTALL.md`: a decision table ("which install is right for me?") linking to:
  - `INSTALL_DESKTOP.md` (installer scripts, npx)
  - `INSTALL_DOCKER.md`
  - `INSTALL_KUBERNETES.md`
  - `INSTALL_STANDALONE.md` (systemd, reverse proxy)
- `docs/BACKUP_RESTORE.md`: backup vs export, restore in each deployment mode, and what the pre-migration backup covers.
- `docs/SECURITY_MODEL.md`: key slots, unlock modes, what's covered at rest and what isn't (a compromised host while unlocked; a weak passphrase; downloaded CSV/PDF exports; activity patterns from plaintext dates and types). Recommends OS disk encryption as a complement.
- `docs/UPGRADING.md`, `docs/TROUBLESHOOTING.md` (driven by `tax-tracker doctor` output) and `docs/CONFIGURATION.md` (every env var and config key, with precedence rules).
- Update the README security section, `DESIGN.md`, CLAUDE.md and `.env.example` to describe key slots and unlock modes. Wording goes to the maintainer for approval.
- Move `DESIGN.md` and `IMPLEMENTATION.md` under `docs/`.
- Slim the README to: what it is, screenshots, a 3-line quick start per audience, and links.
- Tidy-ups: the README says the price fallback is Yahoo while CLAUDE.md says Stooq (check which the code uses); `nvm install 26` should be `24`.

## Phase 7: Install scripts (macOS and Windows)

`install/install.sh` (macOS, and Linux as a bonus) and `install/install.ps1` (Windows). Both are published as release assets with checksums. The README shows the pinned-version URL plus the checksum-verify alternative for cautious users.

Both scripts:
1. Check for Node ≥ 24. If it's missing, offer to install it:
   - macOS: Homebrew if present, else the official `.pkg`, downloaded and verified against a pinned SHA-256, matching the exporters' `verified-download` pattern.
   - Windows: `winget install OpenJS.NodeJS.LTS`.

   Never silently upgrade an existing Node.
2. `npm install -g uk-tax-tracker@<pinned version>`.
3. `tax-tracker init` (self-configured mode). Windows: run `icacls` on the data dir so only the current user can access it.
4. Optional, prompted, default yes: start on login.
   - macOS: a launchd agent in `~/Library/LaunchAgents`.
   - Windows: a Scheduled Task at logon running hidden (`-WindowStyle Hidden`), since a Windows Service needs admin and a service wrapper.
5. Optional: a desktop or Start-menu shortcut that opens `http://127.0.0.1:3000`.
6. Print the data dir, backup location and the uninstall command. Remind the user to store the recovery key from first-run setup.

Also:
- `--uninstall` / `-Uninstall` removes the service, shortcut and global package. It **never deletes the data dir** unless `--purge` is passed with a typed confirmation.
- Non-interactive flags (`--yes`, `--no-service`, `--port`) so the scripts can be tested in CI.
- CI: `shellcheck` on `install.sh`; `PSScriptAnalyzer` on `install.ps1`. Matrix job on `macos-latest` and `windows-latest` runs each installer non-interactively against the locally packed tarball (an `--from-tarball` flag), then probes `/health`, then uninstalls.
- No signed `.pkg`/`.msi` in this plan. Code-signing certificates cost money and need an Apple/Microsoft developer setup; revisit if the user base grows. Unsigned scripts run via `curl | sh` / `irm | iex` avoid the Gatekeeper and SmartScreen prompts that an unsigned binary would hit.

## Phase 8: Public-repo hygiene

- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and PR templates. Copy from the exporters and adapt.
- The bug report template asks for `tax-tracker doctor` output and explicitly warns against pasting real financial data (repo is public).
- `svelte-check` in CI for the client. This is tracked separately in the dev-tooling-backlog memory; include it here only if time permits.

---

## Decisions

1. **Package name:** `uk-tax-tracker`.
2. **Self-configured mode:** on by default for CLI/installer installs.
3. **Scheduled backups:** in-process daily by default.
4. **Order:** Phases 1–8 in sequence. Nothing is pushed until the work is complete, so there's no reason to bring Phase 5 forward.

## Out of scope
- Whole-file encryption (SQLCipher): `node:sqlite` doesn't support it.
- OS keychain storage for the unattended key: needs a native module.
- Hardware-key (WebAuthn/FIDO2) unlock slots: the slot design leaves room to add them later.
- Multi-user or multi-tenant hosting.
- Signed native installers, Homebrew tap and winget manifest. These are good follow-ups once the npm package is stable; a Homebrew formula and winget manifest can wrap the same npm tarball.
- Single-executable (Node SEA) builds: blocked on embedding the native argon2 addon and the client assets.

# Deployability plan

Branch: `feat/deployability`

Goal: someone who is comfortable installing an app, but not with Node, Docker or `.env` files, can install tax-tracker with one command, keep their data safe, and upgrade without losing anything. The ops-style deployments (Docker, Kubernetes, systemd) become first-class at the same time, published from one tagged release. Encryption and secret handling are extended alongside, so that every install path gets the same protection for data at rest.

Target install paths, in order of expected audience size:

| Audience | Install | Run | Upgrade |
|---|---|---|---|
| Laptop user, macOS | `curl -fsSL …/install.sh \| sh` | Login item, or `tax-tracker` | `tax-tracker upgrade` / re-run installer |
| Laptop user, Windows | `irm …/install.ps1 \| iex` | Login task, or `tax-tracker` | same |
| Has Node 24 already | `npx tax-tracker` | same command | `npx tax-tracker@latest` |
| Home server / NAS | `docker compose up -d` (published image) | always-on | `docker compose pull && up -d` |
| Kubernetes | `kubectl apply -k deploy/kubernetes` | single replica + PVC | bump image tag |
| Linux server, no containers | npm global install + systemd unit | always-on | `npm i -g tax-tracker@latest` |

Each phase follows the phased review loop: implement, Opus review against the real diff, fix, update memory and CLAUDE.md, then stop for a commit decision. Commit messages, CHANGELOG entries and user-facing doc wording are approved by the maintainer before every commit or push.

---

## Phase 1: Runtime foundations and secret handling

These changes help every install path, so they come first. No packaging yet.

1. **Resolve assets from the package, not the cwd.** [app.ts:31](../../src/server/app.ts#L31) resolves `dist/client` from `process.cwd()`. Replace it with a `packageRoot()` helper that walks up from `import.meta.url` to the nearest `package.json`. That works the same from `src/server` (tsx) and from `dist/server` (compiled). Use it for migrations too, so [database.ts](../../src/server/db/database.ts) and `app.ts` share one rule.
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
| `unattended` | `ENCRYPTION_KEY` / `ENCRYPTION_KEY_FILE`, supplied by the deployment | Optional |

- Unlocking unwraps the DEK from any one slot, and the DEK is held only in memory.
- Changing the passphrase rewraps that slot; no field data is re-encrypted. "Forgot passphrase" uses the recovery key to set a new one.
- The unattended key must live outside the data volume, so a volume snapshot or a DB backup never carries the key that opens it. `doctor` (Phase 3) warns otherwise.

| Deployment | Slots | After restart |
|---|---|---|
| Laptop (installer, npx) | passphrase + recovery | Locked until login. No key material on disk. |
| Docker / compose (default) | passphrase + recovery | Locked until login |
| Docker / compose, Kubernetes, systemd (opt-in) | + unattended via Docker secret, `Secret` volume or `LoadCredential=` | Unlocks at boot |

### 2b. Lock state
- **Locked:** only `/health`, `/api/auth/*` and the static client are served. Other API routes return `423 Locked` with a stable error code, and the client ([api.ts](../../src/client/src/lib/api.ts)) shows the unlock screen.
- **Unlocked:** the DEK is held while any session is valid. Logout of the last session, or the 8-hour idle timeout, drops it. Unattended mode stays unlocked for the process lifetime.
- **Startup work:** `recalcAllInstruments()`, `backfillRealisedProjections()` and `backfillAutoWithholding()` ([app.ts](../../src/server/app.ts)) move to an `onUnlock` hook, so they run at boot in unattended mode and on first unlock otherwise.
- **While locked:** scheduled backups still run, since they copy ciphertext. FX fetches still run, since that's public data. Price refresh waits for unlock.
- One module holds the DEK and overwrites the buffer on lock. Document this as best-effort, since strings derived from it can't be zeroised.

### 2c. Field coverage and format
- Encrypt on write and decrypt on read in the repository stores ([repositories/](../../src/server/repositories/)) only. Services keep receiving plaintext domain objects, so the tax engine is unchanged.
- Format: `v1.<keyId>.<base64url(nonce ‖ ciphertext ‖ tag)>`, AES-256-GCM with a 96-bit random nonce per value.
  - AAD = `<table>.<column>.<rowId>`, so values can't be swapped between rows or columns.
  - Use one row-ID strategy consistently across stores (explicit allocation, or insert-then-update in one transaction).
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
| `price` | `close_price` (with instrument identity encrypted, plain prices would identify holdings) |
| `audit_log` | `old_data`, `new_data`, `ip_address` |
| `app_secret` (new) | API keys entered through the UI |

- Plaintext: keys, `tenant_id`, dates, `txn_type`, currencies, `instrument_type`, `match_type`, `tax_year`, `tax_year_config`, the `fx_rate` table, and timestamps. These are needed for indexing and tax-year bucketing.
- **Blind index:** `instrument` has `UNIQUE(tenant_id, ticker)` and a ticker lookup in [InstrumentStore.ts:56](../../src/server/repositories/sqlite/InstrumentStore.ts#L56).
  - Add `ticker_bidx = HMAC-SHA256(K_bidx, normalise(ticker))`, with `K_bidx` derived from the DEK via HKDF.
  - Uniqueness moves to `UNIQUE(tenant_id, ticker_bidx)`.
  - `ORDER BY ticker` moves into the store.
  - No SQL arithmetic, range query or other ordering touches these columns (checked 2026-10-26; all arithmetic is in-app via big.js).

### 2d. Upgrading existing databases
- On the first unlock after upgrading, in one transaction:
  1. Create the key slots if absent. Existing installs get a one-time screen that confirms the passphrase and shows the recovery key.
  2. Rewrite every classified column into the current format and build the blind indexes.
  3. Then run `PRAGMA secure_delete = ON` (kept on permanently), `wal_checkpoint(TRUNCATE)` and `VACUUM`, so no superseded values remain in freed pages or the WAL.
- Backups taken before the upgrade aren't in the current format. The app lists them and prompts the user to replace them with a fresh backup and delete the old ones; any kept are flagged with a badge.
- An automatic pre-upgrade backup (Phase 4) makes a failed upgrade recoverable. It's removed once the upgrade is verified, and the user is told at each step.

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

Tests:
- crypto round trip, tamper detection (ciphertext, tag, nonce, AAD), swapped-row/column rejection, wrong-key rejection, recovery-key checksum, known-answer vectors for AES-GCM and HKDF
- live Fastify: locked routes return 423; unlock via passphrase and via recovery key; passphrase change keeps data readable; idle timeout re-locks; unattended boot unlocks without login
- raw-bytes check: after a full fixture load, no fixture ticker, name, ISIN, quantity or amount appears in the DB file, the `-wal` file or a backup. Run it again after the 2d upgrade path.
- an interrupted upgrade leaves the DB in its original readable state
- existing tax-engine and computation tests pass unchanged through the stores

Open decision: should self-configured mode be the default for `npx` / global installs, or always need `init` first? Recommendation: default on, because a one-command start is the point.

## Phase 3: CLI and npm package

- `src/server/cli.ts` with `#!/usr/bin/env node`, registered as `bin: { "tax-tracker": "dist/server/cli.js" }`.
- Uses `node:util` `parseArgs`, so no new dependency. Subcommands:
  - `tax-tracker` / `start`: run the server. Flags: `--port`, `--host`, `--data-dir`, `--open` (open the browser once listening).
  - `init`: Phase 2e.
  - `backup`, `restore`, `export`, `import`: Phase 4.
  - `keys add-unattended`, `keys remove-unattended`, `keys rotate`: manage key slots and rotate the DEK. Each needs an unlock first, and rotation runs offline.
  - `info`: version, data dir, config mode, unlock mode, DB size, last backup.
  - `doctor`: checks the Node version, data-dir permissions, DB `integrity_check`, port availability, secret validity and key-slot integrity. It also confirms that `config.json` contains no key material and that the unattended key file isn't inside the data dir. It never prints or asks for key material. This is the first thing a support issue would ask for.
- Rename the package to `tax-tracker` (free on npm as of 2026-10-26) or `@apilbeam101/tax-tracker`. Open decision; see below.
- `"files": ["dist", "LICENSE", "README.md"]`. Also move `pino-pretty` to `optionalDependencies` or leave it dev-only, given the Phase 1 fallback.
- Port `scripts/check-pack-allowlist.ts` from the exporters. Required entries: `dist/server/cli.js`, `dist/server/main.js`, `dist/client/index.html`, `dist/server/db/migrations/001_core_schema.sql`. Run it in CI. It also guards against `.env` or `data/` ever reaching the tarball.
- **Don't** port `check-no-native-addons.ts`, because `@node-rs/argon2` is a native addon. Instead, add a CI matrix job (`ubuntu`, `macos`, `windows`) that runs `npm pack`, installs the tarball into a clean dir, starts `tax-tracker --port 0` and probes `/health`. That proves the prebuilt argon2 binary resolves on each OS.
- `scripts/backup.ts` and `scripts/backfill-fx.ts` become CLI subcommands. Delete the npm scripts that wrapped them, along with the `--env-file` dependency.

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
- **Automatic pre-migration backup:** [database.ts](../../src/server/db/database.ts) takes a backup before applying any pending migration to a non-empty DB. That's the safety net for `npx tax-tracker@latest`-style upgrades.
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

## Phase 5: Release pipeline and image publication

Ported from technitium/kea-metrics-exporter, which are already SHA-pinned and match this repo's CI.

- `scripts/extract-changelog-section.ts` and a CHANGELOG format check.
- `.github/workflows/release.yml`, triggered on a `v*.*.*` tag:
  - **verify:** lint, typecheck, test, build, pack-allowlist; the tag must match `package.json`; CHANGELOG must have that section.
  - **publish image:** calls `_publish-image.yml`.
  - **npm publish:** uses npm trusted publishing (OIDC) with `--provenance`, rather than a long-lived `NPM_TOKEN`. Gated on `vars.NPM_PUBLISH_ENABLED`.
  - **GitHub Release:** notes taken from CHANGELOG, plus `install.sh`, `install.ps1` and their SHA-256 sums attached as assets (Phase 7).
- `.github/workflows/_publish-image.yml`: multi-arch (`linux/amd64`, `linux/arm64`; arm64 covers Raspberry Pi and Apple-silicon NAS boxes). Pushes to GHCR with build provenance attestation and SBOM.
- `rebuild.yml`: monthly base-image rebuild of the latest release tag.
- `scan.yml`: monthly Trivy scan of `:latest`, uploaded as SARIF.
- Dockerfile changes:
  - `GIT_COMMIT` / `IMAGE_VERSION` build args and OCI labels.
  - Entrypoint becomes the CLI (`node dist/server/cli.js start`), so `docker compose exec tax-tracker tax-tracker backup` works.
  - **Native-addon caveat:** the exporters run `npm ci` in a `--platform=$BUILDPLATFORM` stage and copy `node_modules` across. That's only safe because they have no native addons. Here the prod-deps stage must run on the *target* platform, so the correct argon2 prebuilt is installed. The TS/Vite build stage can stay on `$BUILDPLATFORM`.

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
2. `npm install -g tax-tracker@<pinned version>`.
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

## Open decisions

1. **Package name:** `tax-tracker` (unscoped, short, generic) vs `@apilbeam101/tax-tracker` (scoped, no squatting risk, slightly longer `npx` command). Also `uk-tax-tracker`, which is more discoverable.
2. **Self-configured default:** on by default for CLI/installer installs (recommended) or require explicit `init`.
3. **Scheduled backups:** in-process daily by default (recommended) or off by default.
4. **Order:** Phases 1–4 are code changes and 5–8 are mostly packaging and docs. Phase 5 could go earlier to get a published Docker image out quickly, but the image entrypoint and named-volume compose depend on Phases 1–3.

## Out of scope
- Whole-file encryption (SQLCipher): `node:sqlite` doesn't support it.
- OS keychain storage for the unattended key: needs a native module.
- Hardware-key (WebAuthn/FIDO2) unlock slots: the slot design leaves room to add them later.
- Multi-user or multi-tenant hosting.
- Signed native installers, Homebrew tap and winget manifest. These are good follow-ups once the npm package is stable; a Homebrew formula and winget manifest can wrap the same npm tarball.
- Single-executable (Node SEA) builds: blocked on embedding the native argon2 addon and the client assets.

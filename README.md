# UK Share Tax Liability Tracker

A self-hosted single-user web app for tracking UK Capital Gains Tax, dividend income, and employment income from RSU/ESPP equity grants. Built on Fastify + Svelte 5 + SQLite — no external database server required. Supports light and dark themes.

---

## Screenshots

_Populated with dummy data — no real financial information._

| | |
|---|---|
| **Dashboard** | ![Dashboard](docs/screenshots/dashboard-light.png) |
| **Transactions** | ![Transactions](docs/screenshots/transactions-light.png) |
| **Holdings** | ![Holdings](docs/screenshots/holdings-light.png) |
| **Tax Summary — light** | ![Tax Summary light](docs/screenshots/tax-summary-light.png) |
| **Tax Summary — dark** | ![Tax Summary dark](docs/screenshots/tax-summary-dark.png) |
| **Projections** | ![Projections](docs/screenshots/projections-light.png) |
| **Import / Export — light** | ![Import/Export light](docs/screenshots/import-export-light.png) |
| **Import / Export — dark** | ![Import/Export dark](docs/screenshots/import-export-dark.png) |

---

## Prerequisites

- **Node.js ≥ 24** (uses the built-in `node:sqlite` module)

### Installing Node.js

**macOS** — using [Homebrew](https://brew.sh):
```bash
brew install node
```

**Linux** — using [nvm](https://github.com/nvm-sh/nvm) (works on any distro):
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/HEAD/install.sh | bash
# restart your shell, then:
nvm install 26
nvm use 26
```

**Windows** — using [winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/):
```powershell
winget install OpenJS.NodeJS.LTS
```
After install, open a new terminal for the `node` and `npm` commands to be available.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/apilbeam101/tax-tracker.git tax-tracker
cd tax-tracker
npm install
```

### 2. Generate secrets

```bash
# SESSION_SECRET — at least 32 bytes of random hex. Skip it if you set AUTO_CONFIG=true (see below):
# the app then generates one into config.json in the data directory.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# ENCRYPTION_KEY — optional, only for an always-on server that should unlock its data by itself
# at startup (see the table below). Skip it for a laptop install.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Configure .env

```bash
cp .env.example .env
```

Edit `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `AUTO_CONFIG` | No | `false` (default when the server is started directly or in Docker): every setting comes from the environment and the app never writes configuration. `true` (default for the `tax-tracker` command): self-configured mode, see below. Set `AUTO_CONFIG=false` in `.env` to keep env-supplied mode with `npm start` |
| `SESSION_SECRET` | Yes, unless `AUTO_CONFIG=true` | 64-char hex string for cookie signing (placeholders and short values are rejected) |
| `ENCRYPTION_KEY` | No | 64-char hex string. Optional: when you encrypt the database you can choose to use it to unlock the data automatically at startup. The key then sits next to the data, so leave it unset unless the server must restart unattended |
| `PORT` | No | Server port (default: `3000`) |
| `HOST` | No | Bind address (default: `127.0.0.1`) |
| `DB_PATH` | No | SQLite file path. Takes precedence over `DATA_DIR` |
| `DATA_DIR` | No | Directory for `taxtracker.db`. If neither is set, `./data` is used when it already holds a database, otherwise the per-user OS data directory. The resolved path is logged at startup |
| `FX_RATE_POLICY` | No | `hmrc-monthly` (default) or `daily-spot` |
| `TIINGO_API_KEY` | No | Live price data (free tier: 500 symbols, 50 req/hr) |
| `ALPHA_VANTAGE_API_KEY` | No | Dividend history import (free at alphavantage.co) |
| `SECURE_COOKIES` | No | `auto` (default: Secure when the request arrived over HTTPS), `true` or `false` |
| `TRUST_PROXY` | No | Set when behind a reverse proxy so `auto` sees the original protocol: `true`, or a comma-separated list of IPs, CIDRs or `loopback`/`linklocal`/`uniquelocal` (see [Reverse proxy](#reverse-proxy-https)) |
| `LOG_LEVEL` | No | Pino log level (default: `info`) |

Every secret (`SESSION_SECRET`, `ENCRYPTION_KEY`, `TIINGO_API_KEY`, `ALPHA_VANTAGE_API_KEY`) also accepts a `_FILE` variant, for example `SESSION_SECRET_FILE=/run/secrets/session`, for Docker secrets, Kubernetes secret volumes and systemd credentials.

**Self-configured mode (`AUTO_CONFIG=true`).** If `SESSION_SECRET` is not supplied, the app generates one into `config.json` in the data directory and reuses it on later starts. The file is written atomically with mode `0600` on Linux and macOS (on Windows it relies on the per-user data directory), and holds only that secret plus the non-secret settings `HOST`, `PORT`, `FX_RATE_POLICY`, `LOG_LEVEL`, `SECURE_COOKIES` and `TRUST_PROXY`. It never holds `ENCRYPTION_KEY`, API keys or any other key material, and the app refuses to start if the file contains anything else. Variables set in the environment always override the file. In a container, the data volume must be writable and persistent; otherwise the secret is regenerated at every start and everyone is signed out.

### 4. Build and start

```bash
npm run build
npm start -- --env-file .env
```

`npm start` runs the `tax-tracker` command-line tool (`node dist/server/cli.js`). It reads the environment, and `--env-file` loads a `.env` file. Other options: `--port`, `--host`, `--data-dir`, `--open`. `tax-tracker --help` lists the commands: `init`, `info`, `doctor`, `backup`, `backfill-fx` and `keys`. The command-line tool defaults to self-configured mode (`AUTO_CONFIG=true`) unless `AUTO_CONFIG` is set.

Or, for development with hot-reload:

```bash
npm run dev
```

### 5. First-run setup

Open `http://localhost:3000` in your browser. Setup has three steps:

1. Choose a passphrase. It signs you in and unlocks your data: it protects a randomly generated data key, which in turn protects the sensitive fields.
2. Save your **recovery key**. It is shown once and you must type it back to continue. It is the only way back in if you forget your passphrase. **Store the passphrase and the recovery key securely and separately; losing both means losing access to your data.**
3. Optionally enter API keys (Tiingo, Alpha Vantage). In self-configured mode (`AUTO_CONFIG=true`), keys entered here are stored encrypted with your data and can be changed later under Settings. In env-supplied mode (the default outside the `tax-tracker` command) the API key fields are read-only: keys come from the environment (`.env`, Docker or Kubernetes secrets), so a redeploy always matches what you configured. A key supplied through the environment always takes precedence and is shown as "Set via environment".

If you started from a database created by an earlier version, you are offered an in-app upgrade after you sign in instead.

Setup signs you in. On later visits, sign in with username `admin` and your passphrase; that also unlocks your data. A 🌙/☀️ toggle in the nav bar (next to the number-masking toggle) switches between light and dark themes; the choice is remembered in your browser.

---

## Docker (alternative to steps 3-4 above)

```bash
cp .env.example .env
```

Edit `.env` and fill in a **real, generated** `SESSION_SECRET` (step 2 above) — the app refuses to start if it, or an `ENCRYPTION_KEY` you set, still holds the `CHANGE_ME` placeholder.

The container runs as a fixed non-root UID (`10001`), and its SQLite data lives in a directory bind-mounted from the host (`./data`) so it survives a container recreate. That host directory needs to already be owned by that UID before the first run — Docker does not do this for you on a bind mount:

```bash
mkdir -p data
sudo chown -R 10001:10001 data
```

Then build and start:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

The published port is bound to `127.0.0.1` only, same as the non-Docker setup — put it behind a reverse proxy (see [Reverse proxy (HTTPS)](#reverse-proxy-https) below) rather than exposing it directly. `npm start -- backup --data-dir ./data` on the host (add `--env-file .env` if your settings live there) works against the bind-mounted `data/taxtracker.db`.

---

## Optional: Live prices (Tiingo)

1. Sign up for a free account at [tiingo.com](https://www.tiingo.com)
2. Set it in the environment (`.env`) as `TIINGO_API_KEY` and restart the server, or, with `AUTO_CONFIG=true`, enter it under Settings in the app (no restart needed)

Without Tiingo, prices fall back to Yahoo Finance (no API key required). If neither returns data, holdings valuations will show `—`.

## Optional: Dividend history import (Alpha Vantage)

1. Get a free API key at [alphavantage.co](https://www.alphavantage.co)
2. Set `ALPHA_VANTAGE_API_KEY` in the environment, or, with `AUTO_CONFIG=true`, enter it under Settings in the app
3. Use the "↓ Import dividends" button on the Transactions page to pull dividend history per instrument

For USD-currency holdings, US withholding tax (15% under the UK-US tax treaty, assuming a valid W-8BEN is on file with your broker) is filled in automatically on dividend transactions when no withholding amount is entered or imported. Edit the transaction afterwards if your actual broker statement shows a different figure — an explicit value is never overwritten.

---

## Running the tax engine

After entering transactions, open **Tax Summary** and click **Run tax engine** (or `POST /api/tax/run`) to calculate CGT disposals. This is idempotent — it deletes and re-inserts disposal records for each instrument.

If your imported transactions are missing GBP fields, run the FX backfill first:

```bash
npm start -- --env-file .env backfill-fx
```

`backfill-fx` writes columns directly and cannot unlock a database, so it refuses to run against one that has key slots.

---

## Database backup

```bash
tax-tracker backup        # or: npm start -- backup
```

Creates a timestamped copy at `<data dir>/backups/taxtracker-YYYY-MM-DDTHH-MM-SS.db`. Schedule this via cron for regular backups:

```cron
0 2 * * * cd /path/to/claude-tax && npm start -- --env-file .env backup
```

---

## Reverse proxy (HTTPS)

Run the app behind a reverse proxy with TLS. The server binds to `127.0.0.1` by default — do **not** expose port 3000 directly.

Set `TRUST_PROXY` in `.env` so the app sees the original protocol from the proxy's `X-Forwarded-Proto` header, and session cookies are then marked `Secure` automatically (`SECURE_COOKIES=auto`):

- Proxy on the same host (the Caddy and nginx examples below): `TRUST_PROXY=loopback`
- Proxy reaching a Docker container over the bridge network: `TRUST_PROXY=uniquelocal`

Without it, cookies are issued without `Secure`. Setting `SECURE_COOKIES=true` without `TRUST_PROXY` means no session cookie is issued at all.

### Caddy (recommended)

```
your-domain.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy handles TLS automatically via Let's Encrypt. No further config needed.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name your-domain.example.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name your-domain.example.com;
    return 301 https://$host$request_uri;
}
```

Use Certbot to issue the certificate:

```bash
certbot --nginx -d your-domain.example.com
```

---

## Development commands

```bash
npm run dev          # Dev server with hot-reload (tsx watch)
npm run build        # Full build: Svelte SPA then TypeScript server
npm test             # Run all tests once
npm run test:watch   # Vitest watch mode
npm run lint         # Biome check (lint + format check)
npm start -- --env-file .env backup  # Timestamped DB backup to <data dir>/backups/
```

Run a single test file:

```bash
npx vitest run src/server/services/tax/matching.test.ts
```

---

## Security

### OWASP Top 10 review (self-hosted threat model)

| # | Risk | Status |
|---|---|---|
| A01 Broken Access Control | All API routes require a valid session via `requireAuth`. Single-tenant design — `tenant_id` scoped on every query. No IDOR: IDs are validated against `tenant_id` before returning. | **Mitigated** |
| A02 Cryptographic Failures | Passwords: argon2id with default cost parameters. Sessions: HttpOnly, `SameSite=Lax`, 8h idle timeout; `Secure` flag set automatically when the request arrived over HTTPS. Field-level AES-256-GCM on sensitive columns. The session secret is a required env var and is rejected if it is a placeholder or too short (server refuses to start). | **Mitigated** |
| A03 Injection | All DB queries use parameterised prepared statements — no string interpolation. Input validated via Fastify JSON schema before reaching route handlers. Decimal values validated with `/^\d+(\.\d+)?$/` before `big.js`. | **Mitigated** |
| A04 Insecure Design | Single-user, self-hosted. No user enumeration: login uses constant-time password check against a dummy hash when username is unknown. CSRF synchronizer token on all state-changing requests. | **Mitigated** |
| A05 Security Misconfiguration | `@fastify/helmet` sets strict CSP (`default-src 'self'`), `Referrer-Policy: same-origin`, and other security headers. `robots.txt` disallows all crawlers. Rate limiting: 200 req/min global; 10 req/15min on login; 5 req/15min on setup. | **Mitigated** |
| A06 Vulnerable Components | No browser-side JS dependencies beyond Svelte (compiled away). Server deps are minimal and version-pinned. Run `npm audit` regularly. | **Review periodically** |
| A07 Authentication Failures | argon2id hashing. Login rate-limited (10/15min). Session regenerated on login to prevent fixation. No "remember me" / persistent tokens. | **Mitigated** |
| A08 Software and Data Integrity | No dynamic `eval` or `new Function`. No CDN resources — all assets self-hosted. `import.meta` used for ESM resolution rather than `__dirname`. | **Mitigated** |
| A09 Logging and Monitoring | `audit_log` table records all create/update/delete on transactions and instruments with `old_data`/`new_data` JSON. Fastify request logging via Pino. | **Mitigated** |
| A10 SSRF | External HTTP calls are made only to pre-configured, hardcoded endpoints (HMRC, Frankfurter, Tiingo, Stooq, Alpha Vantage). No user-supplied URLs are fetched. | **Mitigated** |

### Additional notes

- **This app is single-user and self-hosted.** Do not expose port 3000 directly — always place it behind a reverse proxy with TLS.
- Keep your `.env` file out of version control (it is in `.gitignore`).
- Back up the database regularly (`tax-tracker backup`). The backup is a plain SQLite file — store it somewhere safe, preferably off-site.
- Encrypted fields use a random data key that is wrapped by your passphrase and by the recovery key. The plaintext data key is never stored on disk, and is held in memory only while a session is signed in (or permanently, if you opted in to an unattended `ENCRYPTION_KEY` slot).
- `config.json` (self-configured mode) holds the session secret and non-secret settings only, never key material. API keys entered in the UI are stored encrypted.

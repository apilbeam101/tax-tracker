# Configuration

## Two modes

**Self-configured** (`AUTO_CONFIG=true`). The app generates its session secret on first start and
keeps it, with any plain settings you change, in `config.json` in the data folder. API keys can be
entered in the app under Settings, where they are stored encrypted. This is the default for the
`tax-tracker` command, the installers and the Compose file.

**Env-supplied** (`AUTO_CONFIG=false`). Every setting and secret comes from the environment, and
the app never writes configuration. API keys come only from the environment, and Settings shows
them read-only. This is the default in the container image when nothing else is set, and what the
Kubernetes manifests and the systemd unit use.

## Where a setting comes from

From highest to lowest priority:

1. a command-line flag (`--port`, `--host`, `--data-dir`);
2. an environment variable;
3. a file passed with `--env-file` (it does not override variables already set);
4. `config.json`, in self-configured mode only;
5. the default.

For API keys, an environment variable always wins over a key entered under Settings, and Settings
shows "Set via environment".

## Secrets

Every secret can be given directly or as a file: `SESSION_SECRET=...` or
`SESSION_SECRET_FILE=/run/secrets/session`. Setting both is an error. Values are trimmed, so a file
with a trailing newline works. The app refuses to start with a placeholder value (`CHANGE_ME...`)
or a secret that is too short: at least 32 characters, or 64 if it is written in hex.

Generate one with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Settings

| Variable | Default | Values | |
|---|---|---|---|
| `HOST` | `127.0.0.1` | an address | Where the app listens. Containers need `0.0.0.0`. |
| `PORT` | `3000` | `0`-`65535` | `0` picks a free port. |
| `DATA_DIR` | see below | a folder | Database, backups and `config.json`. |
| `DB_PATH` | | a file | The database file itself; its folder becomes the data folder. Cannot be combined with `--data-dir`. |
| `AUTO_CONFIG` | `true` for the command, `false` otherwise | `true`, `false` | See the two modes above. |
| `SESSION_SECRET` | generated in self-configured mode | a secret | Signs session cookies. Required in env-supplied mode. |
| `ENCRYPTION_KEY` | | a secret | Optional unattended unlock key; see [Security model](SECURITY_MODEL.md#unlock-modes). |
| `TIINGO_API_KEY` | | a key | Optional: daily prices from Tiingo. |
| `ALPHA_VANTAGE_API_KEY` | | a key | Optional: dividend history import from Alpha Vantage. |
| `FX_RATE_POLICY` | `hmrc-monthly` | `hmrc-monthly`, `daily-spot` | Exchange rates for converting to GBP. HMRC's monthly rates fall back to the daily rate when a month is missing. |
| `BACKUP_SCHEDULE` | `daily` in self-configured mode, `off` otherwise | `daily`, `off` | Automatic daily backup into `backups/`. |
| `RESTORE_RESTART` | `manual` | `manual`, `exit` | `exit`: after a restore is staged from the app, the app exits so that whatever supervises it starts it again with the restored database. |
| `SECURE_COOKIES` | `auto` | `auto`, `true`, `false` | `auto` marks cookies `Secure` when the request arrived over HTTPS. |
| `TRUST_PROXY` | off | `true`, `false`, or a comma-separated list of addresses, CIDR ranges, `loopback`, `linklocal`, `uniquelocal` | Which proxies' `X-Forwarded-*` headers to believe. Needed behind a reverse proxy for `SECURE_COOKIES=auto` to see HTTPS. A hop count is not accepted. |
| `LOG_LEVEL` | `info` (`warn` in the image) | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` | |

The secrets (`SESSION_SECRET`, `ENCRYPTION_KEY`, `TIINGO_API_KEY`, `ALPHA_VANTAGE_API_KEY`) also
accept the `_FILE` form.

`SECURE_COOKIES=true` without a working `TRUST_PROXY` behind a proxy means the app never sees HTTPS
and issues no session cookie at all, so you cannot sign in.

## `config.json`

In self-configured mode the data folder holds `config.json`. It may contain `SESSION_SECRET` and
these settings only: `HOST`, `PORT`, `FX_RATE_POLICY`, `LOG_LEVEL`, `SECURE_COOKIES`, `TRUST_PROXY`,
`BACKUP_SCHEDULE`, `RESTORE_RESTART`. The app refuses a file with anything else in it, so key
material and API keys can never be kept there. On macOS and Linux it is created readable only by
its owner.
`tax-tracker init --interactive` sets the exchange-rate policy in it.

## Data folder

The first of these that applies:

1. `DB_PATH`, if set;
2. `DATA_DIR` (or `--data-dir`), if set;
3. `./data` in the current directory, if it already holds `taxtracker.db`;
4. the per-user folder: `~/Library/Application Support/tax-tracker` on macOS,
   `%APPDATA%\tax-tracker` on Windows, `$XDG_DATA_HOME/tax-tracker` or
   `~/.local/share/tax-tracker` on Linux.

The container image sets `DATA_DIR=/app/data`.

`tax-tracker info` shows which folder is in use and why, and `tax-tracker doctor` checks the whole
configuration without printing or asking for any secret.

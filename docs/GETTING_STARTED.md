# Getting started

This page picks up once the app is installed and running ([INSTALL.md](INSTALL.md) if it is not
yet). It covers first-run setup, the optional price and dividend sources, and running the tax
engine.

## First-run setup

Open `http://127.0.0.1:3000` in your browser (or the address your install uses). Setup has three
steps:

1. **Choose a passphrase.** It signs you in and unlocks your data: it protects a randomly
   generated data key, which in turn protects the sensitive fields.
2. **Save your recovery key.** It is shown once and you must type it back to continue. It is the
   only way back in if you forget your passphrase. **Store the passphrase and the recovery key
   securely and separately; losing both means losing access to your data.**
3. **Optionally enter API keys** for Tiingo and Alpha Vantage (below). Where they go depends on
   how the app is configured:
   - *Self-configured* installs (the installers and the Compose file): keys entered here are
     stored encrypted with your data and can be changed later under Settings.
   - *Env-supplied* installs (the Kubernetes manifests and the systemd unit): the fields are
     read-only, because keys come from the environment or secret files, so a redeploy always
     matches what you configured.

   A key supplied through the environment always takes precedence and is shown as "Set via
   environment". See [Configuration](CONFIGURATION.md).

If you started from a database created by an earlier version, you are offered an in-app upgrade
after you sign in instead.

Setup signs you in. On later visits, sign in with the username `admin` and your passphrase; that
also unlocks your data. If you have forgotten the passphrase, the sign-in page lets you use your
recovery key to set a new one. A toggle in the navigation bar (next to the number-masking toggle)
switches between light and dark themes; the choice is remembered in your browser.

## Adding your data

Add transactions in the web UI, through the REST API, or by CSV import:
[Adding transactions](adding-transactions.md).

## Live prices (Tiingo), optional

1. Sign up for a free account at [tiingo.com](https://www.tiingo.com) (the free tier allows 500
   symbols and 50 requests an hour).
2. Enter the key under Settings in the app (self-configured installs, no restart needed), or set
   `TIINGO_API_KEY` in the environment and restart the app.

Without Tiingo, prices fall back to Yahoo Finance, which needs no key. If neither returns data,
holdings valuations show `—`.

## Dividend history import (Alpha Vantage), optional

1. Get a free API key at [alphavantage.co](https://www.alphavantage.co).
2. Enter it under Settings in the app, or set `ALPHA_VANTAGE_API_KEY` in the environment.
3. Use the "↓ Import dividends" button on the Transactions page to pull dividend history for an
   instrument.

For USD-currency holdings, US withholding tax (15% under the UK-US tax treaty, assuming a valid
W-8BEN is on file with your broker) is filled in automatically on dividend transactions when no
withholding amount is entered or imported. Edit the transaction afterwards if your broker
statement shows a different figure: an explicit value is never overwritten.

## Running the tax engine

After entering transactions, open **Tax Summary** and click **Run tax engine** to calculate CGT
disposals. This is safe to repeat: it deletes and re-inserts the disposal records for each
instrument.

Transactions entered in the app, through the API or by CSV import get their GBP amounts as they are
saved. If imported transactions in a database that has not been encrypted yet are missing them,
fill them in with:

```sh
tax-tracker backfill-fx
```

`backfill-fx` writes to the database directly and cannot unlock it, so it refuses to run once the
database has been encrypted; use the app's Import / Export page instead.

## Next

- [Backups, restore and archives](BACKUP_RESTORE.md): set up somewhere other than this machine for
  the backups to go.
- [Security model](SECURITY_MODEL.md): what is protected, and the unlock modes.
- [Configuration](CONFIGURATION.md)

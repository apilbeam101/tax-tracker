# Security model

UK Tax Tracker is a single-user app that you host yourself. This page describes what protects your
data, what does not, and the choices you make when you install it.

## What is encrypted

Sensitive fields are encrypted individually with AES-256-GCM, inside the database file:

| Data | Encrypted |
|---|---|
| Instruments | ticker, ISIN, name, exchange, notes, employer-stock flag, withholding method |
| Transactions | quantities, prices, exchange rates, amounts, costs, income, dividend and RSU figures |
| Section 104 pools and disposals | quantities, proceeds, costs, gains |
| Scheduled vests | quantities, expected prices, notes |
| Stored prices | closing prices |
| Audit log | the before and after values of every change, and the client address |
| API keys entered in the app | the key |

Some fields stay readable, because the database needs them to find, order and group records:

- dates (transaction, disposal, vest and price dates, timestamps) and the tax year a disposal falls in;
- transaction types (buy, sell, vest, dividend...), currencies and instrument types;
- the links between records (which disposal matches which acquisition);
- the tax-year rates and allowances table, and published exchange rates;
- the username, display preferences and the last sign-in time;
- which kind of change each audit-log entry records.

So someone who obtains the database file, but not your passphrase, can see **when** you traded and
what kind of transaction it was, but not **what** you traded, how many, at what price, or what you
gained.

## Keys and key slots

A random data key encrypts the fields. It is never stored as it is: it is stored only wrapped
(encrypted) in **key slots**, each of which opens it a different way:

| Slot | Opened by | Created |
|---|---|---|
| Passphrase | your passphrase (argon2id) | at first-run setup |
| Recovery | your recovery key | at first-run setup; replace it with `tax-tracker keys rotate-recovery` |
| Unattended (optional) | the `ENCRYPTION_KEY` the app is configured with (argon2id) | only if you opt in |

The recovery key is shown once and counts as unconfirmed until you type it back in the app.
`tax-tracker keys rotate` replaces the data key itself and re-encrypts everything.

Your sign-in password and your passphrase are the same thing: signing in unlocks the data.

## Unlock modes

**Passphrase (the default).** The data key is in memory only while you are signed in. After a
restart the app is **locked**: it serves the sign-in page and its health check, and refuses every
data request (`423 Locked`) until someone signs in. Nothing that could open the data is stored on
the machine.

**Unattended (opt-in).** The app reads `ENCRYPTION_KEY` (or `ENCRYPTION_KEY_FILE`) at startup and
unlocks the data by itself, so a server can come back after a reboot with nobody present. The cost:
the key that opens the data now sits on the same machine, so anyone who can read both the key and
the data can read everything. Use it only on a machine you control, keep the key outside the data
folder and outside backups (`tax-tracker doctor` fails if the key file is inside the data folder),
and prefer a secrets mechanism (Docker or Kubernetes secrets, systemd credentials) over an
environment variable.

The app refuses to start if an unattended slot exists and the configured key does not open it,
rather than starting in a state nobody expects.

## Backups and archives

- A **backup** is a copy of the database, encrypted fields and key slots included. It opens with the
  passphrase or recovery key that was valid when it was taken, so the same rules apply to it as to
  the database itself.
- An **archive** is encrypted with its own export passphrase, unless you explicitly export plaintext.
- **CSV and PDF exports** are not encrypted.

## What this does not protect against

- **A compromised machine while the app is unlocked.** The data key is in the app's memory then, and
  malware running as your user or as an administrator can read it, or read what the app shows you.
- **A weak passphrase.** argon2id makes guessing slow, but not impossible. Use a long passphrase.
- **Files you take out of the app.** CSV and PDF exports, plaintext archives, and screenshots.
- **The readable fields listed above.** Dates and transaction types show activity patterns.
- **Losing both the passphrase and the recovery key.** Nobody can recover the data then.

Full-disk encryption (FileVault, BitLocker, LUKS) complements this: it protects everything on the
disk, including logs and exports, when the machine is off.

## Other protections

- Passwords are hashed with argon2id. Sign-in is rate limited, and unknown usernames take as long
  to reject as wrong passwords.
- Sessions are HttpOnly cookies with an 8-hour idle timeout and a CSRF token on every change.
  Cookies are marked `Secure` when the request arrived over HTTPS (see `SECURE_COOKIES` and
  `TRUST_PROXY` in [Configuration](CONFIGURATION.md)).
- The app listens on `127.0.0.1` by default and sends strict security headers. It only ever calls
  the exchange-rate, price and dividend providers it is built for.
- The configuration file (`config.json`) can hold the session secret and plain settings only: the
  app refuses to read one that contains anything else, so key material and API keys never end up in
  it.
- Releases are built by GitHub Actions with build provenance: the container image (with an SBOM for
  each platform), the npm package and the installer scripts can all be checked against this
  repository.

To report a vulnerability, use **Report a vulnerability** on this repository's Security tab rather
than a public issue.

## OWASP Top 10 review

A review of the app against the OWASP Top 10, for a single-user, self-hosted deployment.

| # | Risk | Status |
|---|---|---|
| A01 Broken Access Control | All API routes require a valid session. Single-tenant design, with `tenant_id` scoped on every query. IDs are validated against `tenant_id` before anything is returned. | **Mitigated** |
| A02 Cryptographic Failures | Passwords: argon2id. Sessions: HttpOnly, `SameSite=Lax`, 8-hour idle timeout, `Secure` set automatically when the request arrived over HTTPS. Field-level AES-256-GCM on sensitive columns, under a key protected by your passphrase. The session secret is required (or generated in self-configured mode) and a placeholder or short value is rejected. | **Mitigated** |
| A03 Injection | All database queries are parameterised prepared statements, with no string interpolation. Input is validated against a JSON schema before it reaches a route handler. Decimal values are validated before they reach `big.js`. | **Mitigated** |
| A04 Insecure Design | Single-user and self-hosted. No user enumeration: sign-in checks the password against a dummy hash when the username is unknown. CSRF synchronizer token on every state-changing request. | **Mitigated** |
| A05 Security Misconfiguration | `@fastify/helmet` sets a strict content security policy (`default-src 'self'`), `Referrer-Policy: same-origin` and other security headers. `robots.txt` disallows all crawlers. Rate limits: 200 requests a minute overall, 10 in 15 minutes on sign-in, 5 in 15 minutes on setup. | **Mitigated** |
| A06 Vulnerable Components | The browser side has no dependencies beyond Svelte, which is compiled away. Server dependencies are few and pinned by lockfile. CI runs `npm audit` on production dependencies, Dependabot proposes updates, and the container image is rebuilt and scanned monthly. | **Review periodically** |
| A07 Authentication Failures | argon2id hashing. Sign-in is rate limited. The session is regenerated on sign-in to prevent fixation. No "remember me" or persistent tokens. | **Mitigated** |
| A08 Software and Data Integrity | No dynamic `eval` or `new Function`. No CDN resources: every asset is self-hosted. Releases carry build provenance (image, npm package and installer scripts). | **Mitigated** |
| A09 Logging and Monitoring | The `audit_log` table records every create, update and delete on transactions and instruments, with the before and after values encrypted. Request logging through Pino, with secrets redacted. | **Mitigated** |
| A10 SSRF | External requests go only to fixed, built-in endpoints: HMRC's trade-tariff service, Frankfurter, Tiingo, Yahoo Finance and Alpha Vantage. No user-supplied URL is ever fetched. | **Mitigated** |

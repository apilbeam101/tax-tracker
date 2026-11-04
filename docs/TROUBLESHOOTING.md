# Troubleshooting

## Start with `doctor`

```sh
tax-tracker doctor
```

It checks the installation and prints one line per check. It never prints or asks for a secret, so
its output is safe to share. It exits with status 1 if any check fails. In a container, run it as
`docker compose run --rm tax-tracker doctor`; on Kubernetes,
`kubectl -n tax-tracker exec tax-tracker-0 -- tax-tracker doctor`.

| Check | When it fails | What to do |
|---|---|---|
| `node` | Node.js is older than 24 | Upgrade Node.js. |
| `data directory` | the folder is not readable and writable by the user running the app | In Docker with a host folder: `sudo chown -R 10001:10001 <folder>`. Elsewhere, fix the folder's owner, or point `DATA_DIR` at a folder you own. |
| `config file` | `config.json` is not valid JSON or contains a name it may not | Fix or remove the named entry. API keys and the unlock key never belong in it. |
| `settings` | a setting has an invalid value, or a secret is missing, a placeholder or too short | The message lists every problem; see [Configuration](CONFIGURATION.md). |
| `unattended key location` | `ENCRYPTION_KEY_FILE` is inside the data folder, so backups and volume snapshots would carry the key that opens them | Move the key file somewhere else. |
| `database` / `database integrity` | the file cannot be opened, or fails SQLite's integrity check | Restore the newest good backup ([Backups](BACKUP_RESTORE.md#restore)). |
| `key slots` | slots are missing or disagree | The database may be damaged; restore a backup. |
| `port` (warning) | something is already listening | Usually the app itself is already running. Otherwise pick another port with `--port` or `PORT`. |
| `unattended key` | `ENCRYPTION_KEY` does not open the unattended slot, so the app will refuse to start | Supply the key that was used to create the slot, or remove the slot with `tax-tracker keys remove-unattended` (needs your passphrase). |
| `unattended key` (warning) | `ENCRYPTION_KEY` is set but there is no unattended slot, so it is ignored | Add the slot with `tax-tracker keys add-unattended`, or stop supplying the key. |

`tax-tracker info` shows the version, the data folder and why it was chosen, the configuration mode
and the unlock mode.

## Common problems

**The app asks me to sign in after every restart.** That is the default: the data stays locked
until someone signs in. See [unlock modes](SECURITY_MODEL.md#unlock-modes) for the alternative.

**Every page or request says the data is locked (`423`).** Sign in. If you are signed in in another
tab, your session may have timed out after 8 idle hours.

**I can open the app but cannot sign in behind a reverse proxy (or I am sent back to the sign-in
page).** The proxy's HTTPS is not reaching the app. Set `TRUST_PROXY` (`loopback` for a proxy on
the same host, `uniquelocal` for Docker or Kubernetes, or the proxy's address) and keep
`SECURE_COOKIES=auto`. `SECURE_COOKIES=true` with no working `TRUST_PROXY` issues no cookie at all.

**Restoring a backup from the app fails with `413` or "request entity too large".** The reverse
proxy limits upload size. nginx: `client_max_body_size 512m;`. ingress-nginx: the
`proxy-body-size` annotation in [`ingress.example.yaml`](../deploy/kubernetes/ingress.example.yaml).

**I restored a backup from the app and nothing changed.** The restore is applied the next time the
app starts. Restart it, or set `RESTORE_RESTART=exit` where something restarts the app when it exits.

**`restore`, `import` or `keys rotate` says the app is running.** Stop it first. The command checks
a lock file the app refreshes every few seconds; a lock older than 30 seconds is ignored, so after
a crash wait half a minute.

**Docker: the container keeps restarting with `SQLITE_CANTOPEN`.** A host folder is mounted that
the image's user cannot write: `sudo chown -R 10001:10001 <folder>`, or use the named volume from
the Compose file.

**Docker: the app is unreachable through the published port, but the container is healthy.** The
app is listening on the container's own loopback. Set `HOST=0.0.0.0` (the Compose file does).

**Kubernetes: the app is unreachable through the ingress.** Check that the NetworkPolicy's
namespace selector names the namespace your ingress controller really runs in.

**The installer said npm's global folder is not writable.** It installed under `~/.local` instead;
add `~/.local/bin` to your `PATH`.

**Windows: the app does not start at logon.** Open Task Scheduler and look at the "UK Tax Tracker"
task's last result, and at `%LOCALAPPDATA%\UkTaxTracker\tax-tracker.log`.

**macOS: the app does not start at login.** Look at `~/Library/Logs/tax-tracker/tax-tracker.log`
and run `launchctl print gui/$(id -u)/com.apilbeam101.tax-tracker`.

**I forgot my passphrase.** On the sign-in page, use your recovery key to set a new passphrase.
If you have lost both, the encrypted data cannot be recovered.

## Asking for help

Open an issue on the repository and choose the form that fits: *Bug report* (it asks for the output
of `tax-tracker doctor`, the version and how you installed it), *A tax figure looks wrong* (describe
a small scenario with made-up figures, and say where you think the right answer comes from), or
*Feature request*. **Never paste real financial data, passphrases, recovery keys or secrets** into
an issue: this repository is public. For a security problem, do not open an issue; follow the
[security policy](../SECURITY.md).

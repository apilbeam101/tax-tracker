# Installing UK Tax Tracker

UK Tax Tracker is a single-user app that you run yourself. Your data stays in one SQLite file on
the machine (or volume) you choose. Pick the install that matches how you want to use it:

| You want to... | Install | Unlock after a restart | Guide |
|---|---|---|---|
| Use it on your own laptop or desktop | The installer script (macOS, Windows, Linux) | You sign in | [Desktop](INSTALL_DESKTOP.md) |
| Try it once without installing anything permanent | `npx uk-tax-tracker` | You sign in | [Desktop](INSTALL_DESKTOP.md#try-it-without-installing) |
| Run it on a home server or NAS with Docker | Docker Compose | You sign in, or unattended | [Docker](INSTALL_DOCKER.md) |
| Run it on a Kubernetes cluster | `kubectl apply -k` | You sign in, or unattended | [Kubernetes](INSTALL_KUBERNETES.md) |
| Run it as a service on a Linux server without containers | npm + systemd + a reverse proxy | You sign in, or unattended | [Standalone](INSTALL_STANDALONE.md) |

Every install needs Node.js 24 or later, except Docker and Kubernetes, where it is inside the
image. The installer script installs Node for you if it is missing.

## Before you start

- **Your passphrase and recovery key are the only way into your data.** First-run setup asks for a
  passphrase and shows a recovery key once. Store them separately, somewhere other than the
  machine running the app. If both are lost, the encrypted data cannot be recovered by anyone.
- **"Unlock after a restart"** decides what happens when the app starts again (a reboot, an
  upgrade). By default the data stays locked until someone signs in, so the key that opens it is
  never stored next to it. An always-on server can opt in to unattended unlock instead; see
  [Security model](SECURITY_MODEL.md#unlock-modes) for the trade-off.
- **Do not expose the app directly to the internet.** It listens on `127.0.0.1` by default. To
  reach it from other devices, put it behind HTTPS (the Docker guide has a one-command option, and
  the standalone guide shows Caddy and nginx).

## After installing

- [Getting started](GETTING_STARTED.md): first-run setup, price and dividend sources, running the tax engine
- [Backups, restore and archives](BACKUP_RESTORE.md)
- [Configuration reference](CONFIGURATION.md)
- [Upgrading](UPGRADING.md)
- [Troubleshooting](TROUBLESHOOTING.md), starting with `tax-tracker doctor`

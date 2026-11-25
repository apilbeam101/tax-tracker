# Desktop install (macOS, Windows, Linux)

The installer script sets UK Tax Tracker up for your own user account:

1. Checks for Node.js 24 or later. If it is missing it offers to install it (macOS: Homebrew if
   you have it, otherwise the official installer from nodejs.org, checked against a pinned
   checksum; Windows: `winget`; Linux: it tells you how). It never changes a Node.js you already
   have; if yours is older than 24 it stops and says so.
2. Installs the `uk-tax-tracker` package with npm.
3. Creates the configuration (`tax-tracker init`).
4. Asks whether to start the app when you log in (macOS: a launchd agent; Windows: a scheduled
   task). The app is restarted if it stops, including after you restore a backup from inside the
   app. On Linux it installs the command only; see [Standalone](INSTALL_STANDALONE.md) for a
   systemd service.
5. Asks whether to add a shortcut (macOS: Desktop; Windows: Start menu).

It needs no administrator rights, except when it installs Node.js for you on macOS without
Homebrew (the nodejs.org installer asks for your password). Do not run it as root or from an
administrator prompt: the app, its data and its service would then belong to that account.

## Install

Each release has the installers attached, with that release's version written into them. Replace
`<version>` with the release you want (for example `0.1.0`). For the newest release, use
`https://github.com/apilbeam101/tax-tracker/releases/latest/download/install.sh` (or
`install.ps1`), which never points at a pre-release.

**macOS and Linux**

```sh
curl -fsSL https://github.com/apilbeam101/tax-tracker/releases/download/v<version>/install.sh | sh
```

**Windows** (PowerShell)

```powershell
& ([scriptblock]::Create((irm https://github.com/apilbeam101/tax-tracker/releases/download/v<version>/install.ps1)))
```

When it finishes it prints where your data lives, where backups go, and how to uninstall. Open
`http://127.0.0.1:3000` (or the shortcut) and go through first-run setup.

### Check the script before running it

To read and verify the script first, download it, check where it came from and that it was not
altered, then run the copy you checked. The release also has a `SHA256SUMS` file and a build
attestation, which proves the file was built by this repository's release workflow:

```sh
curl -fsSLO https://github.com/apilbeam101/tax-tracker/releases/download/v<version>/install.sh
gh attestation verify install.sh --repo apilbeam101/tax-tracker   # needs the GitHub CLI
less install.sh
sh install.sh
```

```powershell
irm https://github.com/apilbeam101/tax-tracker/releases/download/v<version>/install.ps1 -OutFile install.ps1
gh attestation verify install.ps1 --repo apilbeam101/tax-tracker
notepad install.ps1
& ([scriptblock]::Create((Get-Content -Raw .\install.ps1)))
```

Without the GitHub CLI, compare the checksum with the release's `SHA256SUMS` instead
(`grep install.sh SHA256SUMS | shasum -a 256 -c` on macOS and Linux, or
`(Get-FileHash install.ps1).Hash` on Windows). That shows the file was not damaged on the way, but
since the checksum comes from the same place as the script, only the attestation shows who made it.

The script-block form above is deliberate on Windows: it runs under the default script policy,
which blocks `.ps1` files, and nothing the installer defines is left behind in your session.

### Options

| macOS / Linux | Windows | |
|---|---|---|
| `--yes` | `-Yes` | Accept every default without asking |
| `--no-service` | `-NoService` | Do not start the app at login |
| `--no-shortcut` | `-NoShortcut` | Do not add a shortcut |
| `--port <n>` | `-Port <n>` | Listen on another port (default 3000) |
| `--data-dir <path>` | `-DataDir <path>` | Keep the data somewhere other than the default folder |
| `--prefix <dir>` | `-Prefix <dir>` | Install the package into another npm prefix |
| `--version <x.y.z>` | `-Version <x.y.z>` | Install another version than the one the script belongs to |
| `--uninstall` | `-Uninstall` | Remove the app (keeps your data) |
| `--purge` | `-Purge` | With uninstall: also delete the data folder |

Pass options after `sh -s --` on macOS and Linux, and after the script block on Windows:

```sh
curl -fsSL <url>/install.sh | sh -s -- --yes --no-shortcut
```

```powershell
& ([scriptblock]::Create((irm <url>/install.ps1))) -Yes -NoShortcut
```

On macOS and Linux, if npm's global folder is not writable by you (common with a Node.js from the
nodejs.org installer or a Linux package), the package goes under `~/.local` instead. Add
`~/.local/bin` to your `PATH` to run `tax-tracker` yourself.

## Where things are

| | macOS | Windows | Linux |
|---|---|---|---|
| Data (database, backups, `config.json`) | `~/Library/Application Support/tax-tracker` | `%APPDATA%\tax-tracker` | `~/.local/share/tax-tracker` (or `$XDG_DATA_HOME`) |
| Service | `~/Library/LaunchAgents/com.apilbeam101.tax-tracker.plist` | Scheduled task "UK Tax Tracker" | none |
| Log | `~/Library/Logs/tax-tracker/tax-tracker.log` | `%LOCALAPPDATA%\UkTaxTracker\tax-tracker.log` | your terminal |
| What the installer chose | `~/.config/uk-tax-tracker-installer/state` | `%LOCALAPPDATA%\UkTaxTracker\install-state.json` | `~/.config/uk-tax-tracker-installer/state` |

On Windows, a data folder the installer creates is restricted to your account. A folder you point
it at with `-DataDir` that already exists keeps its permissions.

If you chose your own data folder, pass `--data-dir` to `tax-tracker` commands you run yourself
(for example `tax-tracker backup --data-dir <folder>`); otherwise they use the default folder.

## Uninstall

Run the installer again with `--uninstall` (`-Uninstall` on Windows). It reads what the install
chose, then removes the service, the shortcut and the package. **Your data is kept**, and the
installer prints where it is.

To delete the data as well, add `--purge` (`-Purge`). It asks you to type a confirmation, and it
only ever deletes a folder that holds this app's database or config file. That deletes every
backup inside it too, so copy anything you want to keep first.

## Try it without installing

With Node.js 24 or later:

```sh
npx uk-tax-tracker@<version> start --open
```

This runs the app in your terminal until you press Ctrl+C. It uses the same data folder as an
installed copy, so you can install properly later and keep what you entered.

## Next

- [Getting started](GETTING_STARTED.md): first-run setup
- [Backups and restore](BACKUP_RESTORE.md)
- [Upgrading](UPGRADING.md): run the installer for the new version
- [Troubleshooting](TROUBLESHOOTING.md)

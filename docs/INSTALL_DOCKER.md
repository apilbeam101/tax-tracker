# Docker install

The image is published for `linux/amd64` and `linux/arm64` (Raspberry Pi 4/5, Apple-silicon and
most ARM NAS boxes) at `ghcr.io/apilbeam101/tax-tracker`, and mirrored to Docker Hub as
`apilbeam101/tax-tracker`. It runs as a fixed non-root user (uid 10001) on a read-only root
filesystem.

## Quick start

```sh
git clone https://github.com/apilbeam101/tax-tracker.git
cd tax-tracker/deploy/compose
cp .env.example .env          # optional: pin a version, change the port, set DOMAIN
docker compose up -d
```

Open `http://127.0.0.1:3000` and go through first-run setup. The port is bound to `127.0.0.1`
only, so the app is not reachable from other machines until you add HTTPS (below).

The Compose file runs the app in self-configured mode (`AUTO_CONFIG=true`): it generates its
session secret into `config.json` inside the data volume, takes a daily backup, and lets you enter
API keys under Settings. Data lives in the named volume `tax-tracker-data`, which Docker creates
owned by the image's user, so there is nothing to `chown`.

## HTTPS with the Caddy sidecar

To reach the app from other devices, point a DNS name at the host, open ports 80 and 443, set
`DOMAIN` in `.env`, and start the `https` profile:

```sh
docker compose --profile https up -d
```

Caddy gets a certificate from Let's Encrypt and renews it. With `DOMAIN` unset it serves
`localhost` with a locally trusted certificate instead. The app trusts the forwarded protocol from
private addresses (`TRUST_PROXY=uniquelocal`), so session cookies are marked `Secure` when the
request arrived over HTTPS.

## Image tags

| Tag | Changes when | Use it for |
|---|---|---|
| `0.1` (minor) | a patch release, and the monthly base-image rebuild | Most installs: security patches without surprises |
| `0` (major) | any release on that major version, and the monthly rebuild | Following new features automatically |
| `0.1.0` (exact) | never | Reproducing an exact build; it does not receive base-image patches |
| `latest` | every non-pre-release release, and the monthly rebuild | Trying it out |

For the strongest guarantee pin a digest (`ghcr.io/apilbeam101/tax-tracker@sha256:...`). Check what
you pulled with `gh attestation verify oci://ghcr.io/apilbeam101/tax-tracker:<tag> --repo apilbeam101/tax-tracker`.
Docker Hub is a convenience copy without the attestations; verify against GHCR.

## Unattended unlock

By default the data stays locked after every restart until someone signs in. On a server that must
come back by itself (after a power cut, an upgrade), you can give the app a key that unlocks it at
startup. The trade-off: anyone who can read both the key file and the data volume can read the
data. The steps are in the commented `secrets:` block of `docker-compose.yml`; you also have to opt
in when the data is encrypted (first-run setup or the in-app upgrade), or run
`docker compose run --rm tax-tracker keys add-unattended` afterwards. Keep the key file outside the
data volume; `tax-tracker doctor` fails if it is inside it.

## Using a host folder instead of a named volume

Replace the volume line with `./data:/app/data`, then before the first start:

```sh
mkdir -p data && sudo chown -R 10001:10001 data
```

Docker does not apply the image's ownership to an existing host folder, and without this the app
cannot open its database (`SQLITE_CANTOPEN`).

## Commands

The image's entrypoint is the `tax-tracker` command, with `start` as the default:

```sh
docker compose exec tax-tracker tax-tracker backup     # in the running container
docker compose run --rm tax-tracker info               # in a one-off container
docker compose run --rm tax-tracker doctor
```

Commands that must run with the app stopped (`restore`, `import`, `keys rotate`) refuse while it is
running; see [Backups and restore](BACKUP_RESTORE.md#docker).

## Building from source

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Without Compose

```sh
docker run -d --name tax-tracker --init --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -e AUTO_CONFIG=true -e HOST=0.0.0.0 -e RESTORE_RESTART=exit \
  -v tax-tracker-data:/app/data --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true \
  ghcr.io/apilbeam101/tax-tracker:0.1
```

`--init` matters: without an init process, `node` as PID 1 ignores the stop signal and is killed
after the timeout, possibly in the middle of a write.

## Next

- [Backups and restore](BACKUP_RESTORE.md)
- [Upgrading](UPGRADING.md#docker)
- [Configuration](CONFIGURATION.md)

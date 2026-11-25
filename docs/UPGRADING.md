# Upgrading

Upgrading keeps your data. When a new version changes the database, it takes a `pre-migration`
backup first and then updates the database at startup. Read the release notes (the GitHub Release,
or [CHANGELOG.md](../CHANGELOG.md)) before you upgrade.

**Running an older version on a database a newer one has updated is not supported**, and a backup
made by a newer version is refused by an older one. To undo an upgrade, install the older version
with the app stopped, restore the `pre-migration` backup the upgrade took, and then start it.

After an upgrade the app starts locked, as after any restart, unless it uses unattended unlock.
Sign in to unlock it.

## Desktop (installer)

Run the installer for the new version the same way you installed it, with the same options (or
the same answers to its questions). It replaces the package and restarts the app if it runs at
login. Your data and settings stay as they are.

## Docker

With a minor or major tag (`0.1`, `0`) in `docker-compose.yml`:

```sh
docker compose pull
docker compose up -d
```

To move to a new minor version, change the tag (or `TAX_TRACKER_VERSION` in `.env`) first. Old
images can be removed afterwards with `docker image prune`.

## Kubernetes

Change the image tag in `deploy/kubernetes/statefulset.yaml` (and in the backup CronJob if you use
it), then:

```sh
kubectl apply -k deploy/kubernetes
kubectl -n tax-tracker rollout status statefulset/tax-tracker
```

The old pod is removed before the new one starts, so there is a short gap.

## Standalone

```sh
sudo npm install -g uk-tax-tracker@<version>
sudo systemctl restart tax-tracker
```

If the deployment files in `deploy/` changed in the release notes, compare yours with the new ones.

## npx

`npx uk-tax-tracker@<version>` runs whichever version you name; there is nothing to upgrade.

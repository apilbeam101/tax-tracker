# Backups, restore and archives

There are two different things, kept separate:

| | Backup and restore | Archive (export and import) |
|---|---|---|
| Format | A SQLite snapshot (`.db`) | Versioned JSON (`.json`) |
| For | Getting back to an earlier state on the same or a newer version | Moving data between installs, or reading it yourself |
| Contains | Everything, including the key slots; encrypted fields stay encrypted | Instruments, transactions, scheduled vests, tax-year settings, exchange rates and prices |
| Protected by | The passphrase and recovery key that were valid when it was taken | An export passphrase you choose (or nothing, if you ask for plaintext) |
| Needs | Nothing to take one, even while the app is locked | The data unlocked (the app signed in, or your passphrase on the command line) |

Both are under **Import / Export > Backups & archive** in the app.

## Backups

```sh
tax-tracker backup        # writes <data dir>/backups/taxtracker-<timestamp>-manual.db
```

A backup is one consistent snapshot, taken while the app keeps running, and is checked before it
is listed. Backups are taken automatically too:

| Reason in the name | When | Kept |
|---|---|---|
| `manual` | you take one | the newest 14 |
| `scheduled` | daily, when `BACKUP_SCHEDULE=daily` (the default for installer, Compose and Kubernetes installs) | the newest 14 |
| `pre-migration` | before an upgrade changes the database | all |
| `pre-restore` | before a restore replaces the database | all |
| `pre-import` | before an import replaces existing data | all |
| `pre-rotation` | before `keys rotate` | all |

**Backups on the same disk are not enough.** They protect against mistakes, not against losing
the disk or volume. Copy them somewhere else regularly. A backup opens only with the passphrase
or recovery key that belongs to it, so it is reasonably safe to store off-site.

## Restore

A restore replaces the whole database with the backup. Anything entered after the backup was taken
is lost. The current database is backed up first (`pre-restore`).

A backup is checked before it is accepted: it must be a valid SQLite file that passes an integrity
check, come from this or an earlier version of the app, and have its key slots and account. The
app refuses:

- an unencrypted backup over an encrypted database;
- a backup that the configured unattended key cannot open, because the app would then refuse to
  start.

### From the app

Upload the file under **Backups & archive**. It is staged and swapped in the next time the app
starts, before the database is opened. Installs where something restarts the app when it stops
(the installer's service, Docker, Kubernetes, systemd) set `RESTORE_RESTART=exit`, so the app
restarts by itself. Otherwise restart it yourself.

### From the command line

The app must be stopped; `restore` refuses while it is running.

```sh
tax-tracker restore <file.db>
```

### Docker

Stop the app, run the restore in a one-off container on the same volume, start it again:

```sh
docker compose stop tax-tracker
docker compose run --rm tax-tracker restore /app/data/backups/<file>.db --yes
docker compose start tax-tracker
```

The file must be inside the data volume. To restore a file from the host, copy it in first while
the app is running: `docker compose cp <file>.db tax-tracker:/app/data/backups/`.

### Kubernetes

Uploading the file in the app is the simplest way: the pod restarts with the restored database.
From the command line, copy the file into the volume while the app runs, stop the app, and run the
restore in a pod that mounts the same claim:

```sh
kubectl -n tax-tracker cp <file>.db tax-tracker-0:/app/data/backups/<file>.db
kubectl -n tax-tracker scale statefulset/tax-tracker --replicas=0
kubectl -n tax-tracker run tax-tracker-restore --rm -it --restart=Never \
  --image=ghcr.io/apilbeam101/tax-tracker:0.1 --overrides='{
    "spec": {
      "securityContext": {"runAsNonRoot": true, "runAsUser": 10001, "runAsGroup": 10001, "fsGroup": 10001, "seccompProfile": {"type": "RuntimeDefault"}},
      "containers": [{
        "name": "restore", "image": "ghcr.io/apilbeam101/tax-tracker:0.1", "stdin": true, "tty": true,
        "args": ["restore", "/app/data/backups/<file>.db", "--yes"],
        "securityContext": {"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true, "capabilities": {"drop": ["ALL"]}},
        "volumeMounts": [{"name": "data", "mountPath": "/app/data"}, {"name": "tmp", "mountPath": "/tmp"}]
      }],
      "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": "data-tax-tracker-0"}}, {"name": "tmp", "emptyDir": {}}]
    }}'
kubectl -n tax-tracker scale statefulset/tax-tracker --replicas=1
```

### systemd

Stop the service, run the restore in the service's sandbox as shown in
[Standalone](INSTALL_STANDALONE.md#the-service), and start it again.

## Archives

```sh
tax-tracker export [--out file.json]   # asks for an export passphrase (12 characters or more)
tax-tracker export --plaintext         # unencrypted; asks you to confirm
tax-tracker import <file.json>         # into an empty database
tax-tracker import <file.json> --replace   # over existing data, after a backup
```

An archive is checked field by field before anything is written, and an import runs as one
transaction, so a bad file changes nothing. Importing never changes tax-year settings that already
exist. `export` and `import` ask for your passphrase (or your recovery key).

An archive taken with `--plaintext` is readable by anyone who has it. So are CSV and PDF exports
from the app. Keep those somewhere safe and delete them when you no longer need them.

## Unencrypted copies

Once your data is encrypted, the app looks for copies that are not (earlier backups in `backups/`,
`taxtracker.db.bak*` files and Ghostfolio export files in the data folder) and shows them with a
badge in the navigation bar.
You can delete them from **Backups & archive**. A file the app cannot open is never offered for
deletion, since it may be a damaged encrypted one.

## Key rotation

`tax-tracker keys rotate` replaces the key that encrypts your data and re-encrypts every record.
Stop the app first. It takes a `pre-rotation` backup, asks for your current passphrase, and gives
you a new recovery key; the old one stops working. Backups and archives made before a rotation
still open with the passphrase or recovery key they were made under, and restoring one brings the
old key back, so rotate again afterwards if retiring the old key was the point.

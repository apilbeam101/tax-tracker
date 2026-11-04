# Kubernetes install

The manifests in [`deploy/kubernetes/`](../deploy/kubernetes/) run one pod with one persistent
volume. **Never run more than one replica:** the database is a SQLite file and must have exactly
one writer. A StatefulSet is used because it deletes the old pod before starting the new one, so an
upgrade never has two pods on the database.

## Install

1. **Create the Secret.** Copy the template, put a real session secret in it, and apply the copy:

   ```sh
   cp deploy/kubernetes/secret.example.yaml secret.yaml
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into secret.yaml
   kubectl create namespace tax-tracker
   kubectl apply -f secret.yaml
   ```

   Do not commit `secret.yaml`. A Secret is only base64-encoded; for anything you keep in Git, use
   Sealed Secrets, External Secrets, SOPS or your cloud's secret store.

2. **Apply the rest:**

   ```sh
   kubectl apply -k deploy/kubernetes
   ```

   This creates the namespace (with the `restricted` Pod Security level enforced), ConfigMap,
   Service, StatefulSet and NetworkPolicy. The volume claim (`data-tax-tracker-0`, 1 GiB, the
   cluster's default storage class) is created by the StatefulSet and is kept if you delete it.

3. **Check it:**

   ```sh
   kubectl -n tax-tracker rollout status statefulset/tax-tracker
   kubectl -n tax-tracker port-forward svc/tax-tracker 3000:3000
   ```

   Open `http://127.0.0.1:3000` and go through first-run setup.

## Exposing it

Copy [`ingress.example.yaml`](../deploy/kubernetes/ingress.example.yaml), set your host and TLS
secret, and apply it. It raises ingress-nginx's request size limit to 512 MB: restoring a backup
from the app uploads the whole database file, and the default 1 MB limit fails that with a 413.
Other ingress controllers need the same change in their own form.

The ConfigMap sets `TRUST_PROXY=uniquelocal` so the app sees the original HTTPS protocol from the
ingress and marks cookies `Secure`. Narrow it to your ingress controller's pod range if you can.

## Network policy

The policy allows traffic in only from the `ingress-nginx` namespace and out only to DNS and to
port 443 (the exchange-rate, price and dividend providers). Change the namespace selector if your
ingress controller runs elsewhere, or the app will be unreachable with no error pointing at the
policy. A policy only works if your CNI enforces it (Calico and Cilium do; kind's default does not).

## Configuration

The app runs in env-supplied mode: settings come from the ConfigMap, secrets from files mounted
from the Secret (`SESSION_SECRET_FILE` and friends), and the app never writes configuration. To let
it manage its own session secret and take API keys under Settings instead, set `AUTO_CONFIG: "true"`
and drop the Secret. See [Configuration](CONFIGURATION.md).

Optional API keys and the unattended unlock key go into the Secret too, each with its `*_FILE` line
uncommented in the ConfigMap. A `*_FILE` that points at a file the Secret does not contain stops the
app from starting. Read [Security model](SECURITY_MODEL.md#unlock-modes) before adding the unlock
key.

## Backups

The ConfigMap turns on the daily backup into `backups/` on the same volume. That protects against
mistakes, not against losing the volume: copy backups off the cluster as well. To copy one out:

```sh
kubectl -n tax-tracker exec tax-tracker-0 -- tax-tracker backup
kubectl -n tax-tracker cp tax-tracker-0:/app/data/backups/<file>.db ./<file>.db
```

[`cronjob-backup.example.yaml`](../deploy/kubernetes/cronjob-backup.example.yaml) runs
`tax-tracker backup` as a CronJob instead, if you want failures to show up as failed Jobs. Restoring
on Kubernetes is described in [Backups and restore](BACKUP_RESTORE.md#kubernetes).

## Next

- [Upgrading](UPGRADING.md#kubernetes)
- [Troubleshooting](TROUBLESHOOTING.md)

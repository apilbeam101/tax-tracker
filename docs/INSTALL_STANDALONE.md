# Standalone install (Linux server with systemd)

This runs the app as a system service on a Linux server, behind a reverse proxy that provides
HTTPS. You need Node.js 24 or later installed system-wide (not under a home folder) and systemd 250
or later.

## Install

```sh
sudo npm install -g uk-tax-tracker@<version>
command -v tax-tracker        # usually /usr/local/bin/tax-tracker
```

## The service

[`deploy/systemd/tax-tracker.service`](../deploy/systemd/tax-tracker.service) is a hardened unit:

- systemd creates a private user for it and manages the data folder at `/var/lib/tax-tracker`,
  readable only by that user;
- the session secret is delivered with `LoadCredential=`, a private in-memory copy that only this
  service can read, instead of an environment file;
- most of the system is read-only or invisible to it (`ProtectSystem=strict`, `ProtectHome=yes` and
  the other settings in the file); check with `systemd-analyze security tax-tracker`.

```sh
sudo install -d -m 0700 /etc/tax-tracker
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | sudo tee /etc/tax-tracker/session-secret >/dev/null
sudo chmod 0400 /etc/tax-tracker/session-secret
sudo cp deploy/systemd/tax-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tax-tracker
systemctl status tax-tracker
```

If `command -v tax-tracker` showed another path, change `ExecStart` in the unit first. The unit
turns on the daily backup and `RESTORE_RESTART=exit`, so a restore uploaded from the app takes
effect when systemd restarts it.

Run `tax-tracker` commands against the service's data in the same sandbox, so the files keep the
right owner. Stop the service first for `restore`, `import` and `keys rotate`:

```sh
sudo systemd-run --pty --wait --collect \
  -p DynamicUser=yes -p StateDirectory=tax-tracker -p UMask=0077 \
  -p LoadCredential=session-secret:/etc/tax-tracker/session-secret \
  -E DATA_DIR=/var/lib/tax-tracker -E AUTO_CONFIG=false \
  /bin/sh -c 'SESSION_SECRET_FILE="$CREDENTIALS_DIRECTORY/session-secret" exec tax-tracker doctor'
```

Replace `doctor` with the command you need (`backup`, `info`, `restore <file> --yes`, ...). A
backup file you want to restore must be inside `/var/lib/tax-tracker` first, since the sandbox
cannot see anything else.

## Reverse proxy

The app listens on `127.0.0.1:3000`. Put a reverse proxy with TLS in front of it. The unit sets
`TRUST_PROXY=loopback`, so the app sees the original HTTPS protocol from a proxy on the same host
and marks session cookies `Secure`. If the proxy runs on another machine, set `TRUST_PROXY` to that
machine's address instead.

**Caddy** (gets and renews the certificate itself):

```
tax.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx** (certificate from Certbot: `certbot --nginx -d tax.example.com`):

```nginx
server {
    listen 443 ssl;
    server_name tax.example.com;

    ssl_certificate     /etc/letsencrypt/live/tax.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tax.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # Restoring a backup from the app uploads the whole database file (up to 500 MB);
    # nginx rejects anything over 1 MB by default.
    client_max_body_size 512m;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name tax.example.com;
    return 301 https://$host$request_uri;
}
```

## Unattended unlock

By default the data stays locked after every restart until someone signs in. To unlock at startup
instead, create `/etc/tax-tracker/encryption-key` the same way as the session secret, uncomment the
two `encryption-key` lines in the unit, and opt in when the data is encrypted (or run
`keys add-unattended` afterwards with the service stopped). Read
[Security model](SECURITY_MODEL.md#unlock-modes) first.

## Without systemd

`tax-tracker start` runs the app in the foreground. With `AUTO_CONFIG=true` (the default for the
command) it creates `config.json` with a generated session secret in the data folder. To keep every
setting in an environment file instead, copy [`.env.example`](../.env.example), fill it in and run
`tax-tracker start --env-file .env`. See [Configuration](CONFIGURATION.md).

## Next

- [Backups and restore](BACKUP_RESTORE.md)
- [Upgrading](UPGRADING.md#standalone)

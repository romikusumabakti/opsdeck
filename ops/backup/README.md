# Panel backup

A daily backup of the Panel on .113, with an off-host copy on Proxmox node
55.111.

| File | Installed as | Host |
| --- | --- | --- |
| `dss-panel-backup.sh` | `/usr/local/sbin/dss-panel-backup.sh` | .113 |
| `dss-panel-backup.service` | `/etc/systemd/system/dss-panel-backup.service` | .113 |
| `dss-panel-backup.timer` | `/etc/systemd/system/dss-panel-backup.timer` | .113 |
| `prune-received.sh` | `/usr/local/sbin/dss-panel-prune-received.sh` | 55.111 |

## What runs

The timer starts the service every day at 02:30 Asia/Jakarta. With
`Persistent=true`, a run missed while the host was down happens at the next
boot. The script runs as root and does this:

1. Creates `/var/backups/dss-panel/<YYYY-MM-DD>/` (the date in Asia/Jakarta) with mode 0700. Every file
   in it is 0600.
2. Dumps from container `opsdeck-postgres`:
   - `dss_panel.dump` (from `opsdeck-postgres`) and `sonarqube_db.dump` (from `shared-postgres` since 2026-11-09, via `EXTRA_DUMPS`) with `pg_dump -Fc`.
   - `globals.sql` with `pg_dumpall --globals-only`, which holds roles and
     tablespaces.

   Each file is written as `*.partial` and renamed only when its dump
   succeeds.
3. Mirrors the Garage bucket into `garage/`. It runs
   `rclone/rclone:1 sync garage:${S3_BUCKET:-knowledge}` on the
   `dss-panel_default` network, into `garage.partial/`, and renames that to
   `garage/` only when the sync succeeds. The S3 settings are read from the `S3_*` lines of
   `/deployments/dss-panel/.env` and passed to the container as
   `RCLONE_CONFIG_GARAGE_*` environment variables, never as arguments.
4. Writes `SHA256SUMS` for every file in the day directory.
5. Pushes the day directory with rsync to
   `root@192.168.55.111:/var/backups/dss-panel-113/<date>/`. The key
   `/root/.ssh/dss-panel-backup` is restricted to `rrsync`, so the
   destination is given relative to that directory.
6. Deletes local day directories dated more than 14 days ago.
7. Logs one line to the journal, for example:
   `dss-panel-backup: 2026-11-05 dss_panel=… sonarqube_db=… globals=… garage=… total=… remote=ok`
   (sizes in bytes).

If a dump or the checksums fail, the script exits non-zero before the push.
If the Garage mirror fails, the day has no `garage/` directory, but the dumps
are still checksummed and pushed, the summary shows `garage=failed`, and the
script exits non-zero at the end. If the push fails, the local copy stays,
retention still runs, and the script exits non-zero. In every case the unit
shows in `systemctl --failed`. `RETENTION_DAYS` must be a positive integer.

Every setting can be overridden through the environment: `BACKUP_DIR`,
`PG_CONTAINER`, `DATABASES`, `COMPOSE_NETWORK`, `ENV_FILE`, `REMOTE`, `SSH_KEY`
and `RETENTION_DAYS`. Use a drop-in (`systemctl edit dss-panel-backup`) to
change one.

## Install

### On 55.111 (receiver)

```sh
install -d -m 0700 /var/backups/dss-panel-113
install -m 0755 prune-received.sh /usr/local/sbin/dss-panel-prune-received.sh
# Daily prune of copies dated more than 30 days ago:
echo '15 4 * * * root /usr/local/sbin/dss-panel-prune-received.sh' \
  > /etc/cron.d/dss-panel-prune-received
```

### On .113 (sender)

1. Create the key, with no passphrase, used only for this backup:

   ```sh
   ssh-keygen -t ed25519 -N '' -C dss-panel-backup@113 -f /root/.ssh/dss-panel-backup
   ```

2. On 55.111, append the public key to `/root/.ssh/authorized_keys`,
   restricted to writing into the backup directory (`-wo` allows no reads,
   `-no-del` allows no deletions):

   ```text
   restrict,command="rrsync -wo -no-del /var/backups/dss-panel-113" ssh-ed25519 AAAA… dss-panel-backup@113
   ```

3. Record 55.111's host key, so that `BatchMode=yes` does not refuse it:

   ```sh
   ssh-keyscan -t ed25519 192.168.55.111 >> /root/.ssh/known_hosts
   ```

   Compare the fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
   on 55.111.
4. Install the script and units, then enable the timer:

   ```sh
   install -m 0700 dss-panel-backup.sh /usr/local/sbin/dss-panel-backup.sh
   install -m 0644 dss-panel-backup.service dss-panel-backup.timer /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now dss-panel-backup.timer
   ```

5. Do one run by hand and check it:

   ```sh
   systemctl start dss-panel-backup.service
   journalctl -u dss-panel-backup.service -n 20
   systemctl list-timers dss-panel-backup.timer
   ```

6. Check that the key cannot do anything else. Each of these must be refused:

   ```sh
   ssh -i /root/.ssh/dss-panel-backup root@192.168.55.111 id
   rsync -e 'ssh -i /root/.ssh/dss-panel-backup' root@192.168.55.111:/etc/hostname /tmp/
   rsync -e 'ssh -i /root/.ssh/dss-panel-backup' root@192.168.55.111:../ /tmp/x/
   # reading back from the backup directory itself (write-only key):
   rsync -e 'ssh -i /root/.ssh/dss-panel-backup' root@192.168.55.111: /tmp/x/
   # deleting remote files (no-del):
   mkdir /tmp/empty && rsync -r --delete -e 'ssh -i /root/.ssh/dss-panel-backup' /tmp/empty/ root@192.168.55.111:
   ```
7. Keep an off-host copy of `SECRETS_KEY` (see Restore). Run on the laptop:

   ```sh
   install -d -m 0700 ~/.config/secrets/dss
   ssh root@<.113> 'grep ^SECRETS_KEY= /deployments/dss-panel/.env' | cut -d= -f2- \
     > ~/.config/secrets/dss/dss-panel-secrets-key
   chmod 600 ~/.config/secrets/dss/dss-panel-secrets-key
   ```

   Never store it beside the dumps or on 55.111.

## Restore

First check the copy. Use the directory on .113, or the one on 55.111 under
`/var/backups/dss-panel-113/`:

```sh
cd /var/backups/dss-panel/2026-11-05
sha256sum -c --quiet SHA256SUMS
```

### SECRETS_KEY (required for `dss_panel`)

Restoring `dss_panel` is only useful with the same `SECRETS_KEY` that
encrypted it: the secret columns hold `enc:v1` values that cannot be read
without it. The key lives only in `/deployments/dss-panel/.env` on .113 and is
NOT in the backup. Romi's off-host copy is
`~/.config/secrets/dss/dss-panel-secrets-key` (0600) on the laptop. Before a
restore on a rebuilt host, put its value back as `SECRETS_KEY` in the new
`/deployments/dss-panel/.env`. Do not print it or keep it with the dumps.

### Postgres: check a dump in a scratch container

Use the same Postgres major version as `opsdeck-postgres` (currently 18). The
scratch container has no network and is removed afterwards:

```sh
docker run -d --name pg-restore-check --network none \
  -e POSTGRES_PASSWORD=scratch postgres:18
sleep 5
docker exec -i pg-restore-check psql -U postgres -q < globals.sql
docker exec pg-restore-check createdb -U postgres dss_panel
docker exec -i pg-restore-check pg_restore -U postgres -d dss_panel --exit-on-error < dss_panel.dump
docker exec pg-restore-check psql -U postgres -d dss_panel -c '\dt'
docker rm -f pg-restore-check
```

`globals.sql` fails on `CREATE ROLE postgres` because the role already exists.
That error is expected.

### Postgres: restore into the Panel

1. Stop the services that write to the database. For `dss_panel`, that is
   the app and the terminal containers.
2. Take a fresh dump of the current state first, in case the restore has to
   be undone.
3. Restore:

   ```sh
   docker exec -i opsdeck-postgres pg_restore -U postgres -d dss_panel \
     --clean --if-exists --exit-on-error < dss_panel.dump
   ```

4. Start the services again.

Restore `sonarqube_db` the same way, with SonarQube stopped, into `shared-postgres` (`docker exec -i shared-postgres pg_restore -U postgres -d sonarqube_db --no-owner --role=sonarqube`).

### Garage: copy the bucket back

`copy` adds and overwrites objects but deletes nothing. Use `sync` only to
make the bucket match the backup exactly. Run it from the day directory. The
keys are `S3_ACCESS_KEY` and `S3_SECRET_KEY` in `/deployments/dss-panel/.env`;
type them at the prompts so they never appear on a command line or in the
shell history. If the .env sets an `S3_BUCKET` other than `knowledge`, set
`S3_BUCKET` in the shell first.

```sh
export RCLONE_CONFIG_GARAGE_TYPE=s3 RCLONE_CONFIG_GARAGE_PROVIDER=Other \
  RCLONE_CONFIG_GARAGE_ENDPOINT=http://garage:3900 RCLONE_CONFIG_GARAGE_REGION=garage
read -rs -p 'S3 access key: ' RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID; echo
read -rs -p 'S3 secret key: ' RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY; echo
export RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY
docker run --rm --network dss-panel_default \
  -e RCLONE_CONFIG_GARAGE_TYPE -e RCLONE_CONFIG_GARAGE_PROVIDER \
  -e RCLONE_CONFIG_GARAGE_ENDPOINT -e RCLONE_CONFIG_GARAGE_REGION \
  -e RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID -e RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY \
  -v "$PWD/garage:/data/garage:ro" \
  rclone/rclone:1 copy /data/garage "garage:${S3_BUCKET:-knowledge}"
```

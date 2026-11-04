#!/bin/bash
# Daily backup of the Panel on .113: pg_dump of the Panel databases, Postgres
# globals and a mirror of the Garage bucket into $BACKUP_DIR/<YYYY-MM-DD>/,
# then an off-host copy to 55.111 over a restricted (rrsync) SSH key.
# Installed as /usr/local/sbin/dss-panel-backup.sh, run by
# dss-panel-backup.timer as root. See ops/backup/README.md.
set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-/var/backups/dss-panel}
PG_CONTAINER=${PG_CONTAINER:-opsdeck-postgres}
DATABASES=${DATABASES:-"dss_panel sonarqube_db"}
COMPOSE_NETWORK=${COMPOSE_NETWORK:-dss-panel_default}
ENV_FILE=${ENV_FILE:-/deployments/dss-panel/.env}
# rrsync on the receiver roots paths at /var/backups/dss-panel-113, so the
# destination is relative: root@192.168.20.111:<date>/
REMOTE=${REMOTE:-root@192.168.20.111:}
SSH_KEY=${SSH_KEY:-/root/.ssh/dss-panel-backup}
RETENTION_DAYS=${RETENTION_DAYS:-14}

# S3 settings come only from $ENV_FILE. Drop inherited (possibly exported)
# values so neither they nor the parsed ones reach the environment of
# docker exec, rsync or ssh.
unset S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY

log() { printf 'dss-panel-backup: %s\n' "$*"; }
warn() { printf 'dss-panel-backup: %s\n' "$*" >&2; }
fail() { warn "$@"; exit 1; }

[[ $RETENTION_DAYS =~ ^[1-9][0-9]*$ ]] ||
  fail "RETENTION_DAYS must be a positive integer"

umask 077
# Day names follow Jakarta time whatever the host timezone is.
day=$(TZ=Asia/Jakarta date +%F)
day_dir="$BACKUP_DIR/$day"

# A failed step must never leave a file or directory under its final name.
cleanup_partials() {
  if [[ -d $day_dir ]]; then
    rm -rf -- "$day_dir/garage.partial"
    find "$day_dir" -maxdepth 1 -name '*.partial' -delete
  fi
  return 0
}
trap cleanup_partials EXIT

# dump_to <final path> <command...>: write stdout to <final>.partial, then rename.
dump_to() {
  local final=$1
  shift
  "$@" >"$final.partial" || fail "failed: $* (${final##*/})"
  mv -f "$final.partial" "$final"
}

# Reads only the S3_* keys from the compose .env (never sourced: it may hold
# values that are not valid shell). Strips one pair of surrounding quotes.
read_s3_settings() {
  [[ -r $ENV_FILE ]] || { warn "cannot read $ENV_FILE"; return 1; }
  local line key value
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^(S3_ENDPOINT|S3_REGION|S3_BUCKET|S3_ACCESS_KEY|S3_SECRET_KEY)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    value=${value%$'\r'}
    if [[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]]; then
      value=${BASH_REMATCH[1]}
    fi
    printf -v "$key" '%s' "$value"
  done <"$ENV_FILE"
  # Same defaults as compose.yaml.
  S3_ENDPOINT=${S3_ENDPOINT:-http://garage:3900}
  S3_REGION=${S3_REGION:-garage}
  S3_BUCKET=${S3_BUCKET:-knowledge}
  local missing
  for missing in S3_ACCESS_KEY S3_SECRET_KEY; do
    [[ -n ${!missing:-} ]] || { warn "$missing missing in $ENV_FILE"; return 1; }
  done
}

# rclone reads the remote `garage:` from RCLONE_CONFIG_GARAGE_* env vars;
# `docker run -e NAME` copies them from this subshell's environment so the
# values never appear on any command line. The mirror goes to garage.partial/
# and becomes garage/ only on success. Returns non-zero on failure, leaving no
# garage/ directory for that day.
mirror_garage() {
  local garage=$day_dir/garage partial=$day_dir/garage.partial status=0
  rm -rf -- "$partial"
  # A re-run on the same day syncs on top of the earlier mirror.
  # Runs inside `if`, so set -e is off here: every step checks its own status.
  if [[ -d $garage ]]; then
    mv -- "$garage" "$partial" || return 1
  else
    mkdir -- "$partial" || return 1
  fi
  if read_s3_settings; then
    (
      export RCLONE_CONFIG_GARAGE_TYPE=s3
      export RCLONE_CONFIG_GARAGE_PROVIDER=Other
      export RCLONE_CONFIG_GARAGE_ENDPOINT=$S3_ENDPOINT
      export RCLONE_CONFIG_GARAGE_REGION=$S3_REGION
      export RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID=$S3_ACCESS_KEY
      export RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY=$S3_SECRET_KEY
      docker run --rm --network "$COMPOSE_NETWORK" \
        -e RCLONE_CONFIG_GARAGE_TYPE \
        -e RCLONE_CONFIG_GARAGE_PROVIDER \
        -e RCLONE_CONFIG_GARAGE_ENDPOINT \
        -e RCLONE_CONFIG_GARAGE_REGION \
        -e RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID \
        -e RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY \
        -v "$partial:/data/garage" \
        rclone/rclone:1 sync "garage:$S3_BUCKET" /data/garage
    ) || status=$?
  else
    status=1
  fi
  # rclone writes with the container's umask; keep the tree owner-only.
  chmod -R u=rwX,go= "$partial" || status=1
  if ((status == 0)); then
    mv -- "$partial" "$garage" || status=1
  fi
  if ((status != 0)); then
    rm -rf -- "$partial"
    warn "garage mirror failed (exit $status)"
  fi
  return "$status"
}

write_checksums() {
  # `|| fail` turns errexit off inside the subshell, so every step checks its
  # own status: a failed sha256sum must never become SHA256SUMS.
  (
    cd "$day_dir" &&
      find . -type f ! -name SHA256SUMS ! -name '*.partial' -print0 |
      sort -z | xargs -0 -r sha256sum >SHA256SUMS.partial &&
      mv -f SHA256SUMS.partial SHA256SUMS
  ) || fail "checksums failed"
}

# Removes $1/<YYYY-MM-DD> directories dated more than $2 days before today.
prune_older_than() {
  local root=$1 days=$2 cutoff dir name
  cutoff=$(TZ=Asia/Jakarta date -d "-$days days" +%F)
  for dir in "$root"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do
    [[ -d $dir && ! -L $dir ]] || continue
    name=${dir##*/}
    [[ $name < $cutoff ]] && rm -rf -- "$dir"
  done
  return 0
}

size_of() { du -sb -- "$1" | cut -f1; }

# 1. Day directory.
mkdir -p "$day_dir"
chmod 0700 "$BACKUP_DIR" "$day_dir"

# 2. Postgres: one custom-format dump per database, plus roles/tablespaces.
summary=()
for db in $DATABASES; do
  dump_to "$day_dir/$db.dump" docker exec "$PG_CONTAINER" pg_dump -U postgres -Fc "$db"
  summary+=("$db=$(size_of "$day_dir/$db.dump")")
done
dump_to "$day_dir/globals.sql" docker exec "$PG_CONTAINER" pg_dumpall -U postgres --globals-only
summary+=("globals=$(size_of "$day_dir/globals.sql")")

# 3. Garage bucket mirror. A failure here does not stop the dumps from being
# pushed off-host; it still fails the run at the end.
garage=ok
if mirror_garage; then
  summary+=("garage=$(size_of "$day_dir/garage")")
else
  garage=failed
  summary+=("garage=failed")
fi

# 4. Checksums.
write_checksums
summary+=("total=$(size_of "$day_dir")")

# 5. Off-host copy, only now that the database dumps succeeded.
remote=ok
if ! rsync -a --partial \
  -e "ssh -i $SSH_KEY -o BatchMode=yes -o ConnectTimeout=30" \
  "$day_dir/" "$REMOTE$day/"; then
  remote=failed
fi

# 6. Local retention (also when the remote copy failed).
prune_older_than "$BACKUP_DIR" "$RETENTION_DAYS"

# 7. Summary.
log "$day ${summary[*]} remote=$remote"
[[ $remote == ok && $garage == ok ]] || exit 1

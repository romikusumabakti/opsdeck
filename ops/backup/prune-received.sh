#!/bin/bash
# Receiver-side retention on Proxmox node 55.111: deletes the
# /var/backups/dss-panel-113/<YYYY-MM-DD> copies pushed by .113 that are dated
# more than 30 days ago. Installed as /usr/local/sbin/dss-panel-prune-received.sh
# and run daily by root's crontab. See ops/backup/README.md.
set -euo pipefail

RECEIVED_DIR=${RECEIVED_DIR:-/var/backups/dss-panel-113}
RETENTION_DAYS=${RETENTION_DAYS:-30}

if [[ ! $RETENTION_DAYS =~ ^[1-9][0-9]*$ ]]; then
  echo 'dss-panel-prune-received: RETENTION_DAYS must be a positive integer' >&2
  exit 1
fi

# Day names on .113 follow Jakarta time.
cutoff=$(TZ=Asia/Jakarta date -d "-$RETENTION_DAYS days" +%F)
removed=0
for dir in "$RECEIVED_DIR"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do
  [[ -d $dir && ! -L $dir ]] || continue
  name=${dir##*/}
  if [[ $name < $cutoff ]]; then
    rm -rf -- "$dir"
    removed=$((removed + 1))
  fi
done
printf 'dss-panel-prune-received: removed=%d cutoff=%s\n' "$removed" "$cutoff"

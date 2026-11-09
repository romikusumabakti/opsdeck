#!/bin/sh
# opsdeck host updater. Runs as root from opsdeck-updater@<instance>.service
# when the app writes <dir>/updates/request.json, and applies that update or
# restore with docker compose in <dir>.
#
#   usage: update.sh <install dir>
#
# Trust boundary: <dir>/updates is writable by the app (gid 1001), so the
# request is untrusted. It is read once, accepted only as the exact canonical
# single line lib/updates/request.ts writes (no JSON parser on the host), and
# only validated values are ever used or logged. Everything this script
# creates there is root-owned in a sticky dir, so the app cannot swap it.
# Nothing from .env except versions is logged, and there is no `set -x`.
#
# Progress goes to <dir>/updates/status.json (written atomically, 0640
# root:1001, the app only reads it) and <dir>/updates/logs/<runId>.log.
# Exit status: 0 when nothing was requested, another run holds the lock, or
# the run succeeded; 1 otherwise (the status file has the code).
set -eu

APP_GID=1001
RELEASE_BASE=https://github.com/romikusumabakti/opsdeck/releases/download
WAIT_TIMEOUT=180
HEALTH_ATTEMPTS=20
HEALTH_INTERVAL=3
LOG_TAIL_LINES=20

VERSION_RE='[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?'
IMAGE_RE='[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}'
# No interval over 255 (RE_DUP_MAX on musl); the length is checked apart.
OBJECT_KEY_RE='(local:)?[A-Za-z0-9_][A-Za-z0-9._/-]*'
REQUESTED_RE='"requestedBy":"[A-Za-z0-9_-]{1,64}","requestedAt":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z"'
# .env key -> release.json images key. OPSDECK_VERSION is pinned with them.
IMAGE_KEYS='OPSDECK_IMAGE:app POSTGRES_IMAGE:postgres VALKEY_IMAGE:valkey GARAGE_IMAGE:garage IMGPROXY_IMAGE:imgproxy CADDY_IMAGE:caddy'
NL='
'
ESC=$(printf '\033')
BEL=$(printf '\007')

die() {
  printf 'update.sh: %s\n' "$1" >&2
  exit 1
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# The whole value is one line matching the ERE.
matches() {
  case $1 in *"$NL"*) return 1 ;; esac
  printf '%s\n' "$1" | grep -Eqx -- "$2"
}

# Group ownership for the app only applies when running as root (the tests
# run unprivileged).
own() {
  if [ "$euid" -eq 0 ]; then chown "0:$APP_GID" "$@"; fi
}

# A real (not symlinked) file or dir of the given type owned by us.
owned() { # <-type letter> <path>
  [ ! -L "$2" ] && [ -n "$(find "$2" -prune -type "$1" -user "$euid" 2>/dev/null)" ]
}

log() {
  printf '%s %s\n' "$(now)" "$1" >>"$log_file"
  printf '%s\n' "$1" >&2
}

# Runs a command with its output in the log (and in $work/out).
run_logged() {
  log "+ $*"
  rc=0
  "$@" >"$work/out" 2>&1 || rc=$?
  cat "$work/out" >>"$log_file"
  if [ "$rc" -ne 0 ]; then log "exit status $rc"; fi
  return "$rc"
}

json_or_null() {
  if [ -n "$1" ]; then printf '"%s"' "$1"; else printf 'null'; fi
}

# The last log lines as a JSON array: ANSI escape sequences (CSI, OSC, then
# any other ESC pair) and control characters dropped, each line cut to 300
# bytes without leaving a partial UTF-8 sequence, quotes and backslashes
# escaped.
log_tail_json() {
  tail -n "$LOG_TAIL_LINES" "$log_file" |
    LC_ALL=C sed -e "s|$ESC\\[[0-?]*[ -/]*[@-~]||g" \
      -e "s|$ESC][^$BEL]*$BEL||g" -e "s|$ESC][^$ESC]*$ESC\\\\||g" -e "s|$ESC.||g" |
    LC_ALL=C tr '\011' ' ' |
    LC_ALL=C tr -d '\000-\010\013-\037\177' |
    LC_ALL=C awk '{ if (length($0) > 300) { $0 = substr($0, 1, 300); sub(/[\300-\367][\200-\277]*$/, "") } print }' |
    LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' |
    awk 'BEGIN { printf "[" } { printf "%s\"%s\"", (NR > 1 ? "," : ""), $0 } END { printf "]" }'
}

# Every value here is either a constant or validated, so none needs escaping.
write_status() { # <state> [code]
  tmp=$(mktemp "$updates/.status.XXXXXX")
  {
    printf '{"runId":"%s","action":%s,"version":%s,"from":%s,' \
      "$run_id" "$(json_or_null "$action")" "$(json_or_null "$version")" "$(json_or_null "$from")"
    printf '"step":"%s","state":"%s","code":%s,"startedAt":"%s","finishedAt":%s,' \
      "$step" "$1" "$(json_or_null "${2:-}")" "$started_at" "$(json_or_null "$finished_at")"
    if [ -n "$safety_location" ]; then
      printf '"safetyBackup":{"id":%s,"location":"%s","objectKey":"%s"},' \
        "$(json_or_null "$safety_id")" "$safety_location" "$safety_key"
    fi
    printf '"logTail":%s}\n' "$(log_tail_json)"
  } >"$tmp"
  chmod 0640 "$tmp"
  own "$tmp"
  mv -f "$tmp" "$updates/status.json"
}

set_step() {
  step=$1
  log "step: $1"
  write_status running
}

# The final status, without exiting (the EXIT trap uses it too).
record_final() { # <state> [code]
  final=1
  finished_at=$(now)
  log "result: $1${2:+ ($2)}"
  write_status "$1" "${2:-}"
}

finish() { # <state> [code]: the final status, then exit
  record_final "$@"
  if [ "$1" = succeeded ]; then exit 0; fi
  exit 1
}

refuse() { finish refused "$1"; }

# An unexpected exit or a signal (TERM from systemd's stop or timeout, INT,
# HUP) in the middle of a run still recovers, with signals ignored meanwhile:
# - after `opsdeck restore` ran: start the restore version again, restoreFailed;
# - after the previous lines were recorded: put them back (rolled_back);
# - before: nothing changed, failed.
# Then a request written during the run is picked up by a fresh run.
# shellcheck disable=SC2329 # invoked by the EXIT trap
on_exit() {
  status=$?
  set +e
  if [ "$running" = 1 ] && [ "$final" = 0 ]; then
    trap '' TERM INT HUP
    code=updaterError
    if [ -n "$caught" ]; then code=interrupted; fi
    log "unexpected exit in step $step (status $status${caught:+, SIG$caught})"
    if [ "$restore_invoked" = 1 ]; then
      compose_up
      record_final failed restoreFailed
    elif [ "$pinned" = 1 ] && [ "$step" != rollback ]; then
      if restore_previous; then
        record_final rolled_back "$code"
      else
        record_final failed rollbackFailed
      fi
    elif [ "$pinned" = 1 ]; then
      record_final failed rollbackFailed
    else
      record_final failed "$code"
    fi
  fi
  if [ -n "$work" ]; then rm -rf "$work"; fi
  if [ "$running" = 1 ] && [ -z "$caught" ] &&
    { [ -e "$request" ] || [ -L "$request" ]; }; then
    exec 9<&-
    exec sh "$0" "$dir"
  fi
}

# --- .env ------------------------------------------------------------------

env_line() { grep -E "^$1=" "$env_file" | tail -n 1; }

env_value() {
  v=$(env_line "$1")
  v=${v#*=}
  case $v in
    \"*\") v=${v#\"}; v=${v%\"} ;;
    \'*\') v=${v#\'}; v=${v%\'} ;;
  esac
  printf '%s' "$v"
}

# Replaces the KEY= lines of .env with the lines in <file>; every other line
# is kept as is. Written next to .env and renamed, so .env is never partial.
apply_env_lines() { # <file of KEY=... lines>
  tmp=$(mktemp "$dir/.env.XXXXXX")
  awk -F= 'NR == FNR { line[$1] = $0; next }
    ($1 in line) { if (!seen[$1]++) print line[$1]; next }
    { print }
    END { for (k in line) if (!seen[k]) print line[k] }' "$1" "$env_file" >"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$env_file"
}

# The current version and image lines, exactly as they are in .env.
record_previous() {
  tmp=$(mktemp "$updates/.previous.XXXXXX")
  {
    env_line OPSDECK_VERSION
    for pair in $IMAGE_KEYS; do env_line "${pair%%:*}"; done
  } >"$tmp"
  mv -f "$tmp" "$updates/previous.env"
  pinned=1
}

# --- versions and releases ---------------------------------------------------

# Prints -1, 0 or 1. Semver order; a beta sorts before its stable release.
# Numbers compare as digit strings, so no size overflows.
version_cmp() {
  awk -v a="$1" -v b="$2" '
    function num(x, y) {
      x = "" x; y = "" y; sub(/^0+/, "", x); sub(/^0+/, "", y)
      if (length(x) != length(y)) return length(x) < length(y) ? -1 : 1
      return x < y ? -1 : (x > y ? 1 : 0)
    }
    BEGIN {
      n = split(a, p, /[.-]/); m = split(b, q, /[.-]/)
      for (i = 1; i <= 3; i++) if ((c = num(p[i], q[i])) != 0) { print c; exit }
      if (n == m) print (n == 3 ? 0 : num(p[5], q[5]))
      else print (n == 3 ? 1 : -1)
    }'
}

older() { [ "$(version_cmp "$1" "$2")" -lt 0 ]; }

# The string value of a key that occurs exactly once in a one-line JSON file
# without backslashes (so every quote delimits a string).
json_str() { # <key> <file>
  awk -v k="\"$1\":\"" '
    { s = $0; while ((i = index(s, k)) > 0) { n++; s = substr(s, i + length(k)); if (n == 1) v = s } }
    END { j = index(v, "\""); if (n != 1 || j == 0) exit 1; print substr(v, 1, j - 1) }' "$2"
}

one_line_json() { # <file> <max bytes>
  [ "$(wc -c <"$1" | tr -d ' ')" -le "$2" ] &&
    [ "$(wc -l <"$1" | tr -d ' ')" -le 1 ] &&
    ! grep -qF "\\" "$1"
}

# Validates release.json for <version> and writes its pinned .env lines.
check_release() { # <file> <version> <pin file>
  one_line_json "$1" 16384 || return 1
  [ "$(json_str version "$1")" = "$2" ] || return 1
  release_min_from=$(json_str minFrom "$1") || return 1
  matches "$release_min_from" "$VERSION_RE" || return 1
  printf 'OPSDECK_VERSION=%s\n' "$2" >"$3"
  for pair in $IMAGE_KEYS; do
    img=$(json_str "${pair#*:}" "$1") || return 1
    matches "$img" "$IMAGE_RE" || return 1
    printf '%s=%s\n' "${pair%%:*}" "$img" >>"$3"
  done
}

# 0: valid, pin file written, release_min_from set; 1: download failed;
# 2: not published (HTTP 404); 3: invalid release.json.
load_release() { # <version> <pin file>
  file=$work/release-$1.json
  log "release v$1: downloading release.json"
  http=$(curl -sS -L --proto '=https' --proto-redir '=https' --max-time 60 \
    -o "$file" -w '%{http_code}' "$RELEASE_BASE/v$1/release.json" 2>>"$log_file") || http=000
  case $http in
    200) ;;
    404) log "release v$1: not published"; return 2 ;;
    *) log "release v$1: download failed (HTTP $http)"; return 1 ;;
  esac
  if ! check_release "$file" "$1" "$2"; then
    log "release v$1: release.json is invalid"
    return 3
  fi
}

# Loads a release or ends the run: <code when not published>.
need_release() { # <version> <pin file> <not published code>
  rc=0
  load_release "$1" "$2" || rc=$?
  case $rc in
    0) ;;
    1) finish failed releaseUnavailable ;;
    2) refuse "$3" ;;
    *) refuse invalidRelease ;;
  esac
}

# --- steps -------------------------------------------------------------------

healthy() { # <expected version>
  i=0
  while [ "$i" -lt "$HEALTH_ATTEMPTS" ]; do
    i=$((i + 1))
    http=$(curl -sS --max-time 10 -H "Host: $host" -o "$work/health" -w '%{http_code}' \
      "http://127.0.0.1:$http_port/api/health" 2>>"$log_file") || http=000
    if [ "$http" = 200 ] && one_line_json "$work/health" 4096 &&
      grep -qF '"ok":true' "$work/health" &&
      [ "$(json_str version "$work/health")" = "$1" ]; then
      log "health: ok, version $1"
      return 0
    fi
    if [ "$i" -lt "$HEALTH_ATTEMPTS" ]; then sleep "$HEALTH_INTERVAL"; fi
  done
  log "health: no healthy response with version $1 (last HTTP $http)"
  return 1
}

compose_up() { run_logged docker compose up -d --wait --wait-timeout "$WAIT_TIMEOUT"; }

# Puts previous.env back and starts it; 0 when that version is healthy.
restore_previous() {
  log "putting the previous images back"
  step=rollback
  write_status running
  apply_env_lines "$updates/previous.env" && compose_up &&
    healthy "$(env_value OPSDECK_VERSION)"
}

# Ends the run after a failed step: rolled_back, or rollbackFailed.
rollback() { # <failed step>
  log "$1 failed"
  if restore_previous; then finish rolled_back "${1}Failed"; fi
  finish failed rollbackFailed
}

# After `opsdeck restore` ran, the data is no longer the previous version's,
# so nothing is rolled back: the restore version is started again and the run
# fails with restoreFailed (the safety backup in the status undoes it).
restore_failed() { # <failed step>
  log "$1 failed after the restore started; starting version $version again"
  compose_up || log "the panel did not come back up"
  finish failed restoreFailed
}

# Steps 5-10: record, pin, pull, migrate, up, health; rollback on failure.
pin_and_start() { # <version> <pin file>
  record_previous
  set_step pull
  apply_env_lines "$2"
  run_logged docker compose pull || rollback pull
  set_step migrate
  run_logged docker compose run --rm migrate || rollback migrate
  set_step up
  compose_up || rollback up
  set_step health
  healthy "$1" || rollback health
}

backup() { # <trigger>
  set_step backup
  if ! run_logged docker compose run --rm app opsdeck backup run --trigger "$1"; then
    code=$(sed -n 's/.*"errorCode":"\([A-Za-z0-9_]*\)".*/\1/p' "$work/out" | tail -n 1)
    if [ -n "$code" ]; then log "backup error code: $code"; fi
    finish failed backupFailed
  fi
}

# The pre-restore backup, so the UI can offer to undo the restore. The CLI's
# result line is checked like any other untrusted JSON.
remember_safety_backup() {
  grep -E '^\{"id":' "$work/out" | tail -n 1 >"$work/backup.json"
  one_line_json "$work/backup.json" 4096 || return 0
  id=$(json_str id "$work/backup.json") || id=
  location=$(json_str location "$work/backup.json") || return 0
  key=$(json_str objectKey "$work/backup.json") || return 0
  case $key in *..*) return 0 ;; esac
  [ "${#key}" -le 511 ] || return 0
  matches "$key" "$OBJECT_KEY_RE" || return 0
  matches "$location" '(local|s3)' || return 0
  matches "$id" '[A-Za-z0-9_-]{1,64}' || id=
  safety_id=$id
  safety_location=$location
  safety_key=$key
  log "safety backup: $location $key"
}

update() {
  pin=$work/pin-target.env
  need_release "$version" "$pin" releaseNotFound
  if older "$from" "$release_min_from"; then refuse belowMinFrom; fi
  if older "$version" "$from"; then refuse downgrade; fi
  backup update
  pin_and_start "$version" "$pin"
  step="done"
  finish succeeded
}

# Restores under the backup's version, then updates to the running one when
# that is newer. No downgrade check: the database is replaced. A safety
# backup comes first; a failure once `opsdeck restore` ran is restoreFailed
# (not rolled back: the data has changed).
restore() {
  pin_backup=$work/pin-backup.env
  if older "$from" "$version"; then
    # Newer than this instance: allowed only for a published release.
    need_release "$version" "$pin_backup" backupTooNew
  else
    need_release "$version" "$pin_backup" releaseNotFound
  fi
  continue_to=
  if older "$version" "$from"; then
    continue_to=$from
    pin_current=$work/pin-current.env
    need_release "$from" "$pin_current" releaseNotFound
    if older "$version" "$release_min_from"; then refuse belowMinFrom; fi
  fi

  # Taken by the running images, before anything changes.
  backup restore
  remember_safety_backup
  record_previous
  set_step pull
  apply_env_lines "$pin_backup"
  run_logged docker compose pull || rollback pull
  set_step restore
  run_logged docker compose stop app terminal || rollback stop
  restore_invoked=1
  run_logged docker compose run --rm app opsdeck restore "$object_key" || restore_failed restore
  set_step up
  compose_up || restore_failed up
  set_step health
  healthy "$version" || restore_failed health
  restore_invoked=0

  if [ -n "$continue_to" ]; then
    # From here on, a rollback returns to the restored version.
    from=$version
    log "restored under $version; updating to $continue_to"
    pin_and_start "$continue_to" "$pin_current"
  fi
  step="done"
  finish succeeded
}

# Sets action, version (and object_key); returns 1 for anything else.
read_request() { # <file>
  req_key=
  if [ -L "$1" ] || [ ! -f "$1" ]; then return 1; fi
  content=$(dd if="$1" bs=4096 count=1 2>/dev/null) || return 1
  [ "${#content}" -lt 4096 ] || return 1
  if matches "$content" "\\{\"action\":\"update\",\"version\":\"$VERSION_RE\",$REQUESTED_RE\\}"; then
    req_action=update
  elif matches "$content" "\\{\"action\":\"restore\",\"objectKey\":\"$OBJECT_KEY_RE\",\"version\":\"$VERSION_RE\",$REQUESTED_RE\\}"; then
    req_action=restore
    req_key=$(printf '%s\n' "$content" | sed 's/^{"action":"restore","objectKey":"\([^"]*\)".*/\1/')
    case $req_key in *..*) return 1 ;; esac
    key_path=${req_key#local:}
    [ "${#key_path}" -le 511 ] || return 1
  else
    return 1
  fi
  version=$(printf '%s\n' "$content" | sed 's/.*"version":"\([^"]*\)".*/\1/')
  action=$req_action
  object_key=${req_key:-}
}

# --- main --------------------------------------------------------------------

[ $# -eq 1 ] || die "usage: update.sh <install dir>"
dir=$1
case $dir in /*) ;; *) die "the install dir must be an absolute path" ;; esac
updates=$dir/updates
env_file=$dir/.env
if [ -L "$updates" ] || [ ! -d "$updates" ]; then die "$updates is not a directory"; fi
[ -f "$env_file" ] || die "$env_file is missing"
cd "$dir"
umask 077
euid=$(id -u)
running=0
final=0
pinned=0
restore_invoked=0
caught=
work=
request=$updates/request.json

# Sticky: the app may create its request but not rename or delete what root
# writes here.
chmod 1770 "$updates"
own "$updates"

# 1. One run at a time; a second one leaves everything alone.
lock=$updates/.lock
if ! owned f "$lock"; then
  rm -rf "$lock"
  mv -f "$(mktemp "$updates/.lock.XXXXXX")" "$lock"
  owned f "$lock" || die "cannot create $lock"
fi
exec 9<"$lock"
flock -n 9 || exit 0

if [ ! -e "$request" ] && [ ! -L "$request" ]; then exit 0; fi

logs=$updates/logs
if ! owned d "$logs"; then
  rm -rf "$logs"
  mkdir "$logs" || die "cannot create $logs"
fi
chmod 0750 "$logs"
own "$logs"

run_id=$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
started_at=$(now)
finished_at=
action=
version=
object_key=
from=
safety_id=
safety_location=
safety_key=
step=validate
work=$(mktemp -d)
trap on_exit EXIT
trap 'caught=TERM; exit 143' TERM
trap 'caught=INT; exit 130' INT
trap 'caught=HUP; exit 129' HUP
log_file=$logs/$run_id.log
: >"$log_file"
chmod 0640 "$log_file"
own "$log_file"

# Consumed, so it cannot be replayed; kept next to the log.
mv -f "$request" "$logs/$run_id.request.json"
from=$(env_value OPSDECK_VERSION)
matches "$from" "$VERSION_RE" || from=
running=1
log "run $run_id started"
write_status running

# 2. The request.
if ! read_request "$logs/$run_id.request.json"; then
  log "request: not a valid update or restore request"
  refuse invalidRequest
fi
log "request: $action to $version${object_key:+ from $object_key}"

# The instance: running version, pinned lines and the health endpoint.
[ -n "$from" ] || { log "instance: OPSDECK_VERSION in .env is not a release version"; refuse invalidInstall; }
for pair in $IMAGE_KEYS; do
  matches "$(env_value "${pair%%:*}")" "$IMAGE_RE" ||
    { log "instance: ${pair%%:*} in .env is not pinned by digest"; refuse invalidInstall; }
done
http_port=$(env_value OPSDECK_HTTP_PORT)
http_port=${http_port:-8080}
host=$(env_value BETTER_AUTH_URL)
host=${host#*://}
host=${host%%/*}
host=${host%%:*}
matches "$http_port" '[0-9]{1,5}' || { log "instance: OPSDECK_HTTP_PORT is not a port"; refuse invalidInstall; }
matches "$host" '[A-Za-z0-9.-]{1,253}' || { log "instance: no hostname in BETTER_AUTH_URL"; refuse invalidInstall; }

if [ "$action" = restore ]; then restore; else update; fi

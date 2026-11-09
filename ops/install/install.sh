#!/bin/sh
# opsdeck installer, for Debian/Ubuntu hosts with systemd (amd64, arm64).
#
#   curl -fsSL https://github.com/romikusumabakti/opsdeck/releases/latest/download/install.sh | sh -s -- [flags]
#   sh install.sh [--version vX.Y.Z] [--channel stable|beta] [--dir /opt/<name>]
#                 [--hostname <host>] [--http-port N] [--dry-run]
#                 [--adopt <old .env>]
#                 [--restore <backup folder | local:<instance>/<name>/ | s3://<key>/>
#                  --secrets-key-file <file> --hostname <host> [--s3-env-file <file>]]
#
# One instance per dir, /opt/<name>: <name> is its compose project and its
# updater unit, opsdeck-updater@<name>.path. In order: Docker (from Docker's
# apt repository when missing; Compose 2.23.1 or later), the dir,
# compose.yaml, .env (0600, generated secrets), the updater (its own copy in
# <dir>/.updater, 0700 root), then `docker compose up -d --wait`.
#
# --adopt   takes over an existing stack (the repo-root compose.yaml layout):
#           copies its settings from the old .env, keeps its volumes
#           (OPSDECK_VOLUME_*) and its Caddy port (80 unless the old .env
#           says otherwise), and records the baseline migration as applied
#           (`opsdeck migrate --adopt`) before the first start. Stop the old
#           stack first (`docker compose down`, without -v).
# --restore installs the backup's version and restores it before the first
#           start (disaster recovery): a backup folder on this host (with
#           manifest.json), or s3://<key>/ with the bucket and keys in
#           --s3-env-file (0600: OPSDECK_RESTORE_S3_ENDPOINT, _REGION,
#           _BUCKET, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY, _FORCE_PATH_STYLE).
#           The SECRETS_KEY it was taken with is read from --secrets-key-file.
# --dry-run checks and prints every action without changing anything.
#
# Secrets are never printed or passed as arguments: only key names are shown.
set -eu

REPO=romikusumabakti/opsdeck
RELEASE_BASE=https://github.com/$REPO/releases/download
API=https://api.github.com/repos/$REPO
APP_UID=1001
APP_GID=1001
UNIT_DIR=/etc/systemd/system
WAIT_TIMEOUT=300
HEALTH_ATTEMPTS=20
HEALTH_INTERVAL=3

VERSION_RE='[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?'
IMAGE_RE='[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}'
OBJECT_KEY_RE='[A-Za-z0-9_][A-Za-z0-9._/-]*'
NAME_RE='[a-z0-9][a-z0-9_-]{0,62}'
HOST_RE='[A-Za-z0-9.-]{1,253}'
# .env key -> release.json images key. OPSDECK_VERSION is pinned with them.
IMAGE_KEYS='OPSDECK_IMAGE:app POSTGRES_IMAGE:postgres VALKEY_IMAGE:valkey GARAGE_IMAGE:garage IMGPROXY_IMAGE:imgproxy CADDY_IMAGE:caddy'
ASSETS='compose.yaml env.example update.sh opsdeck-updater@.path opsdeck-updater@.service'
# OPSDECK_VOLUME_* suffix -> the volume name in the repo-root compose.yaml,
# the stack --adopt replaces.
ADOPT_VOLUMES='POSTGRES:opsdeck_postgres_data VALKEY:opsdeck_valkey_data GARAGE_META:opsdeck_garage_meta GARAGE_DATA:opsdeck_garage_data CADDY_DATA:opsdeck_caddy_data CADDY_CONFIG:opsdeck_caddy_config'
# Copied from the old .env when present, as the exact lines compose parsed.
ADOPT_KEYS='POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB DATABASE_URL BETTER_AUTH_URL BETTER_AUTH_SECRET SECRETS_KEY MICROSOFT_CLIENT_ID MICROSOFT_TENANT_ID MICROSOFT_CLIENT_SECRET RESEND_API_KEY EMAIL_FROM BRAND APP_NAME COMPANY_NAME ALLOWED_EMAIL_DOMAIN NEXT_PUBLIC_APP_NAME NEXT_PUBLIC_COMPANY_NAME NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN APP_TIMEZONE DEPLOY_REGISTRY S3_BUCKET S3_REGION S3_ACCESS_KEY S3_SECRET_KEY GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN IMGPROXY_KEY IMGPROXY_SALT'
ADOPT_REQUIRED='POSTGRES_PASSWORD DATABASE_URL BETTER_AUTH_SECRET SECRETS_KEY'
# The old stack's Caddy port (repo-root compose.yaml publishes 127.0.0.1:80).
ADOPT_DEFAULT_PORT=80
# compose.yaml's volumes (<name>_<suffix> outside adopt mode).
INSTANCE_VOLUMES='postgres valkey garage_meta garage_data caddy_data caddy_config'
# compose.yaml uses configs.content, added in Compose 2.23.1.
MIN_COMPOSE=2.23.1
# Release assets checked against their sha256 in release.json.
RELEASE_ASSETS='compose.yaml update.sh'
RESTORE_S3_KEYS='OPSDECK_RESTORE_S3_ENDPOINT OPSDECK_RESTORE_S3_REGION OPSDECK_RESTORE_S3_BUCKET OPSDECK_RESTORE_S3_ACCESS_KEY_ID OPSDECK_RESTORE_S3_SECRET_ACCESS_KEY OPSDECK_RESTORE_S3_FORCE_PATH_STYLE'
# sha256 of an empty body: S3 signs GET requests with it.
EMPTY_SHA256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
NL='
'

usage() {
  sed -n '2,30s/^# \{0,1\}//p' "$0" 2>/dev/null || true
  exit "${1:-1}"
}

die() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$1"; }

log() {
  printf '%s\n' "$1" >>"$log_file"
  printf '%s\n' "$1" >&2
}

# A host-changing command: printed, and run unless --dry-run, with stdin
# closed (under `curl | sh` stdin is this script). Never pass a secret as an
# argument.
run() {
  printf '+ %s\n' "$*"
  if [ "$dry_run" = 0 ]; then
    changed=1
    "$@" </dev/null
  fi
}

compose() { run docker compose -f "$dir/compose.yaml" "$@"; }

# The whole value is one line matching the ERE.
matches() {
  case $1 in *"$NL"*) return 1 ;; esac
  printf '%s\n' "$1" | grep -Eqx -- "$2"
}

# The last KEY= line of an env file, as is.
env_line() { grep -E "^$1=" "$2" | tail -n 1; }

env_value() { # <key> <file>
  v=$(env_line "$1" "$2")
  v=${v#*=}
  case $v in
    \"*\") v=${v#\"}; v=${v%\"} ;;
    \'*\') v=${v#\'}; v=${v%\'} ;;
  esac
  printf '%s' "$v"
}

# The next three are update.sh's, verbatim (tests/install checks it): the
# installer accepts release.json and health exactly as the updater does.
one_line_json() { # <file> <max bytes>
  [ "$(wc -c <"$1" | tr -d ' ')" -le "$2" ] &&
    [ "$(wc -l <"$1" | tr -d ' ')" -le 1 ] &&
    ! grep -qF "\\" "$1"
}

json_str() { # <key> <file>
  awk -v k="\"$1\":\"" '
    { s = $0; while ((i = index(s, k)) > 0) { n++; s = substr(s, i + length(k)); if (n == 1) v = s } }
    END { j = index(v, "\""); if (n != 1 || j == 0) exit 1; print substr(v, 1, j - 1) }' "$2"
}

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

fetch() { # <url> <file>
  curl -fsSL --proto '=https' --proto-redir '=https' --max-time 120 -o "$2" "$1" </dev/null
}

hex() { openssl rand -hex "$1"; }
b64() { openssl rand -base64 32; }

# A docker.io (Debian/Ubuntu) or podman-docker package: Docker's packages
# conflict with it.
distro_docker() {
  for pkg in docker.io podman-docker; do
    if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'ok installed'; then
      printf '%s' "$pkg"
      return 0
    fi
  done
  return 1
}

# 0 when the volume exists, 1 when Docker says it does not; any other answer
# (the daemon is down) stops the install rather than count as "absent".
volume_exists() { # <volume>
  if err=$(docker volume inspect "$1" 2>&1 >/dev/null </dev/null); then return 0; fi
  case $err in
    *"no such volume"* | *"No such volume"*) return 1 ;;
  esac
  die "cannot check Docker volume $1 (is the Docker daemon running?): $err"
}

# The x.y.z of `docker compose version`, or nothing.
compose_version() {
  docker compose version 2>/dev/null </dev/null | head -n 1 |
    sed -n 's/^[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p'
}

# <a> is x.y.z at least <b>.
version_at_least() { # <a> <b>
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, p, "."); split(b, q, ".")
    for (i = 1; i <= 3; i++) if (p[i] + 0 != q[i] + 0) exit !(p[i] + 0 > q[i] + 0)
    exit 0
  }'
}

require_compose() {
  v=$(compose_version)
  if [ -z "$v" ] || ! version_at_least "$v" "$MIN_COMPOSE"; then
    die "Docker Compose ${v:-of unknown version} is too old: compose.yaml needs $MIN_COMPOSE or later (configs.content). Update docker-compose-plugin (Docker's repository), then run install.sh again"
  fi
}

# After a failure once the host was changed: how to get back. `down -v` only
# when every volume of this instance is one this run created.
way_back() {
  printf '\ninstall.sh failed after changing the host. ' >&2
  if [ -n "$adopt" ]; then
    printf '%s\n' "The old stack's volumes were reused in place, never copied or removed. To go back:" \
      "  docker compose -f $dir/compose.yaml down        (without -v: keeps the volumes)" \
      "  then start the old stack from its own dir again (docker compose up -d there)." \
      "migrate --adopt only records the baseline in drizzle.__drizzle_migrations; later migrations are expand-only, so the old version runs on them." >&2
  elif [ -n "$preexisting" ]; then
    printf '%s\n' "No other instance was touched. These volumes existed before install.sh and are kept:$preexisting" \
      "To start over:" \
      "  docker compose -f $dir/compose.yaml down        (without -v: keeps those volumes)" \
      "  docker volume rm <the other ${name}_* volumes>  (only the ones this run created)" \
      "  rm -rf $dir, then run install.sh again." >&2
  else
    printf '%s\n' "No other instance was touched. To start over:" \
      "  docker compose -f $dir/compose.yaml down -v     (removes this instance's containers and the volumes this run created)" \
      "  rm -rf $dir, then run install.sh again." >&2
  fi
}

# shellcheck disable=SC2317,SC2329 # invoked by the EXIT trap (SC2317 before 0.11)
on_exit() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$changed" = 1 ]; then way_back; fi
  if [ -n "$work" ]; then rm -rf "$work"; fi
}

# Reads the OPSDECK_RESTORE_S3_* lines of --s3-env-file into the environment
# (exported for `docker compose run -e NAME`, which passes values without
# putting them in an argument).
load_s3_env() { # <file>
  if [ ! -f "$1" ] || [ -L "$1" ] || [ ! -r "$1" ]; then die "--s3-env-file: cannot read $1"; fi
  case $(stat -c '%a' "$1") in
    600 | 400) ;;
    *) die "--s3-env-file: $1 must be mode 0600" ;;
  esac
  if [ "$dry_run" = 0 ] && [ "$(stat -c '%u' "$1")" != 0 ]; then
    die "--s3-env-file: $1 must be owned by root"
  fi
  for key in $RESTORE_S3_KEYS; do
    eval "$key=\$(env_value $key \"\$1\")"
    export "${key?}"
  done
  matches "$OPSDECK_RESTORE_S3_ENDPOINT" 'https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?' ||
    die "--s3-env-file: OPSDECK_RESTORE_S3_ENDPOINT must be http(s)://host[:port]"
  OPSDECK_RESTORE_S3_REGION=${OPSDECK_RESTORE_S3_REGION:-auto}
  OPSDECK_RESTORE_S3_FORCE_PATH_STYLE=${OPSDECK_RESTORE_S3_FORCE_PATH_STYLE:-true}
  matches "$OPSDECK_RESTORE_S3_REGION" '[a-z0-9-]{1,32}' || die "--s3-env-file: bad OPSDECK_RESTORE_S3_REGION"
  matches "$OPSDECK_RESTORE_S3_BUCKET" '[a-z0-9][a-z0-9.-]{1,62}' || die "--s3-env-file: bad OPSDECK_RESTORE_S3_BUCKET"
  matches "$OPSDECK_RESTORE_S3_ACCESS_KEY_ID" '[A-Za-z0-9+/=._-]{1,256}' || die "--s3-env-file: bad OPSDECK_RESTORE_S3_ACCESS_KEY_ID"
  matches "$OPSDECK_RESTORE_S3_SECRET_ACCESS_KEY" '[A-Za-z0-9+/=._~-]{1,256}' || die "--s3-env-file: bad OPSDECK_RESTORE_S3_SECRET_ACCESS_KEY"
  case $OPSDECK_RESTORE_S3_FORCE_PATH_STYLE in
    true | false) ;;
    *) die "--s3-env-file: OPSDECK_RESTORE_S3_FORCE_PATH_STYLE must be true or false" ;;
  esac
}

# Downloads <key><file> from the --s3-env-file bucket with a SigV4-signed GET;
# the keys go to curl in a 0600 config file, not in its arguments.
s3_get() { # <object key> <file>
  endpoint=${OPSDECK_RESTORE_S3_ENDPOINT%/}
  if [ "$OPSDECK_RESTORE_S3_FORCE_PATH_STYLE" = true ]; then
    url=$endpoint/$OPSDECK_RESTORE_S3_BUCKET/$1
  else
    url=${endpoint%%://*}://$OPSDECK_RESTORE_S3_BUCKET.${endpoint#*://}/$1
  fi
  (umask 077 && printf 'user = "%s:%s"\n' "$OPSDECK_RESTORE_S3_ACCESS_KEY_ID" \
    "$OPSDECK_RESTORE_S3_SECRET_ACCESS_KEY" >"$work/s3.curl")
  curl -fsS --max-time 120 -K "$work/s3.curl" --aws-sigv4 "aws:amz:$OPSDECK_RESTORE_S3_REGION:s3" \
    -H "x-amz-content-sha256: $EMPTY_SHA256" -o "$2" "$url" </dev/null
}

main() {
  version=
  channel=
  dir=/opt/opsdeck
  hostname=
  http_port=
  adopt=
  restore=
  key_file=
  s3_env_file=
  dry_run=0
  changed=0
  work=
  while [ $# -gt 0 ]; do
    case $1 in
      --version | --channel | --dir | --hostname | --http-port | --adopt | --restore | --secrets-key-file | --s3-env-file)
        [ $# -ge 2 ] || die "$1 needs a value"
        case $1 in
          --version) version=$2 ;;
          --channel) channel=$2 ;;
          --dir) dir=$2 ;;
          --hostname) hostname=$2 ;;
          --http-port) http_port=$2 ;;
          --adopt) adopt=$2 ;;
          --restore) restore=$2 ;;
          --secrets-key-file) key_file=$2 ;;
          --s3-env-file) s3_env_file=$2 ;;
        esac
        shift 2
        ;;
      --dry-run) dry_run=1; shift ;;
      -h | --help) usage 0 ;;
      *) die "unknown argument: $1 (see --help)" ;;
    esac
  done

  if [ -n "$version" ]; then
    matches "$version" "v$VERSION_RE" || die "--version must be vX.Y.Z or vX.Y.Z-beta.N"
    version=${version#v}
  fi
  case $channel in
    "" | stable | beta) ;;
    *) die "--channel must be stable or beta" ;;
  esac
  case $version in
    *-beta.*)
      [ "$channel" != stable ] || die "v$version is a beta release; use --channel beta"
      channel=beta
      ;;
  esac
  channel=${channel:-stable}
  if [ -n "$hostname" ]; then
    matches "$hostname" "$HOST_RE" || die "--hostname must be a bare host name, e.g. panel.example.com"
  fi
  if [ -n "$http_port" ]; then
    if ! matches "$http_port" '[0-9]{1,5}' || [ "$http_port" -lt 1 ] || [ "$http_port" -gt 65535 ]; then
      die "--http-port must be a port number"
    fi
  fi
  [ -z "$adopt" ] || [ -z "$restore" ] || die "--adopt and --restore cannot be combined"
  [ -z "$key_file" ] || [ -n "$restore" ] || die "--secrets-key-file is only for --restore"
  case $restore in
    s3://*) [ -n "$s3_env_file" ] || die "--restore s3://... needs --s3-env-file <file> with the bucket and its keys" ;;
    *) [ -z "$s3_env_file" ] || die "--s3-env-file is only for --restore s3://..." ;;
  esac
  if [ -n "$restore" ] && [ -z "$hostname" ]; then
    die "--restore needs --hostname: the restored passkeys and sessions are bound to it"
  fi

  # The updater units watch /opt/%i, so an instance lives in /opt/<name>. The
  # tests point the root elsewhere, for a dry run only.
  root=/opt
  if [ "$dry_run" = 1 ] && [ -n "${OPSDECK_INSTALL_ROOT:-}" ]; then root=$OPSDECK_INSTALL_ROOT; fi
  dir=${dir%/}
  name=${dir#"$root"/}
  if [ "$dir" != "$root/$name" ] || ! matches "$name" "$NAME_RE"; then
    die "--dir must be $root/<name>, <name> in lower case letters, digits, - and _ (the updater units watch /opt/<name>)"
  fi
  env_file=$dir/.env

  if [ -e "$env_file" ] && [ -z "$adopt" ]; then
    die "$env_file already exists: this dir is installed (updates come from the Panel; --adopt takes over a stack)"
  fi

  # --- host ------------------------------------------------------------------

  [ "$(id -u)" -eq 0 ] || host_problem "run as root (sudo sh install.sh ...)"
  os_id=
  os_codename=
  if [ -r /etc/os-release ]; then
    # shellcheck source=/dev/null
    os_id=$(. /etc/os-release && printf '%s' "${ID:-}")
    # shellcheck source=/dev/null
    os_codename=$(. /etc/os-release && printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")
  fi
  case $os_id in
    debian | ubuntu) ;;
    *) host_problem "only Debian and Ubuntu are supported (this host: ${os_id:-unknown})" ;;
  esac
  case $(uname -m) in
    x86_64 | amd64 | aarch64 | arm64) ;;
    *) host_problem "only amd64 and arm64 are supported (this host: $(uname -m))" ;;
  esac
  [ -d /run/systemd/system ] || host_problem "systemd is not running on this host"
  for tool in curl openssl sha256sum stat; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
  done

  work=$(mktemp -d)
  log_file=$work/install.log
  : >"$log_file"
  trap on_exit EXIT
  trap 'exit 1' INT TERM HUP

  # --- restore source --------------------------------------------------------

  restore_src=
  restore_name=
  restore_key=
  if [ -n "$restore" ]; then
    [ -n "$key_file" ] || die "--restore needs --secrets-key-file <file> with the SECRETS_KEY the backup was taken with"
    case $restore in
      s3://*)
        restore_key=${restore#s3://}
        case $restore_key in */) ;; *) restore_key=$restore_key/ ;; esac
        case $restore_key in *..*) die "--restore: no .. in an object key" ;; esac
        if [ "${#restore_key}" -gt 511 ] || ! matches "$restore_key" "$OBJECT_KEY_RE"; then
          die "--restore: s3://<key>/ is the backup's folder key, e.g. s3://opsdeck-backups/opsdeck/<name>/"
        fi
        load_s3_env "$s3_env_file"
        mkdir "$work/s3-backup"
        restore_src=$work/s3-backup
        s3_get "${restore_key}manifest.json" "$restore_src/manifest.json" ||
          die "--restore: cannot download ${restore_key}manifest.json from the --s3-env-file bucket"
        ;;
      local:*)
        path=${restore#local:}
        path=${path%/}
        case $path in *..* | /*) die "--restore local:<instance>/<name>/ is a path inside $dir/backups" ;; esac
        restore_src=$dir/backups/$path
        restore_key=local:$path/
        ;;
      *)
        # A folder on this host (absolute or relative).
        restore_src=${restore%/}
        restore_name=${restore_src##*/}
        matches "$restore_name" '[A-Za-z0-9_][A-Za-z0-9._-]{0,200}' || die "--restore: unusable backup folder name"
        restore_key=local:$name/$restore_name/
        ;;
    esac
    [ -f "$restore_src/manifest.json" ] || die "--restore: $restore_src/manifest.json not found"
    backup_version=$(sed -n 's/^  "version": "\([^"]*\)",\{0,1\}$/\1/p' "$restore_src/manifest.json" | head -n 1)
    matches "$backup_version" "$VERSION_RE" || die "--restore: the manifest has no release version"
    backup_fp=$(sed -n 's/^  "secretsKeyFingerprint": "\([0-9a-f]\{16\}\)",\{0,1\}$/\1/p' "$restore_src/manifest.json" | head -n 1)
    [ -r "$key_file" ] || die "--secrets-key-file: cannot read $key_file"
    restore_secrets_key=$(tr -d ' \t\r\n' <"$key_file")
    [ "$(printf '%s' "$restore_secrets_key" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ')" = 32 ] ||
      die "--secrets-key-file: not a base64 key of 32 bytes"
    [ "$(printf '%s' "$restore_secrets_key" | sha256sum | cut -c1-16)" = "$backup_fp" ] ||
      die "--secrets-key-file: the key does not match the backup's SECRETS_KEY fingerprint"
    if [ -n "$version" ] && [ "$version" != "$backup_version" ]; then
      die "--restore: the backup is from $backup_version; a restore installs that version (drop --version)"
    fi
    version=$backup_version
    case $version in *-beta.*) channel=beta ;; esac
  fi

  # --- release ---------------------------------------------------------------

  if [ -z "$version" ]; then
    if [ "$channel" = beta ]; then
      fetch "$API/releases?per_page=1" "$work/latest.json" || die "cannot read the latest release from GitHub"
    else
      fetch "$API/releases/latest" "$work/latest.json" || die "cannot read the latest stable release from GitHub"
    fi
    version=$(grep -o '"tag_name": *"v[^"]*"' "$work/latest.json" | head -n 1 | sed 's/.*"v\([^"]*\)"/\1/')
    matches "$version" "$VERSION_RE" || die "the latest release has no usable version tag"
  fi

  for asset in release.json $ASSETS; do
    fetch "$RELEASE_BASE/v$version/$asset" "$work/$asset" || die "release v$version: cannot download $asset"
  done
  rel=$work/release.json
  if ! one_line_json "$rel" 16384 || [ "$(json_str version "$rel")" != "$version" ]; then
    die "release v$version: release.json is invalid"
  fi
  for asset in $RELEASE_ASSETS; do
    sum=$(sha256sum <"$work/$asset")
    [ "${sum%% *}" = "$(json_str "$asset" "$rel")" ] ||
      die "release v$version: $asset does not match its sha256 in release.json"
  done
  pins=$work/pins.env
  printf 'OPSDECK_VERSION=%s\n' "$version" >"$pins"
  for pair in $IMAGE_KEYS; do
    img=$(json_str "${pair#*:}" "$rel") || die "release v$version: release.json has no ${pair#*:} image"
    matches "$img" "$IMAGE_RE" || die "release v$version: the ${pair#*:} image is not pinned by digest"
    printf '%s=%s\n' "${pair%%:*}" "$img" >>"$pins"
  done
  say "opsdeck $version ($channel) into $dir"

  # --- the volumes: adopt's old stack, or none for a fresh install -----------

  copied=
  preexisting=
  have_docker=0
  if command -v docker >/dev/null 2>&1; then have_docker=1; fi
  if [ -n "$adopt" ]; then
    if [ ! -r "$adopt" ] || [ ! -f "$adopt" ]; then die "--adopt: cannot read $adopt"; fi
    for key in $ADOPT_REQUIRED; do
      [ -n "$(env_value "$key" "$adopt")" ] || die "--adopt: $key is missing in $adopt"
    done
    [ "$have_docker" = 1 ] || die "--adopt: Docker is not installed, so there is no stack to adopt"
    for pair in $ADOPT_VOLUMES; do
      volume=${pair#*:}
      if volume_exists "$volume"; then
        # Stopped containers count: `up` or a restart policy would bring them back.
        if [ -n "$(docker ps -aq --filter "volume=$volume" </dev/null)" ]; then
          die "--adopt: volume $volume is in use: remove the old stack's containers first (docker compose down, without -v)"
        fi
      elif [ "${pair%%:*}" = POSTGRES ]; then
        die "--adopt: volume $volume (the old database) not found"
      fi
    done
    old_port=$(env_value OPSDECK_HTTP_PORT "$adopt")
    old_port=${old_port:-$ADOPT_DEFAULT_PORT}
    if [ -n "$http_port" ] && [ "$http_port" != "$old_port" ]; then
      say "warning: the old stack served on 127.0.0.1:$old_port; with --http-port $http_port the tunnel or proxy must be repointed"
    fi
    http_port=${http_port:-$old_port}
  elif [ "$have_docker" = 1 ]; then
    # A restore too: it must never replace data it did not install.
    if volume_exists "${name}_postgres"; then
      die "volume ${name}_postgres already exists: an earlier install of $name left its data (use --adopt, or remove the volume)"
    fi
    for suffix in $INSTANCE_VOLUMES; do
      if volume_exists "${name}_$suffix"; then preexisting="$preexisting ${name}_$suffix"; fi
    done
  fi
  port=${http_port:-8080}

  # --- 1. Docker -------------------------------------------------------------

  step "Docker"
  if [ "$have_docker" = 1 ] && docker compose version >/dev/null 2>&1 </dev/null; then
    say "found: $(docker compose version 2>/dev/null </dev/null | head -n 1)"
    require_compose
  elif pkg=$(distro_docker); then
    die "the distribution's $pkg package is installed; Docker's docker-ce conflicts with it. Remove it (apt-get remove $pkg) or add its Compose v2 (docker-compose-v2), then run install.sh again"
  elif [ "$have_docker" = 1 ]; then
    die "docker is installed without Compose v2: install docker-compose-plugin (Docker's repository), then run install.sh again"
  else
    say "Docker Engine is missing: installing from Docker's apt repository"
    arch=$(dpkg --print-architecture 2>/dev/null || echo amd64)
    run apt-get update
    run apt-get install -y ca-certificates curl
    run install -m 0755 -d /etc/apt/keyrings
    run curl -fsSL "https://download.docker.com/linux/$os_id/gpg" -o /etc/apt/keyrings/docker.asc
    run chmod a+r /etc/apt/keyrings/docker.asc
    cat >"$work/docker.sources" <<EOF
Types: deb
URIs: https://download.docker.com/linux/$os_id
Suites: $os_codename
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    run install -m 0644 "$work/docker.sources" /etc/apt/sources.list.d/docker.sources
    run apt-get update
    run apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    run systemctl enable --now docker.service
    if [ "$dry_run" = 0 ]; then require_compose; fi
  fi

  # --- 2. The install dir ----------------------------------------------------

  step "Install dir"
  run install -d -m 0755 "$dir"
  # The app (uid/gid 1001) writes request.json here; root writes the rest.
  run install -d -m 1770 -o 0 -g "$APP_GID" "$dir/updates"
  run install -d -m 0750 -o "$APP_UID" -g "$APP_GID" "$dir/backups"
  run install -m 0644 "$work/compose.yaml" "$dir/compose.yaml"
  run install -m 0644 "$work/env.example" "$dir/env.example"

  # --- 3. .env ---------------------------------------------------------------

  step ".env"
  new_env=$work/new.env
  (umask 077 && : >"$new_env")
  {
    printf '# opsdeck instance %s, written by install.sh. Keep it 0600: it holds the\n' "$name"
    printf '# secrets. env.example documents every key.\n'
    printf 'COMPOSE_PROJECT_NAME=%s\n' "$name"
    printf 'OPSDECK_DIR=%s\n' "$dir"
    cat "$pins"
    printf 'OPSDECK_HTTP_PORT=%s\n' "$port"
  } >>"$new_env"

  if [ -n "$adopt" ]; then
    for key in $ADOPT_KEYS; do
      line=$(env_line "$key" "$adopt") || line=
      [ -n "$line" ] || continue
      if [ "$key" = BETTER_AUTH_URL ] && [ -n "$hostname" ]; then continue; fi
      if [ "$key" = DATABASE_URL ]; then
        # The old stack may have reached Postgres by its container_name.
        fixed=$(printf '%s\n' "$line" | sed 's|^\(DATABASE_URL=.*@\)[^@/:]*\(:[0-9]*\)\{0,1\}/|\1postgres:5432/|')
        if [ "$fixed" != "$line" ]; then say "DATABASE_URL: host set to postgres"; fi
        line=$fixed
      fi
      printf '%s\n' "$line" >>"$new_env"
      copied="$copied $key"
    done
    say "copied from $adopt:$copied"
  fi

  # Generated when not copied. Hex where a value goes into a URL or must be
  # hex (Garage, imgproxy).
  if [ -n "$hostname" ]; then
    add BETTER_AUTH_URL "https://$hostname"
  elif ! have BETTER_AUTH_URL; then
    add BETTER_AUTH_URL "http://localhost:$port"
  fi
  if ! have POSTGRES_PASSWORD; then
    pg_password=$(hex 32)
    add POSTGRES_USER postgres
    add POSTGRES_DB opsdeck
    add POSTGRES_PASSWORD "$pg_password"
    add DATABASE_URL "postgres://postgres:$pg_password@postgres:5432/opsdeck"
  fi
  have BETTER_AUTH_SECRET || add BETTER_AUTH_SECRET "$(b64)"
  if [ -n "$restore" ]; then add SECRETS_KEY "$restore_secrets_key"; fi
  have SECRETS_KEY || add SECRETS_KEY "$(b64)"
  have GARAGE_RPC_SECRET || add GARAGE_RPC_SECRET "$(hex 32)"
  have GARAGE_ADMIN_TOKEN || add GARAGE_ADMIN_TOKEN "$(b64)"
  if ! have S3_ACCESS_KEY || [ -z "$(env_value S3_ACCESS_KEY "$new_env")" ]; then
    # An adopted stack whose Garage was never provisioned gets a key too.
    grep -vE '^S3_(ACCESS|SECRET)_KEY=' "$new_env" >"$new_env.tmp" || true
    mv -f "$new_env.tmp" "$new_env"
    add S3_ACCESS_KEY "GK$(hex 12)"
    add S3_SECRET_KEY "$(hex 32)"
  fi
  have IMGPROXY_KEY || add IMGPROXY_KEY "$(hex 32)"
  have IMGPROXY_SALT || add IMGPROXY_SALT "$(hex 32)"
  if [ -n "$adopt" ]; then
    for pair in $ADOPT_VOLUMES; do
      volume=${pair#*:}
      if volume_exists "$volume"; then
        add "OPSDECK_VOLUME_${pair%%:*}" "$volume"
        say "keeps volume: OPSDECK_VOLUME_${pair%%:*}=$volume"
      fi
    done
  fi
  chmod 0600 "$new_env"
  say "keys: $(cut -d= -f1 "$new_env" | grep -v '^#' | tr '\n' ' ')"
  if [ -e "$env_file" ]; then
    run cp -p "$env_file" "$env_file.pre-adopt-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  say "writing $env_file (0600)"
  run install -m 0600 -o 0 -g 0 "$new_env" "$env_file"

  # --- 4. The updater --------------------------------------------------------

  step "Updater"
  # This instance's own updater, out of the app's reach; each successful
  # update replaces it with the release's.
  run install -d -m 0700 -o 0 -g 0 "$dir/.updater"
  run install -m 0700 -o 0 -g 0 "$work/update.sh" "$dir/.updater/update.sh"
  run install -m 0644 "$work/opsdeck-updater@.path" "$work/opsdeck-updater@.service" "$UNIT_DIR/"
  run systemctl daemon-reload
  # The service also runs once at boot (a request written before a reboot).
  run systemctl enable "opsdeck-updater@$name.service"
  run systemctl enable --now "opsdeck-updater@$name.path"

  # --- 5. Adopt or restore before the first start ----------------------------

  if [ -n "$adopt" ]; then
    step "Adopt"
    compose pull
    compose up -d --wait --wait-timeout "$WAIT_TIMEOUT" postgres
    # Checks that the schema equals the baseline's, then records it as applied.
    compose run --rm migrate opsdeck migrate --adopt
  elif [ -n "$restore" ]; then
    step "Restore"
    compose pull
    if [ -n "$restore_name" ]; then
      run install -d -m 0750 -o "$APP_UID" -g "$APP_GID" "$dir/backups/$name"
      run cp -R "$restore_src" "$dir/backups/$name/$restore_name"
      run chown -R "$APP_UID:$APP_GID" "$dir/backups/$name/$restore_name"
    fi
    compose up -d --wait --wait-timeout "$WAIT_TIMEOUT" postgres valkey garage
    compose run --rm migrate
    case $restore in
      s3://*)
        # -e NAME passes the exported value without it being an argument.
        compose run --rm --no-deps \
          -e OPSDECK_RESTORE_S3_ENDPOINT -e OPSDECK_RESTORE_S3_REGION \
          -e OPSDECK_RESTORE_S3_BUCKET -e OPSDECK_RESTORE_S3_ACCESS_KEY_ID \
          -e OPSDECK_RESTORE_S3_SECRET_ACCESS_KEY -e OPSDECK_RESTORE_S3_FORCE_PATH_STYLE \
          app opsdeck restore "$restore_key"
        ;;
      *) compose run --rm --no-deps app opsdeck restore "$restore_key" ;;
    esac
  fi

  # --- 6. Start --------------------------------------------------------------

  step "Start"
  if [ -z "$adopt" ] && [ -z "$restore" ]; then compose pull; fi
  compose up -d --wait --wait-timeout "$WAIT_TIMEOUT"
  if [ "$channel" = beta ] && [ -z "$adopt" ] && [ -z "$restore" ]; then
    # A beta instance follows the beta channel and updates itself. The
    # variables expand inside the postgres container.
    # shellcheck disable=SC2016
    compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "UPDATE instance_settings SET update_channel = '\''beta'\'', auto_update = true WHERE id = 1"'
  fi

  url=$(env_value BETTER_AUTH_URL "$new_env")
  host=${url#*://}
  host=${host%%/*}
  host=${host%%:*}
  http_port=$port
  if [ "$dry_run" = 0 ]; then
    healthy "$version" || die "opsdeck started but /api/health does not report $version; see docker compose logs in $dir"
  fi

  say ""
  if [ "$dry_run" = 1 ]; then say "dry run: nothing was changed. After a real run:"; fi
  say "opsdeck $version is running at $url (Caddy on 127.0.0.1:$port; point the tunnel or proxy there)."
  if [ -z "$adopt" ] && [ -z "$restore" ]; then
    say "Create the first admin at $url/setup."
  fi
  say "Save SECRETS_KEY from $env_file somewhere offline (a password manager): it is never in a backup, and a restore needs it."
}

# Fatal in a real run, a notice in a dry run.
host_problem() {
  if [ "$dry_run" = 1 ]; then say "dry run: a real run would stop here: $1"; else die "$1"; fi
}

have() { grep -qE "^$1=" "$new_env"; }
add() { printf '%s=%s\n' "$1" "$2" >>"$new_env"; }

# Last, so a partly downloaded script (curl | sh) runs nothing.
main "$@"

#!/bin/sh
# opsdeck installer, for Debian/Ubuntu hosts with systemd (amd64, arm64).
#
#   curl -fsSL https://github.com/romikusumabakti/opsdeck/releases/latest/download/install.sh | sh
#   sh install.sh [--version vX.Y.Z] [--channel stable|beta] [--dir /opt/<name>]
#                 [--hostname <host>] [--http-port N] [--dry-run]
#                 [--adopt <old .env>]
#                 [--restore <backup folder | local:<instance>/<name>/> --secrets-key-file <file>]
#
# One instance per dir, /opt/<name>: <name> is its compose project and its
# updater unit, opsdeck-updater@<name>.path. In order: Docker (from Docker's
# apt repository when missing), the dir, compose.yaml, .env (0600, generated
# secrets), the updater, then `docker compose up -d --wait`.
#
# --adopt   takes over an existing stack (the repo-root compose.yaml layout):
#           copies its settings from the old .env, keeps its volumes
#           (OPSDECK_VOLUME_*) and records the baseline migration as applied
#           (`opsdeck migrate --adopt`) before the first start. Stop the old
#           stack first (`docker compose down`, without -v).
# --restore installs the backup's version and restores it before the first
#           start (disaster recovery). The backup must be on this host: an
#           S3 backup is downloaded first (its folder, with manifest.json).
#           The SECRETS_KEY it was taken with is read from --secrets-key-file.
# --dry-run checks and prints every action without changing anything.
#
# Secrets are never printed: only .env key names are.
set -eu

REPO=romikusumabakti/opsdeck
RELEASE_BASE=https://github.com/$REPO/releases/download
API=https://api.github.com/repos/$REPO
APP_UID=1001
APP_GID=1001
LIB_DIR=/usr/local/lib/opsdeck
UNIT_DIR=/etc/systemd/system
WAIT_TIMEOUT=300
HEALTH_ATTEMPTS=40
HEALTH_INTERVAL=3

VERSION_RE='[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?'
IMAGE_RE='[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}'
NAME_RE='[a-z0-9][a-z0-9_-]{0,62}'
HOST_RE='[A-Za-z0-9.-]{1,253}'
# .env key -> release.json images key (as in update.sh).
IMAGE_KEYS='OPSDECK_IMAGE:app POSTGRES_IMAGE:postgres VALKEY_IMAGE:valkey GARAGE_IMAGE:garage IMGPROXY_IMAGE:imgproxy CADDY_IMAGE:caddy'
ASSETS='compose.yaml env.example update.sh opsdeck-updater@.path opsdeck-updater@.service'
# OPSDECK_VOLUME_* suffix -> the volume name in the repo-root compose.yaml,
# the stack --adopt replaces.
ADOPT_VOLUMES='POSTGRES:opsdeck_postgres_data VALKEY:opsdeck_valkey_data GARAGE_META:opsdeck_garage_meta GARAGE_DATA:opsdeck_garage_data CADDY_DATA:opsdeck_caddy_data CADDY_CONFIG:opsdeck_caddy_config'
# Copied from the old .env when present, as the exact lines compose parsed.
ADOPT_KEYS='POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB DATABASE_URL BETTER_AUTH_URL BETTER_AUTH_SECRET SECRETS_KEY MICROSOFT_CLIENT_ID MICROSOFT_TENANT_ID MICROSOFT_CLIENT_SECRET RESEND_API_KEY EMAIL_FROM BRAND APP_NAME COMPANY_NAME ALLOWED_EMAIL_DOMAIN NEXT_PUBLIC_APP_NAME NEXT_PUBLIC_COMPANY_NAME NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN APP_TIMEZONE DEPLOY_REGISTRY S3_BUCKET S3_REGION S3_ACCESS_KEY S3_SECRET_KEY GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN IMGPROXY_KEY IMGPROXY_SALT'
ADOPT_REQUIRED='POSTGRES_PASSWORD DATABASE_URL BETTER_AUTH_SECRET SECRETS_KEY'
NL='
'

usage() {
  sed -n '2,25s/^# \{0,1\}//p' "$0" 2>/dev/null || true
  exit "${1:-1}"
}

die() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$1"; }

# A host-changing command: printed, and run unless --dry-run. Never pass a
# secret as an argument.
run() {
  printf '+ %s\n' "$*"
  if [ "$dry_run" = 0 ]; then "$@"; fi
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

# The string value of a key that occurs exactly once in a one-line JSON file
# without backslashes (as in update.sh).
json_str() { # <key> <file>
  awk -v k="\"$1\":\"" '
    { s = $0; while ((i = index(s, k)) > 0) { n++; s = substr(s, i + length(k)); if (n == 1) v = s } }
    END { j = index(v, "\""); if (n != 1 || j == 0) exit 1; print substr(v, 1, j - 1) }' "$2"
}

fetch() { # <url> <file>
  curl -fsSL --proto '=https' --proto-redir '=https' --max-time 120 -o "$2" "$1"
}

hex() { openssl rand -hex "$1"; }
b64() { openssl rand -base64 32; }

# --- arguments ---------------------------------------------------------------

version=
channel=
dir=/opt/opsdeck
hostname=
http_port=
adopt=
restore=
key_file=
dry_run=0
while [ $# -gt 0 ]; do
  case $1 in
    --version | --channel | --dir | --hostname | --http-port | --adopt | --restore | --secrets-key-file)
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
  matches "$http_port" '[0-9]{1,5}' && [ "$http_port" -ge 1 ] && [ "$http_port" -le 65535 ] ||
    die "--http-port must be a port number"
fi
[ -z "$adopt" ] || [ -z "$restore" ] || die "--adopt and --restore cannot be combined"
[ -z "$key_file" ] || [ -n "$restore" ] || die "--secrets-key-file is only for --restore"

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

# --- host --------------------------------------------------------------------

# Fatal in a real run, a notice in a dry run.
host_problem() {
  if [ "$dry_run" = 1 ]; then say "dry run: a real run would stop here: $1"; else die "$1"; fi
}

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
for tool in curl openssl sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
umask 077

# --- restore source ----------------------------------------------------------

restore_src=
restore_name=
restore_key=
if [ -n "$restore" ]; then
  [ -n "$key_file" ] || die "--restore needs --secrets-key-file <file> with the SECRETS_KEY the backup was taken with"
  case $restore in
    local:*)
      path=${restore#local:}
      path=${path%/}
      case $path in *..* | /*) die "--restore local:<instance>/<name>/ is a path inside $dir/backups" ;; esac
      restore_src=$dir/backups/$path
      restore_key=local:$path/
      ;;
    /* | ./* | ../*)
      restore_src=${restore%/}
      restore_name=${restore_src##*/}
      matches "$restore_name" '[A-Za-z0-9_][A-Za-z0-9._-]{0,200}' || die "--restore: unusable backup folder name"
      restore_key=local:$name/$restore_name/
      ;;
    *)
      die "--restore: on a fresh install the backup must be on this host: download the backup folder (e.g. rclone copy or aws s3 cp --recursive of $restore) and pass its path"
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

# --- release -----------------------------------------------------------------

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
[ "$(wc -l <"$rel" | tr -d ' ')" -le 1 ] && ! grep -qF "\\" "$rel" &&
  [ "$(json_str version "$rel")" = "$version" ] || die "release v$version: release.json is invalid"
pins=$work/pins.env
printf 'OPSDECK_VERSION=%s\n' "$version" >"$pins"
for pair in $IMAGE_KEYS; do
  img=$(json_str "${pair#*:}" "$rel") || die "release v$version: release.json has no ${pair#*:} image"
  matches "$img" "$IMAGE_RE" || die "release v$version: the ${pair#*:} image is not pinned by digest"
  printf '%s=%s\n' "${pair%%:*}" "$img" >>"$pins"
done
say "opsdeck $version ($channel) into $dir"

# --- adopt: the old stack ----------------------------------------------------

copied=
if [ -n "$adopt" ]; then
  [ -r "$adopt" ] && [ -f "$adopt" ] || die "--adopt: cannot read $adopt"
  for key in $ADOPT_REQUIRED; do
    [ -n "$(env_value "$key" "$adopt")" ] || die "--adopt: $key is missing in $adopt"
  done
  command -v docker >/dev/null 2>&1 || die "--adopt: Docker is not installed, so there is no stack to adopt"
  for pair in $ADOPT_VOLUMES; do
    volume=${pair#*:}
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      if [ -n "$(docker ps -q --filter "volume=$volume")" ]; then
        die "--adopt: volume $volume is in use: stop the old stack first (docker compose down, without -v)"
      fi
    elif [ "${pair%%:*}" = POSTGRES ]; then
      die "--adopt: volume $volume (the old database) not found"
    fi
  done
fi

# --- 1. Docker ---------------------------------------------------------------

step "Docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  say "found: $(docker compose version 2>/dev/null | head -n 1)"
else
  say "Docker Engine or Compose v2 is missing: installing from Docker's apt repository"
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
fi

# --- 2. The install dir ------------------------------------------------------

step "Install dir"
run install -d -m 0755 "$dir"
# The app (uid/gid 1001) writes request.json here; root writes the rest.
run install -d -m 1770 -o 0 -g "$APP_GID" "$dir/updates"
run install -d -m 0750 -o "$APP_UID" -g "$APP_GID" "$dir/backups"
run install -m 0644 "$work/compose.yaml" "$dir/compose.yaml"
run install -m 0644 "$work/env.example" "$dir/env.example"

# --- 3. .env -----------------------------------------------------------------

step ".env"
new_env=$work/new.env
port=${http_port:-8080}
{
  printf '# opsdeck instance %s, written by install.sh. Keep it 0600: it holds the\n' "$name"
  printf '# secrets. env.example documents every key.\n'
  printf 'COMPOSE_PROJECT_NAME=%s\n' "$name"
  printf 'OPSDECK_DIR=%s\n' "$dir"
  cat "$pins"
  printf 'OPSDECK_HTTP_PORT=%s\n' "$port"
} >"$new_env"

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

# Generated when not copied. Hex where a value goes into a URL or must be hex
# (Garage, imgproxy).
have() { grep -qE "^$1=" "$new_env"; }
add() { printf '%s=%s\n' "$1" "$2" >>"$new_env"; }
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
if [ -n "$restore" ]; then
  add SECRETS_KEY "$restore_secrets_key"
fi
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
    if docker volume inspect "$volume" >/dev/null 2>&1; then
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

# --- 4. The updater ----------------------------------------------------------

step "Updater"
run install -d -m 0755 "$LIB_DIR"
run install -m 0755 "$work/update.sh" "$LIB_DIR/update.sh"
run install -m 0644 "$work/opsdeck-updater@.path" "$work/opsdeck-updater@.service" "$UNIT_DIR/"
run systemctl daemon-reload
run systemctl enable --now "opsdeck-updater@$name.path"

# --- 5. Adopt or restore before the first start ------------------------------

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
  compose run --rm --no-deps app opsdeck restore "$restore_key"
fi

# --- 6. Start ----------------------------------------------------------------

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
if [ "$dry_run" = 0 ]; then
  i=0
  until curl -fsS --max-time 10 -H "Host: $host" -o "$work/health" "http://127.0.0.1:$port/api/health" 2>/dev/null &&
    grep -qF "\"version\":\"$version\"" "$work/health"; do
    i=$((i + 1))
    [ "$i" -lt "$HEALTH_ATTEMPTS" ] || die "opsdeck started but /api/health does not report $version; see docker compose logs in $dir"
    sleep "$HEALTH_INTERVAL"
  done
fi

say ""
if [ "$dry_run" = 1 ]; then say "dry run: nothing was changed. After a real run:"; fi
say "opsdeck $version is running at $url (Caddy on 127.0.0.1:$port; point the tunnel or proxy there)."
if [ -z "$adopt" ] && [ -z "$restore" ]; then
  say "Create the first admin at $url/setup."
fi
say "Save SECRETS_KEY from $env_file somewhere offline (a password manager): it is never in a backup, and a restore needs it."

# Panel deploy

How CI tells the Panel about a new build, how the Panel deploys it to a Docker
Compose host over SSH, and what must be true on the server. This is the contract
for pipeline authors (Woodpecker) and operators. Where this document and the
code differ, the code wins; the files are named in each section.

The feature is off until `DEPLOY_REGISTRY` is set (for example
`192.168.10.113:5000`, `host[:port]`). While it is unset, the hook answers
`503` and the deploy API refuses with `503`.

## Overview

1. CI builds the app images and a **bundle image**, pushes them, then notifies
   the Panel with a signed request.
2. The Panel records the build. For every target that follows the build's
   branch with auto deploy on, it queues an `auto` deployment. A maintainer can
   also deploy any recorded tag of the target's branch by hand.
3. A worker runs one shell script on the target's server over SSH: pull the
   bundle, extract it into the deploy dir, set the tag variable in `.env`, pull
   images, restart only the listed services, wait for health.

The Panel stores no app configuration. The only `.env` line it ever changes on
the server is the target's tag variable (default `IMAGE_TAG`).

## Build notification hook

`POST /api/deploy-hooks/builds` (code: `server/routes/deploy-hooks.ts`,
`server/services/deploy-builds.ts`, `lib/deploy/signature.ts`).

Headers:

- `Content-Type: application/json` is **required**. Without it the CSRF guard
  answers `403` before the hook runs.
- `X-Menara-Signature: sha256=<hex>`, where `<hex>` is the HMAC-SHA256 of the
  **exact raw request body** under the component's notify secret, 64 lowercase or
  uppercase hex digits. Sign the same bytes you send; do not re-serialise.

Body (JSON, at most 16 KiB):

| Field         | Rule                                                                |
| ------------- | ------------------------------------------------------------------- |
| `app`         | Component key, `^[a-z0-9][a-z0-9-]{0,63}$`. Must be registered.     |
| `branch`      | `^[A-Za-z0-9][A-Za-z0-9/_.-]{0,199}$`, no `..`.                     |
| `tag`         | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`, never `latest` (any casing).  |
| `commit`      | 7-40 lowercase hex digits.                                          |
| `pipelineUrl` | Optional, `http(s)` URL, at most 2048 characters. Shown as a link.  |

The field is still called `app` so that pipelines already in the field keep
working; its value is the **component key** (see below).

The tag CI produces is `origin-<branch with / replaced by ->-<shorthash>`; the
Panel only checks the regex above.

Responses:

| Status | Meaning                                                                                      |
| ------ | -------------------------------------------------------------------------------------------- |
| `403`  | CSRF guard: the request had no `Content-Type: application/json`.                            |
| `413`  | Body larger than 16 KiB (checked before anything else in the hook, including the 503).      |
| `503`  | `DEPLOY_REGISTRY` is not set.                                                                |
| `401`  | Unknown app, missing or malformed signature header, or wrong signature. Identical body for all. |
| `400`  | Body is not JSON, or a field is invalid (fields are checked after the signature).            |
| `202`  | Accepted: `{"buildId": "...", "created": true\|false, "deploymentIds": ["..."]}`             |

Nothing is recorded on a `401`. A body that is not JSON is `400` before the
signature is looked at, so it carries no information about apps.

### Replays

Builds are idempotent per `(app, tag)`:

- The **first delivery wins.** A replay for the same tag returns `202` with
  `created: false`, the existing `buildId` and an empty `deploymentIds`.
- A replay with a different `branch` or `commit` for the same tag is ignored;
  the stored build is not changed.
- A replay **never re-triggers deployments.** CI can retry the notification
  freely, but if an auto deployment was lost (for example one target failed to
  queue, which is logged and does not stop the others), redeploy that tag
  manually from the Panel.

## The bundle image

Each component has a `bundleImage` (registered with `dist/deploy-app.js`). The
deploy pulls `<DEPLOY_REGISTRY>/<bundleImage>:<tag>`.

Convention:

- Built `FROM scratch`, with the files laid out **exactly as they should appear
  in the deploy dir**, under `/bundle/`.
- The deploy extracts it with `docker create <img> noop`, `docker cp
  <cid>:/bundle/. <deployDir>/`, `docker rm <cid>`. Files in the bundle
  overwrite files of the same name in the deploy dir.
- The base compose file is always named `compose.yaml`. The Panel may write a
  second one next to it, `compose.menara.yaml` (see below); a bundle must not
  contain that name either.
- The bundle must **never** contain `compose.override.yaml` or `.env`. Those are
  server-only, and `docker cp` would overwrite the server's copy.
- The compose file must take its image tags from the target's tag variable
  (default `IMAGE_TAG`), because that is the one value the Panel writes to
  `.env`.

Minimal `Dockerfile.bundle`:

```dockerfile
FROM scratch
COPY deploy/compose.yaml /bundle/compose.yaml
# Add other files the deploy dir needs, e.g.:
# COPY deploy/config/ /bundle/config/
```

The image never runs, so it needs no entrypoint; the Panel passes the dummy
command `noop` to `docker create` only because a scratch image has none.

- **Build bundles in CI, never from a Windows-style checkout.** A laptop with
  `core.autocrlf=true` writes CRLF files, and `git archive` applies the same
  conversion; use `git -c core.autocrlf=false archive <commit> …` when a bundle
  has to be built by hand (e.g. backfilling a tag that predates the pipeline).
- **Only the target's services restart.** A deploy runs `up -d --no-deps` for
  the target's services (for membership: `membership-backend` and
  `membership-frontend`). Config files the bundle carries for other services
  (membership's Prometheus, Loki, Alloy, Tempo and Grafana files) land on disk
  but take effect only after `docker compose up -d <service>` by hand.

## Client note

Cloudflare in front of `panel.example.net` blocks some client signatures:
Python's `urllib` user agent gets **403 error code 1010** before reaching the
Panel. `curl` is accepted. Send notifications with `curl` (as below) or set a
normal `User-Agent`.

## Woodpecker example

Builds do not use the host `docker.sock`, need no `privileged` or `trusted`
pipeline, and go through a dedicated BuildKit daemon that `docker buildx`
reaches with the **remote** driver. Registry credentials are Woodpecker
org-level secrets (`registry_username`, `registry_password`). The notify secret
is the **repo** secret `menara_notify` (one per repository; see below).

On .113 the builder is the `buildkitd` service of the Woodpecker stack
(`/opt/woodpecker`, `moby/buildkit:v0.34.2-rootless`, network `ci-build`); the
agent attaches every step to `ci-build`, so `tcp://buildkitd:1234` resolves. Its
`buildkitd.toml` marks `192.168.10.113:5000` as plain HTTP. `docker login` needs
a daemon, so steps write `~/.docker/config.json` themselves. Working reference:
`acme-accounting` `.woodpecker.yaml` on `kestrel/development`. App images are built with the same builder and the same `TAG`
(`docker buildx build --provenance=false --output type=registry,oci-mediatypes=false -t <registry>/<image>:$TAG ...`;
Docker media types, because Podman ignores HEALTHCHECK in OCI images).

```yaml
steps:
  - name: build
    image: docker:29-cli
    environment:
      REGISTRY: 192.168.10.113:5000
      REGISTRY_USERNAME:
        from_secret: registry_username
      REGISTRY_PASSWORD:
        from_secret: registry_password
    commands:
      # One TAG for build and notify; the notify step reads it from the workspace.
      - TAG="origin-$(echo "$CI_COMMIT_BRANCH" | tr / -)-$(echo "$CI_COMMIT_SHA" | cut -c1-7)"
      - echo "$TAG" > .tag
      - docker buildx create --name remote --driver remote tcp://buildkitd:1234 --use
      - echo "$REGISTRY_PASSWORD" | docker login "$REGISTRY" -u "$REGISTRY_USERNAME" --password-stdin
      # App image(s) first, with the same builder and tag, e.g.:
      # - docker buildx build --provenance=false --output type=registry,oci-mediatypes=false -t $REGISTRY/myapp:$TAG .
      - docker buildx build --provenance=false --output type=registry,oci-mediatypes=false -t "$REGISTRY/myapp-bundle:$TAG" -f Dockerfile.bundle .

  - name: notify-menara
    image: alpine:3
    environment:
      MENARA_URL: https://panel.example.com
      MENARA_NOTIFY_SECRET:
        from_secret: menara_notify
    commands:
      # The base image has neither curl nor the openssl binary.
      - apk add --no-cache curl openssl
      - TAG=$(cat .tag)
      - |
        printf '{"app":"myapp","branch":"%s","tag":"%s","commit":"%s","pipelineUrl":"%s"}' \
          "$CI_COMMIT_BRANCH" "$TAG" "$(echo "$CI_COMMIT_SHA" | cut -c1-7)" "$CI_PIPELINE_URL" > body.json
      - SIG=$(openssl dgst -sha256 -hmac "$MENARA_NOTIFY_SECRET" -hex < body.json | sed 's/^.* //')
      - |
        curl -fsS -X POST "$MENARA_URL/api/deploy-hooks/builds" \
          -H 'Content-Type: application/json' \
          -H "X-Menara-Signature: sha256=$SIG" \
          --data-binary @body.json
    when:
      event: push
```

Notes:

- The `printf` JSON is safe only because the `branch`, `tag` and `commit`
  patterns exclude quotes and backslashes. Do not add free-text fields this way.
- Sign the file you send: `--data-binary @body.json` sends the bytes unchanged,
  whereas `-d` would strip newlines and break the signature.
- Notify only after the push succeeded, since the Panel starts deploying as soon
  as it accepts the notification.
- `alpine:3` has no `curl` or `openssl`, hence the `apk add` (a per-run
  download; bake an image with both if that matters).
- **Required:** turn on Woodpecker's "cancel previous pipelines" for `push`
  events on every branch a target deploys from (repository settings). The Panel
  orders auto deploys by when it receives the notification, not by commit. If
  two pipelines of one branch run side by side and the older one finishes last,
  its build is notified last and **auto-deploys last**: the environment then
  runs the older commit while every status is green. Recover with a manual
  deploy of the newest build from the Panel.

## Services and CI connections

- A **service** (stored as a component) is one buildable, deployable unit of a
  repository, with its build spec (bundle image). A repository may hold
  several services. A service is addressed by its **component key**
  everywhere: the hook's `app` field, the Woodpecker secret name, the registry
  image and the deploy target.
- A **CI connection** is one configured instance of a CI provider on a forge
  (today: "Woodpecker – Bitbucket"). Each service points to one connection.
- A **project** has a set of services (its Sources). An **environment** of the
  project deploys any of them, one deploy target per service; services that
  used to belong to different apps can share an environment. Adding a target
  makes its service one of the project's services; a service a target uses
  cannot be removed from the project (`409 sourceInUse`).
- Apps are retired: services are registered without one. Older components
  keep their app row until a later release drops it; nothing reads it for
  deploys.

## Registering a component and a target

**Service** (by an operator with database access to the Panel; the admin UI
registers services too):

```sh
docker exec menara-app bun dist/deploy-app.js create <componentKey> <bundleImage> \
  --repo <owner/name> [--ci <connection name>]
docker exec menara-app bun dist/deploy-app.js rotate <componentKey>
```

`create` registers the service, without an app. `--app <appKey>` is still
accepted by `create` and `create-artifact` so older runbooks keep working, but
it is deprecated and ignored (the command prints a warning). `--ci` may be omitted when exactly one CI connection
exists; otherwise the command exits with status 2 and lists the connection
names. It prints a random notify secret to stdout, once. The secret is
stored encrypted (`enc:v1:`); the Panel cannot show it again. Put it in the
Woodpecker repo secret `menara_notify` of that service's repo. A repository's
later services (registered in the admin UI or with `create-artifact`) read
their own secret, `menara_notify_<key with - as _>`, so registering one never
overwrites another's. Pipe stdout
straight into the Woodpecker API instead of printing it. `rotate` issues a new
secret and invalidates the old one at once. `<bundleImage>` is a lowercase
repository path without registry or tag (for example `acme/myapp-bundle`).

**Target** (per environment, in the Panel UI on the environment's deploy page;
maintainers only): server, source branch, auto deploy on or off, deploy dir,
services, tag variable, optional pre-start command, optional health URL, health
timeout, back up before deploy. Viewing is open to any project role; deploy and
rollback are maintainer-only. A service has at most one target per environment.

**Admin API** (session-authenticated, used by the Panel UI; not for CI): the
per-component routes under `/api/apps/<appKey>/components/<componentKey>/…`
(`build`, `builds/active`, `rotate-secret`, `commit-pipeline-file`), `POST
/api/apps` and `GET /api/apps/pipeline-preview` were removed. They live under
`/api/service-catalog`, addressed by the key alone:
`/api/service-catalog/<componentKey>/…`, `POST /api/service-catalog` (body
`{"services": [...]}`) and `GET /api/service-catalog/pipeline-preview`. The
build hook above is unchanged.

## What a deploy does

Code: `lib/deploy/script.ts` (the server-side script), `lib/jobs/deploy.ts`
(the worker). The script runs as one `sh` script over SSH, with `set -eu`, in
the deploy dir:

Before the script is sent, the worker takes the optional database backup
(if "back up before deploy" is on). It runs in the worker, not in the script;
if it fails, the deploy fails before any SSH deploy command runs.

The script first ignores `SIGHUP` and `SIGPIPE` (so it keeps going if the
Panel's SSH session drops mid-deploy, rather than dying between removing an old
container and starting its replacement), changes into the deploy dir and takes
the lock `.menara-deploy.lock` there with `flock`. If another deploy script
still holds it after 600 s, it prints `DEPLOY LOCKED` and exits non-zero
without touching anything.

Then it does, in order:

1. `docker pull` the bundle image, extract `/bundle/.` into the deploy dir.
2. Set `<TAG_VARIABLE>=<tag>` in `.env` (replace the existing line, or append).
   No other `.env` line is touched.
3. `docker compose pull` the target's services.
4. Run the pre-start command, if any.
5. `docker compose up -d --no-deps` for the target's services only.
6. Wait for health (below).

Deploys never run `docker compose down`, never restart services outside the
target's list, and never touch Postgres.

`preStartCommand` is a single line (at most 500 characters) entered by a
maintainer and inserted verbatim. It runs in a **subshell**: an `export`, `cd`
or variable assignment inside it does not affect later steps, and an `exit`
only ends the subshell. A non-zero status aborts the deploy.

### Compose overlay for a shared database network

When an environment's `.env` is managed by the Panel and its database is
**shared** with a database host that has a Docker `network` recorded (on the
same server), the Panel writes `compose.menara.yaml` next to `compose.yaml`
and adds `COMPOSE_FILE=compose.yaml:compose.menara.yaml` to the managed
`.env`, so Compose merges both. The overlay gives every service of every deploy
target in that deploy dir `networks: [default, <network>]` and declares
`<network>` as `external: true`; a service keeps any network its own
`compose.yaml` declares. `COMPOSE_FILE` turns off Compose's automatic merge
of `compose.override.yaml`, so when the server has one the deploy script lists
it in the installed line: `COMPOSE_FILE=compose.yaml:compose.override.yaml:compose.menara.yaml`.

It is staged next to the `.env` (per deployment, mode 0600) and installed in
the same step, after the bundle is extracted. The previous file is kept as
`compose.menara.yaml.menara-prev`; if the `.env` install fails, the previous
overlay is put back. When the managed environment no longer needs it (
another database kind, no network), the next deploy removes
`compose.menara.yaml` (kept as `-prev`) and writes no `COMPOSE_FILE` line.
Do not edit it by hand; the next deploy overwrites it.

### Health

A deploy succeeds only if, for a continuous 30 seconds, every container of
every target service is:

- `running`,
- `healthy`, or has no healthcheck,
- unchanged since the previous poll (`RestartCount` and `StartedAt` equal, so a
  crash loop under a restart policy is caught even though it reads `running`),

and the health URL, if set, answers with an HTTP status below 400 (`curl -f`, checked every 5 s, 5 s timeout). Any
failing poll restarts the 30 s window. All of this must happen within
`healthTimeoutSeconds` (60 to 900, default 180; the cap keeps the wait well
inside the 20-minute limit on the whole script); otherwise the script prints
`HEALTH TIMEOUT` and exits non-zero.

### Failure and rollback

A failed deploy stays failed: the deployment and its run are marked `failed`,
and there is **no automatic rollback**.

The page shows the target's **current tag**: the tag of the latest deployment
whose script was sent to the server (the worker records `script_started_at`
just before it does), whatever its outcome. A deployment that failed before
that point (a failed backup, say) never touched the server and does not change
it. When that latest deployment failed, the page says so — the server may be
running that tag, half-started — and the tag stays deployable, so it can be
retried.

**Rollback** creates a new deployment of the **previous tag**: the latest
successful tag other than the current one. After T0 ok, T1 ok, T2 failed, the
current tag is T2 (failed) and Rollback deploys T1. Database migrations the
failed version ran are **not** reverted; a rollback only redeploys the old
images and bundle.

### Queueing and liveness

- At most one deployment runs per environment. Another one waits and is retried
  every 15 s.
- A new `auto` deployment supersedes older **queued** `auto` deployments of the
  same target (status `superseded`). Manual and rollback deployments are not
  superseded. A running deployment is never cancelled.
- The worker records a heartbeat every minute. A `running` deployment with no
  heartbeat for 5 minutes is failed by the stale sweep (on worker start, and
  whenever a deploy finds its environment busy), and its run is failed too. A
  redelivered job for a deployment that was already running is failed rather
  than re-run, since the server state is unknown.
- The whole script has a 20 minute wall-clock limit. When the Panel gives up
  (timeout, Panel restart), the script may keep running on the server; the
  deploy-dir lock keeps the next deploy from overlapping it.

## Server prerequisites

- The target's SSH user can run `docker` **without sudo** and can write the
  deploy dir.
- `flock` (util-linux) is installed.
- The deploy dir is an absolute path at least two levels deep (for example
  `/opt/myapp`), with no empty, `.` or `..` segment.
- Docker Engine with the Compose plugin (`docker compose`). Podman hosts are not
  supported in this phase.
- The server can pull from `DEPLOY_REGISTRY` (logged in, or the registry is
  trusted/insecure as configured on that host).
- `.env` in the deploy dir is **placed by hand** with every deploy-time value:
  `DOCKER_REGISTRY` (used by `compose.yaml` to name the app images) and every
  app-specific variable. The Panel adds or updates only the tag variable.
- `compose.override.yaml`, if needed, lives only on the server. Compose merges
  it automatically (with the database-network overlay, the Panel's
  `COMPOSE_FILE` line lists it; see above).
- The deploy dir contains the compose project the target's `services` belong to.

## Release checklist

1. Set `DEPLOY_REGISTRY` (and `DEPLOY_REGISTRY_USERNAME`/`PASSWORD`/`SCHEME`
   for an authenticated plain-HTTP registry) in the instance `.env`
   (`/opt/<name>/.env`).
2. Update the Panel to a release that contains the deploy feature. The
   `migrate` service applies pending migrations before the app starts.

Updating production needs Romi's go-ahead.

## Instance configuration

Values an instance sets for itself, outside any app's `.env`:

- `ACCESS_DEFAULT_POLICY_NAME` (instance `.env`): the Cloudflare Access policy
  the New environment wizard preselects when the copy source has none, matched
  by name, case-insensitively. Unset: no policy is preselected and the wizard
  asks for one. Both compose files (`compose.yaml`, `ops/install/compose.yaml`)
  pass it through to the app container, and `install.sh` adopts it from an
  older `.env`.
- `BRAND` (instance `.env`): an unknown value no longer fails boot; the app
  logs one warning and uses the `default` brand.
- Assistant organisation context (Admin → Assistant): a paragraph about the
  organisation and its business that the code assistant and its drafts get in
  their system prompt. Empty: a generic description is used.

## Upgrading to strong sign-in

- Sessions created before the upgrade have no recorded sign-in method and count
  as weak, so privileged users sign in again once. Microsoft and passkey users
  just sign in again; password users set up an authenticator (Account →
  Security) or sign in with a passkey or Microsoft.
- Rolling back to an older image makes users who enrolled TOTP sign in with the
  password alone, because the old build ignores the second factor. Roll forward
  again to enforce it.
- After the deploy, check that Microsoft sign-ins are recorded as such, not as
  null:

  ```sql
  select sign_in_method, count(*) from sessions
  where created_at > '<deploy time>' group by 1;
  ```

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
- `X-Opsdeck-Signature: sha256=<hex>`, where `<hex>` is the HMAC-SHA256 of the
  **exact raw request body** under the app's notify secret, 64 lowercase or
  uppercase hex digits. Sign the same bytes you send; do not re-serialise.

Body (JSON, at most 16 KiB):

| Field         | Rule                                                                |
| ------------- | ------------------------------------------------------------------- |
| `app`         | App key, `^[a-z0-9][a-z0-9-]{0,63}$`. Must be a registered app.     |
| `branch`      | `^[A-Za-z0-9][A-Za-z0-9/_.-]{0,199}$`, no `..`.                     |
| `tag`         | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`, never `latest` (any casing).  |
| `commit`      | 7-40 lowercase hex digits.                                          |
| `pipelineUrl` | Optional, `http(s)` URL, at most 2048 characters. Shown as a link.  |

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

Each app has a `bundleImage` (registered with `scripts/deploy-app.ts`). The
deploy pulls `<DEPLOY_REGISTRY>/<bundleImage>:<tag>`.

Convention:

- Built `FROM scratch`, with the files laid out **exactly as they should appear
  in the deploy dir**, under `/bundle/`.
- The deploy extracts it with `docker create <img> noop`, `docker cp
  <cid>:/bundle/. <deployDir>/`, `docker rm <cid>`. Files in the bundle
  overwrite files of the same name in the deploy dir.
- The compose file is always named `compose.yaml`.
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

## Woodpecker example

Builds do not use the host `docker.sock`, need no `privileged` or `trusted`
pipeline, and go through a dedicated BuildKit daemon that `docker buildx`
reaches with the **remote** driver. Registry credentials are Woodpecker
org-level secrets (`registry_username`, `registry_password`). The notify secret
is the org secret `opsdeck_notify_<appKey>` (see below).

The BuildKit address `tcp://buildkitd:1234` below is a **placeholder**; plan C
finalises it. App images are built with the same builder and the same `TAG`
(`docker buildx build --push -t <registry>/<image>:$TAG ...`).

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
      # - docker buildx build --push -t $REGISTRY/myapp:$TAG .
      - docker buildx build --push -t "$REGISTRY/myapp-bundle:$TAG" -f Dockerfile.bundle .

  - name: notify-opsdeck
    image: alpine:3
    environment:
      OPSDECK_URL: https://panel.example.com
      OPSDECK_NOTIFY_SECRET:
        from_secret: opsdeck_notify_myapp
    commands:
      # The base image has neither curl nor the openssl binary.
      - apk add --no-cache curl openssl
      - TAG=$(cat .tag)
      - |
        printf '{"app":"myapp","branch":"%s","tag":"%s","commit":"%s","pipelineUrl":"%s"}' \
          "$CI_COMMIT_BRANCH" "$TAG" "$(echo "$CI_COMMIT_SHA" | cut -c1-7)" "$CI_PIPELINE_URL" > body.json
      - SIG=$(openssl dgst -sha256 -hmac "$OPSDECK_NOTIFY_SECRET" -hex < body.json | sed 's/^.* //')
      - |
        curl -fsS -X POST "$OPSDECK_URL/api/deploy-hooks/builds" \
          -H 'Content-Type: application/json' \
          -H "X-Opsdeck-Signature: sha256=$SIG" \
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

## Registering an app and a target

**App** (once per application, by an operator with database access to the
Panel):

```sh
bun --conditions react-server scripts/deploy-app.ts create <appKey> <bundleImage>
bun --conditions react-server scripts/deploy-app.ts rotate <appKey>
```

`create` registers the app and prints a random notify secret to stdout, once. It
is stored encrypted (`enc:v1:`); the Panel cannot show it again. Put it in the
Woodpecker org secret `opsdeck_notify_<appKey>`. `rotate` issues a new secret
and invalidates the old one at once. `<bundleImage>` is a lowercase repository
path without registry or tag (for example `dss/myapp-bundle`).

**Target** (per environment, in the Panel UI on the environment's deploy page;
maintainers only): server, source branch, auto deploy on or off, deploy dir,
services, tag variable, optional pre-start command, optional health URL, health
timeout, back up before deploy. Viewing is open to any project role; deploy and
rollback are maintainer-only. An app has at most one target per environment.

## What a deploy does

Code: `lib/deploy/script.ts` (the server-side script), `lib/jobs/deploy.ts`
(the worker). The script runs as one `sh` script over SSH, with `set -eu`, in
the deploy dir:

Before the script is sent, the worker takes the optional database backup
(if "back up before deploy" is on). It runs in the worker, not in the script;
if it fails, the deploy fails before any SSH deploy command runs.

The script then does, in order:

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

### Health

A deploy succeeds only if, for a continuous 30 seconds, every container of
every target service is:

- `running`,
- `healthy`, or has no healthcheck,
- unchanged since the previous poll (`RestartCount` and `StartedAt` equal, so a
  crash loop under a restart policy is caught even though it reads `running`),

and the health URL, if set, answers with an HTTP status below 400 (`curl -f`, checked every 5 s, 5 s timeout). Any
failing poll restarts the 30 s window. All of this must happen within
`healthTimeoutSeconds` (60 to 3600, default 180); otherwise the script prints
`HEALTH TIMEOUT` and exits non-zero.

### Failure and rollback

A failed deploy stays failed: the deployment and its run are marked `failed`,
and there is **no automatic rollback**. A maintainer rolls back from the UI,
which creates a new deployment of the target's previous successful tag. Database
migrations the failed version ran are **not** reverted; a rollback only
redeploys the old images and bundle.

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
- The whole script has a 20 minute wall-clock limit.

## Server prerequisites

- The target's SSH user can run `docker` **without sudo** and can write the
  deploy dir.
- Docker Engine with the Compose plugin (`docker compose`). Podman hosts are not
  supported in this phase.
- The server can pull from `DEPLOY_REGISTRY` (logged in, or the registry is
  trusted/insecure as configured on that host).
- `.env` in the deploy dir is **placed by hand** with every deploy-time value:
  `DOCKER_REGISTRY` (used by `compose.yaml` to name the app images) and every
  app-specific variable. The Panel adds or updates only the tag variable.
- `compose.override.yaml`, if needed, lives only on the server. Compose merges
  it automatically.
- The deploy dir contains the compose project the target's `services` belong to.

## Release checklist

1. Apply the migrations by the hand procedure in the opsdeck memory
   `db-migrations.md`: `pg_dump` first, a `ROLLBACK` dry run, then apply
   `20261104000000` and then `20261104000100`, and add rows for both to that
   memory's table.
2. Set `DEPLOY_REGISTRY` in `/deployments/dss-panel/.env`.
3. Deploy the Panel.

Stop here: applying migrations to production and deploying the Panel need
Romi's go-ahead, and the prerequisites of Plan B (CI bundle images, server
`.env` files, registered apps) must be done first.

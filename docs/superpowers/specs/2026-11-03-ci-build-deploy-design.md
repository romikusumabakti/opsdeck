# Build with Woodpecker, deploy with DSS Panel — design

Date: 2026-11-03. Status: approved by Romi 2026-11-03.
Scope: phase 1 = the six Sucor apps. Touches opsdeck (this repo), the Sucor app repos, and host `panel` (192.168.56.113).

## Why

Jenkins on .113 is the CI/CD for ~114 jobs. Romi wants it gone, step by step:

- It is legacy and heavy: ~1.9 GB RSS idle, Groovy Jenkinsfiles, plugin upkeep, our own scripts for webhook secrets (`jpatch.py`) and build retention (`jdiscard.py`).
- Its deploy logic is fragile, and it has caused real incidents:
  - The deploy target is chosen by job name (`DEPLOY_SERVERS[env.JOB_BASE_NAME]`). After a folder move, a development image went to the wrong demo VM (2026-10-29), and four apps skipped Deploy silently with green builds.
  - A green build does not mean a deploy happened. You have to grep the console for `ssh root@`.
  - `docker compose down && up` means that aborting a deploy, or a failed `up`, leaves the stack down (demo VPS 2026-10-25).
  - Nobody can see which tag runs where. `/etc/ci-disk-maintenance/keep-tags` is a hand-made snapshot.
- DSS may move from Bitbucket Cloud to GitHub or self-hosted GitLab (long-term, no date), so nothing new may bind us to Bitbucket.

## Direction (decided)

- **Build: Woodpecker CI.** It is forge-agnostic: Bitbucket Cloud, GitHub, GitLab, Gitea and Forgejo are all core forges, and the pipeline YAML survives a forge move. A spike on 2026-11-03 proved it works with our Bitbucket workspace, at about 44 MB RAM idle. Build logic stays in each repo's Dockerfiles, so the CI layer stays thin and replaceable: if DSS moves to GitHub and prefers Actions, only a short YAML is rewritten.
- **Deploy: DSS Panel (opsdeck).** The Panel already models projects → environments → services → servers, already reaches servers over SSH, and already records operations as `runs` with streamed logs and RBAC. "Deploy" becomes a new run kind on that machinery.
- **The registry `192.168.56.113:5000` is the only handoff between build and deploy.** The Panel never needs git or forge access.

## Goals

1. Every push to a watched branch of a Sucor app builds images and pushes them to the registry, with no Jenkins involvement.
2. Development environments (Sucor dev `.56.129` and dev2 `.56.115`) auto-deploy every new build, as they do today, with no added delay QA would notice.
3. Demo environments are deployed only by a manual action in the Panel. These are Sucor demo `.55.138`, demo2 `.56.117`, and demo3 = VPS `103.54.170.47`.
4. For every environment, the Panel shows the tag currently running per app and the deploy history: who, when, which tag, result, and log.
5. A deploy can never leave an environment down because the deploy itself was interrupted. Rolling back to the previous tag is one action.
6. Jenkins Sucor jobs are disabled once their environment is cut over. Jenkins keeps running for the jobs out of scope.

## Non-goals (phase 1)

- Job folders other than `SUCOR` stay in Jenkins: DSS/dss-demo-* (phase 2), DPLK common, CAR, TMLI, DPSIU, and RELEASE-*. Decommissioning Jenkins is a later decision.
- No builds inside the Panel, and no Panel-side git access.
- No Kubernetes/Argo targets. The Sucor targets are Docker Compose hosts. The rootful-Podman host .136 is phase 2.
- No change to how apps run migrations: Flyway runs at app start.
- SonarQube, E2E and the archived-images stage of the membership Jenkinsfile are not carried over in phase 1. They are already commented out or unused for Sucor; to be verified per repo.
- No PR builds.

## Anti-goals (a failure even if it "works")

- An auto-deploy to a demo environment.
- A deploy path where a stopped/aborted deploy leaves Postgres or the app stopped.
- Anyone below project maintainer able to deploy or roll back.
- A design that needs Bitbucket-specific features (Bitbucket Pipelines, Bitbucket deployments API, Bitbucket-only webhooks into the Panel).
- Secrets written by the pipeline to servers. Server `.env` files stay hand-placed (0600) and survive deploys, and so does any server-only `compose.override.yaml`.
- Deploying `IMAGE_TAG=latest` (that tag is not in the registry).

## Constraints and facts the builder must respect

- **Apps, repos and branches (phase 1):**

  | App | Repo (Bitbucket `dss-consulting/…`) | Images |
  |---|---|---|
  | membership | `dplk-membership` | `dplk-membership-backend`, `dplk-membership-frontend` |
  | portal backend | `dplk-customer-portal-backend` | per its Jenkinsfile |
  | portal frontend | `customer-portal` | per its Jenkinsfile |
  | accounting | `dplk-accounting` | `dplk-accounting-backend`, `dplk-accounting-frontend` |
  | cms | `dplk-customer-portal-cms` | `cms-api`, `cms-web` (compose `compose.prod.yaml`) |
  | investment | `investment` (branch `sucor`) | `dplk-investment-app` (+ frontend per its compose) |

  Branch per environment today: dev/dev2 follow `sucor/development` (investment: `sucor`). The demo environments take membership and portal FE from `sucor/demo` and the rest from `sucor/development`. Source of truth: the Jenkinsfiles on those branches and `~/.claude/projects/-var-home-romi-dss/memory/jenkins-113.md`.
- **Tag format stays `origin-<branch with / → ->-<shorthash>`** (e.g. `origin-sucor-development-240c787`). `ci-disk-maintenance.sh` keeps the 10 newest tags per repo per branch by parsing this format.
- **What a deploy does today, to be preserved:**
  - `scp` the repo's compose file to `/deployments/<app>/`. Membership also copies `init_db.sql`, `prometheus.yml`, `config.alloy`, `loki-config.yaml`, `tempo-config.yaml` and `grafana/`.
  - Set `IMAGE_TAG=<tag>` in the server `.env` (accounting does `sed -i 's|^IMAGE_TAG=.*|…|' .env`).
  - Then `docker compose pull && up -d`.
  - The server-only `.env` and `compose.override.yaml` are never written by the pipeline. Server-only edits to `compose.yaml` are overwritten, and that is accepted.
- **Investment is special.** It is built once, and the same tag is then deployed to the five Sucor environments. Today Sucor gets investment from BOTH `sucor` and `main`: the `Deploy Sucor` stage of `DSS/dss-demo-investment` (branch `main`) triggers all five Sucor deploy jobs, demos included. **Decided:** Sucor environments follow `sucor` only. When investment is cut over, the `Deploy Sucor` stage is removed from the `main` Jenkinsfile, and `SUCOR_DEPLOY_JOBS` and `ci/Jenkinsfile.sucor-deploy` are retired. Its pipeline is heavy (static gates, native image, OWASP, ~20 min), and those gates move to Woodpecker with it. `compose.yaml` and `deploy/migrate/` are taken from the image's commit, not HEAD (see `investment/ci/Jenkinsfile.sucor-deploy`). The new design must keep "deploy files come from the image's commit" for every app.
- **Panel data today:** `environments` (with `host`, `url`, `kind`), `environment_services` (role db/backend/frontend, `service_type` docker/kubernetes/systemd, `service_name`, server), and `runs` (`kind` enum backup/restore/mock_time/test). Sucor membership and portal environments already exist. Accounting has only the VPS environment, and cms and investment dev environments are missing; they need to be added. Project roles are viewer/contributor/maintainer.
- **The Panel runs on .113** (compose project `dss-panel`, deployed by Jenkins job `DSS/dss-panel`, which stays on Jenkins). Its Postgres has no routine backup, 19 of 28 server passwords are stored without `enc:v1:` encryption, and `panel.dssconsulting.id` has no Cloudflare Access (see the opsdeck memory). Once the Panel deploys, all three must be fixed: see "Prerequisites".
- **The Woodpecker spike install** is at `/opt/woodpecker` on .113, served at `https://ci.dssconsulting.id`. Cloudflare Access app `ci-woodpecker` uses DSS Internal; `ci-woodpecker-hook` bypasses `/api/hook`. Woodpecker v3.20.1 with sqlite, Bitbucket OAuth client "Woodpecker CI", admin `romidss`. Its secret files must be readable by uid 1000. Production use reuses it after hardening (below).
- **Deploy-time values are not all in `.env` today.** Jenkins exports some at `compose up`:
  - investment: `DPLK_CLOCK_SIMULATION_ENABLED=true` on all five hosts, and `DPLK_COMPLIANCE_QUARTZ_ENABLED=true` on demo3 only (the compose file defaults both to false);
  - accounting: `FRONTEND_PORT=82` and `BACKEND_PORT=8082`;
  - every app: `DOCKER_REGISTRY`;
  - membership exports `IMAGE_TAG` without writing it to `.env` (the VPS membership `.env` still says `IMAGE_TAG=latest`).

  **Decided:** these values move once into each server's hand-placed `.env`, as part of that environment's cutover (back up the VPS first). The Panel only ever sets the image tag variable(s) and holds no app config. The cutover checklist per app must diff the Jenkinsfile exports against the server `.env`.
- **Portal specifics:** portal BE and FE share `/deployments/dplk-customer-portal` and one `.env`, with separate `BACKEND_IMAGE_TAG` and `FRONTEND_IMAGE_TAG`. Only the backend repo ships the compose file. Portal BE runs `docker compose --profile tools run --rm db-migrate` before `up`. Keep that as a per-app pre-start step (*Claude's call*). So per-app deploy config must allow a pre-start command and a named tag variable.
- **The VPS reaches the registry** through `registry-tunnel-103.54.170.47.service`, a reverse SSH tunnel and standalone root systemd unit on .113. It does not depend on Jenkins. Keep it.
- **Demo VPS rule:** take a backup before any change. The Panel already has a `backup` run kind.
- **Code language:** all identifiers, docs and logs in English. UI strings go in all five `messages/*.json` locales (ar/en/es/id/zh). The Panel stack is Bun, Hono, React, TanStack, Drizzle, Postgres and BullMQ/Valkey, and the new work follows it.

## How it works (decided parts)

### Build (Woodpecker)

- Each phase-1 repo gets a `.woodpecker.yaml` on its deploy branches. It builds the app images in parallel, pushes them with the tag format above, and also pushes a **deploy bundle** (see next section). It then notifies the Panel.
- Woodpecker watches pushes to `sucor/development`, `sucor/demo` and `sucor` (investment). Portal BE's existing audit/test/smoke stages move into its pipeline; they already run in plain containers. Building every push is fine. Whether a build is deployed, and where, is decided only by the Panel.
- **Builds do not mount the host `docker.sock`** (*Claude's call*: a docker.sock mount in a trusted repo is root on .113 for anyone who can edit a pipeline). Use a dedicated BuildKit daemon container next to Woodpecker, reached by `docker buildx` with the remote driver. Repos then need no "trusted" flag. Registry credentials are a Woodpecker org-level secret. The exact BuildKit wiring is left to the builder, as long as the build cache persists between builds.

### Deploy bundle (*Claude's call*)

The files a deploy copies (compose file, membership's observability configs, investment's `deploy/migrate/`) are packed at build time into a small image `<app>-deploy:<same tag>` in the same registry. Reasons:

- It guarantees the "deploy files come from the image's commit" rule for every app, as investment needs.
- It keeps the Panel free of git and forge credentials, so the Panel survives a forge move unchanged.

Each repo declares which paths go into its bundle. The bundle's layout and how the Panel extracts it on the target host are left to the builder; for example, `docker create` + `docker cp` on the target host via SSH.

### Build → Panel notification

- The last pipeline step POSTs to the Panel: app key, branch, tag, commit SHA, image names, Woodpecker pipeline URL. It is authenticated with an HMAC or bearer secret per app, stored as a Woodpecker secret and in the Panel.
- The endpoint must be reachable from Woodpecker on the same host. It must not depend on Cloudflare Access, and it needs no public route.
- The Panel records every received build, deployed or not, so a maintainer can pick any built tag later.

### Deploy (Panel)

- **Configuration per environment and app:**
  - App key
  - Source branch
  - Auto-deploy on/off (on only for dev/dev2)
  - Target server and deploy directory (`/deployments/<app>`)
  - Compose file name
  - Which compose services to update
  - Health check: container health and an optional URL
  - "Back up the DB before deploy" (default on for demo environments)
- **A deploy is a `runs` row with `kind=deploy`**, using the existing streamed output and audit. Deploy steps:
  1. Optional pre-deploy backup, using the existing backup run.
  2. Pull images and the bundle.
  3. Copy bundle files into the deploy directory.
  4. Set `IMAGE_TAG` in `.env`.
  5. `docker compose up -d` the app services.
  6. Wait for health.
  7. Record the result and the now-running tag.
- **No `compose down`** (*Claude's call*). Steps 2–4 change nothing that is running. Step 5 only replaces app containers, so interrupting a deploy at any point leaves either the old or the new version running. Postgres is never restarted by a deploy. Removing orphans and doing full restarts stay manual.
- **One deploy at a time per environment.** Concurrent requests queue. A newer auto-deploy supersedes a queued, not-yet-started older one. This also fixes "two pushes deploy at the same time", which the membership Jenkinsfile works around.
- **No automatic rollback on failed health** (*Claude's call*, changed from the earlier discussion). Flyway migrations are forward-only, so an automatic switch back to an older app could start it against a newer schema. A failed deploy is marked failed and surfaces in "Needs attention", and the maintainer gets a one-click **Rollback** (redeploy the previous successful tag) with a warning when a migration may be involved.
- **Permissions:** only project maintainers may deploy manually or roll back, on any environment. Everyone with project access sees running tags and history. Auto-deploys are attributed to the system with the build reference, not to a user.
- **Visibility:**
  - The environment page shows the running tag per app and the deploy history.
  - The Panel exposes the set of running tags so `ci-disk-maintenance` can stop relying on a hand-made keep-tags file. Wiring the script to it is optional in phase 1.

## Prerequisites before the Panel deploys anything

1. Cloudflare Access in front of `panel.dssconsulting.id`, keeping the build-notification endpoint reachable from Woodpecker on the same host.
2. A routine backup of the Panel Postgres (and Garage attachments).
3. All server credentials the deploy uses encrypted at rest (`enc:v1:`).
4. Woodpecker hardening:
   - Pin the version, and persist the agent and gRPC secrets (already done in the spike).
   - Switch to the BuildKit daemon, so no `docker.sock` is mounted in steps.
   - Decide `WOODPECKER_OPEN`: currently `true`, limited to the workspace `dss-consulting` and behind Access.
   - Remove the spike repo/branch/images.

## Cutover (per app, reversible) (*Claude's call*)

Building moves **per app, all environments at once**. Every Sucor Jenkins job both builds and deploys its branch, so a per-environment build overlap would have Jenkins and Woodpecker pushing the same tags. Because demos become manual-only in the Panel, no Jenkins deploy-only stage is needed after the switch.

Order of apps: accounting (the spike repo) → cms → portal BE + FE (together, shared deploy dir) → membership → investment (last; heaviest pipeline, and the `main` change above).

Per app:
1. Before the switch: add the Panel config for all five environments, with auto-deploy off. Build deploy bundles once for the tags currently running, since Jenkins-built tags have none. Move the deploy-time exports into each server `.env`.
2. Per environment, in order dev2 → dev → demo2 → demo → demo3, do one manual Panel deploy of the tag already running. This proves the path changes nothing. Demo3's Jenkins jobs are currently disabled pending a VPS backup, so take the backup first.
3. Switch: disable that app's five `SUCOR/sucor-*-<app>` Jenkins jobs, enable the Woodpecker pipeline, and turn on auto-deploy for dev and dev2.

Reverting an app: re-enable its Jenkins jobs and disable its Woodpecker pipeline. Same tag format, so the running tags remain valid.


## Left to the builder

- Bundle format and extraction; BuildKit wiring; Panel schema for deploy config, the received-builds table and the running-tag record.
- UI layout of deploy/rollback/history, within existing Panel patterns.
- Notification endpoint shape and secret scheme.
- How health is checked per service type (compose health status vs. URL).
- Per-repo pipeline details, including the portal FE/BE image names and cms services, taken from each Jenkinsfile.

# Sucor Apps Cutover Plan (plan D of the CI/deploy spec)

> **For agentic workers:** this plan is production operations plus a short pipeline file per repo, following the dplk-accounting pilot (plan C). The controller runs it inline. Every **[go-ahead]** step waits for Romi's explicit yes. Each repo's `.woodpecker.yaml` gets one fresh reviewer subagent before it is pushed.

**Goal:** Move the remaining Sucor apps to Woodpecker build and Panel deploy, one app at a time, then disable their `SUCOR/*` Jenkins jobs. The order is cms → portal backend + frontend → membership → investment.

**Spec:** `docs/superpowers/specs/2026-11-03-ci-build-deploy-design.md`. Contract: `docs/deploy.md`. Reference pipeline: `dplk-accounting` `.woodpecker.yaml` on `sucor/development`. Pilot record: DSS memory `woodpecker-113.md` and opsdeck memory `panel-deploy-feature.md`.

## Global Constraints

- **Same rules as plan C:**
  - Sucor push rules: a push to `sucor/development` deploys through every still-enabled Jenkins job.
  - VPS: office IP plus a backup first.
  - Never deploy `latest`.
  - No privileged, trusted or `docker.sock` in pipelines.
  - Secrets never printed.
  - Panel notify only with `curl` (Cloudflare blocks Python-urllib with 1010).
  - Woodpecker YAML: block scalars for commands, `$${VAR}` escapes.
- **Per-app pattern (from the pilot):**
  1. Activate the Woodpecker repo through the API: trusted off, cancel-previous on push, timeout 60, repo secret `opsdeck_notify` from `docker exec opsdeck-app bun dist/deploy-app.js create <appKey> <bundleImage>` piped into the API.
  2. `.woodpecker.yaml` builds the images and bundle on `tcp://buildkitd:1234`, then notifies the Panel.
  3. Backfill the bundle for each environment's running tag (host Docker on .113 from `git show <sha>:<files>`, then a signed `curl` notify), so the Panel can redeploy the running tag.
  4. Create Panel environments and targets by SQL (backup `dss_panel` first): dev/dev2 with auto-deploy on, demos with auto-deploy off and `backup_before_deploy` on.
  5. Romi runs one Panel deploy of the running tag per environment.
  6. Disable that environment's Jenkins job, then turn auto-deploy on (dev only).
- **Tag:** `origin-<branch with / → ->-<sha>`. The sha length matches what Jenkins used for that repo: 7 for cms, portal and membership, and **9 for investment** (live tag `origin-sucor-df4eb5f5a`). Before writing each pipeline, check the live tag lengths on the hosts.
- **Deploy-time values must be in each server `.env`** (spec decision, Panel holds no app config). Before a host's first Panel deploy, check these keys without printing their values, and add any that are missing after backing up `.env`:
  - cms: `DOCKER_REGISTRY` and `IMAGE_TAG` (Jenkins exported both).
  - membership: `DOCKER_REGISTRY`. Its `IMAGE_TAG` is `latest` in `.env` today on all four LAN hosts, and the Panel overwrites it on the first deploy.
  - investment: `DPLK_CLOCK_SIMULATION_ENABLED=true` (all five hosts) and `DPLK_COMPLIANCE_QUARTZ_ENABLED=true` (VPS only).
- **Panel targets:**
  - **cms:**
    - services `cms-api`, `cms-web`
    - tag variable `IMAGE_TAG`
    - deploy dir `/deployments/dplk-customer-portal-cms`
    - bundle = `compose.prod.yaml` copied to `/bundle/compose.yaml`
    - health `http://localhost:8001/health/ready`
  - **portal backend:**
    - services `customer-portal-backend`
    - tag variable `BACKEND_IMAGE_TAG`
    - deploy dir `/deployments/dplk-customer-portal`
    - bundle = `compose.yaml` + `migrate/init_db.sql`
    - pre-start `docker compose --profile tools run --rm db-migrate`
    - health `http://localhost:8000/health/ready`
    - It shares that deploy dir with the frontend.
  - **portal frontend:**
    - services `customer-portal-frontend`
    - tag variable `FRONTEND_IMAGE_TAG`
    - same deploy dir as the backend
    - **bundle is empty of compose files**: the backend repo owns `compose.yaml`, so the frontend bundle ships only a marker file (e.g. `/bundle/.frontend-bundle`). A frontend deploy must never overwrite the backend's compose.
    - no health URL (static nginx; container state + stability only)
    - Its build args stay as in the Jenkinsfile, including `VUE_APP_STATIC_TOKEN` (already in the repo; moving it to a secret is out of scope, noted).
  - **membership:**
    - services `membership-backend`, `membership-frontend`
    - tag variable `IMAGE_TAG`
    - deploy dir `/deployments/dplk-membership`
    - bundle = `compose.yaml`, `init_db.sql`, `prometheus.yml`, `config.alloy`, `loki-config.yaml`, `tempo-config.yaml`, `grafana/`
    - health `http://localhost:8080/actuator/health`
    - healthTimeoutSeconds 600 (start_period 100 s plus Flyway)
    - This replaces Jenkins' whole-stack `down && up`. Observability config changes then need a manual restart of those services. That is accepted per the spec (no `compose down`), and must be stated in `docs/deploy.md`.
  - **investment:**
    - services `investment-app`
    - tag variable `IMAGE_TAG`
    - deploy dir `/deployments/dplk-investment`
    - bundle = `compose.yaml` + `deploy/migrate/` laid out as `migrate/`, taken from the image's commit (the bundle is built in the same pipeline run, so it is that commit)
    - health: `docker exec`-style health is not supported, and 9091 is not published, so leave health URL null and rely on container health (the image has a HEALTHCHECK on `/actuator/health/liveness`)
    - healthTimeoutSeconds 900 (≈450 Flyway migrations on first boot)
- **Branches:**
  - Demo membership and portal frontend take `sucor/demo`, so the pipeline file must also exist on `sucor/demo` of those two repos.
  - Every other demo target takes `sucor/development`.
  - Investment uses `sucor`.
- **Order matters per host:** cms, portal backend and investment join membership's network (`dplk-membership_default`) and use its Postgres. A membership deploy no longer stops the stack, so the other apps keep running during it.

## Review Focus

1. **Portal frontend deploy overwriting the backend-owned `compose.yaml`** — must never happen (marker-only bundle). Check on dev2 after the first frontend deploy: the `compose.yaml` checksum is unchanged.
2. **Membership first Panel deploy on a host whose `.env` says `IMAGE_TAG=latest`.** The Panel must replace the line, not leave `latest`. Check the line after the deploy.
3. **Investment `main` still triggering Sucor deploys after cutover.** The `Deploy Sucor` stage must be removed from investment `main`'s Jenkinsfile (and `SUCOR_DEPLOY_JOBS`/`ci/Jenkinsfile.sucor-deploy` retired) in the same go-ahead as disabling those jobs. Otherwise a main push marks the DSS demo build UNSTABLE.
4. **A tag-length mismatch** (investment 9 characters) makes "deploy the running tag" impossible. Check the backfilled tag equals the live `.env` value byte for byte.
5. **cms has no migration step** (manual `db:push` per its runbook). The Panel deploy must not pretend to migrate; leave pre-start empty and note it.

---

### Task 1: cms (`dplk-customer-portal-cms`)
- [ ] Activate the Woodpecker repo and the Panel app `dplk-cms` (bundle `dplk-cms-deploy`); add the repo secret.
- [ ] Write `.woodpecker.yaml`: `docker buildx build -f apps/api/Dockerfile .` → `dplk-cms-api`, `-f apps/web/Dockerfile .` → `dplk-cms-web`, then the bundle (`compose.prod.yaml` → `/bundle/compose.yaml`). Get a reviewer pass.
- [ ] **[go-ahead]** Push to `sucor/development`. Watch the pipeline and check that the Panel build is recorded.
- [ ] Backfill bundles for the running tags: dev and dev2 `origin-sucor-development-0475e23`; demo and demo2 `…-312e643`. Check `DOCKER_REGISTRY`/`IMAGE_TAG` in each `.env`.
- [ ] Create the Panel envs and targets (project Sucor Customer Portal, or a new project "Sucor CMS"; Romi decides at the go-ahead).
- [ ] Romi deploys the running tag per env. Then disable the five `SUCOR/sucor-*-cms` jobs (demo3 is already disabled) and turn auto on for dev and dev2.

### Task 2: portal backend + frontend (together, shared deploy dir)
- [ ] Apps `dplk-customer-portal-backend` (bundle `dplk-customer-portal-backend-deploy`) and `dplk-customer-portal-frontend` (bundle `dplk-customer-portal-frontend-deploy`, marker only).
- [ ] Backend pipeline: run the audit and test steps the Jenkinsfile runs (`pnpm audit --prod --audit-level high`; `pnpm run check && typecheck && test` in `node:24-alpine`) before build.
- [ ] Frontend pipeline: the same build args as the Jenkinsfile. It also goes on `sucor/demo`.
- [ ] **[go-ahead]** Push the backend pipeline to `sucor/development`, then push the frontend pipeline to `sucor/development` and `sucor/demo`.
- [ ] Backfill the running tags. The backend is `…-6bd06c2` everywhere. The frontend differs per host: .115 `…-development-b7ba720`, .129 `…-development-6a461aa`, .138 `origin-sucor-demo-1b3513a`, .117 `origin-sucor-demo-846cbfb`. Check before relying on these.
- [ ] Targets per host in the existing project "Sucor Customer Portal". Romi deploys the running tags, and Review Focus 1 is checked. Then disable the ten `SUCOR/sucor-*-portal-{backend,frontend}` jobs and turn auto on for dev and dev2.

### Task 3: membership (`dplk-membership`)
- [ ] App `dplk-membership` (bundle `dplk-membership-deploy` with the observability files). The pipeline goes on `sucor/development` and `sucor/demo`. Drop the Jenkins "Archive Images" stage (`docker save` tarballs): the registry tag is the artifact. Note it.
- [ ] **[go-ahead]** Push to both branches.
- [ ] Backfill the running tags. The live tag comes from `docker inspect` of `dplk-membership-backend`, because `.env` says `latest`. Add `DOCKER_REGISTRY` to `.env` where it is missing.
- [ ] Targets in "Sucor Membership" (Dev 1, Dev 2, Demo, Dev = .117, Cloud = VPS). Romi deploys the running tag per env; check Review Focus 2. Then disable the `SUCOR/sucor-*-membership` jobs and turn auto on for dev and dev2.
- [ ] Update `docs/deploy.md`: a membership Panel deploy restarts only backend and frontend; observability config changes need `docker compose up -d <service>` by hand.

### Task 4: investment (`investment`, branch `sucor`)
- [ ] App `dplk-investment` (bundle `dplk-investment-deploy` with `compose.yaml` + `migrate/` from `deploy/migrate/`). The pipeline triggers on `sucor`, with a 9-character sha in the tag.
- [ ] Move `DPLK_CLOCK_SIMULATION_ENABLED=true` (all) and `DPLK_COMPLIANCE_QUARTZ_ENABLED=true` (VPS) into each `.env`, after backup.
- [ ] **[go-ahead]** These go together:
  - push the pipeline to `sucor`;
  - remove `Deploy Sucor` and `SUCOR_DEPLOY_JOBS` from investment `main`'s Jenkinsfile (push to `main` redeploys the DSS demo on .136, which is demo-only and fine);
  - disable the five `SUCOR/sucor-*-investment` deploy-only jobs and `SUCOR/sucor-investment`.
- [ ] Backfill the running tag `origin-sucor-df4eb5f5a` (Review Focus 4). Targets in "Sucor Investment" with healthTimeoutSeconds 900. Romi deploys the running tag per env; auto on for dev and dev2.

### Task 5: Close-out
- [ ] Do the VPS (demo3) for every app in one office session: back up the Postgres DBs and every app `.env`, create targets with backup-before-deploy, deploy the running tags, and check `flock` exists.
- [ ] Update the memories: `jenkins-113.md` (`SUCOR` folder fully off Jenkins), `sucor-dev-vms-129-115.md`, `demo-vps-103-54-170-47.md`, `woodpecker-113.md`, and opsdeck `panel-deploy-feature.md`.
- [ ] Next phase (separate spec decision): the `DSS/dss-demo-*` jobs on .136 (rootless Podman, needs `podman compose` support in the deploy script), then retire Jenkins once the CAR/TMLI/DPSIU owners decide.

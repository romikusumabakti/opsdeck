# Woodpecker Hardening and Accounting Pilot Plan (plan C of the CI/deploy spec)

> **For agentic workers:** this plan is mostly production operations on .113, the Sucor VMs and Bitbucket. The controller runs it inline. Every step marked **[go-ahead]** waits for Romi's explicit yes in the chat. The only code artefact (Task 3, `.woodpecker.yaml`) gets one fresh reviewer subagent before it is pushed.

**Goal:**
- Woodpecker builds without the host `docker.sock`, through a rootless BuildKit daemon.
- `dplk-accounting` becomes the first app built by Woodpecker and deployed by the Panel, on all five Sucor environments.
- Jenkins `SUCOR/sucor-*-accounting` jobs are disabled.

**Architecture:**
- **Builder.** A `moby/buildkit:v0.34.2-rootless` container named `buildkitd` runs on a dedicated Docker network `ci-build` on .113. It is not privileged; it uses the three `security-opt` flags upstream documents for rootless BuildKit in Docker. Its cache lives in a named volume, and it reaches the plain-HTTP registry `192.168.56.113:5000` through `buildkitd.toml`.
- **Agent wiring.** The Woodpecker agent attaches every step container to `ci-build` (`WOODPECKER_BACKEND_DOCKER_NETWORK=ci-build`). Steps run `docker buildx` with the `remote` driver at `tcp://buildkitd:1234`. No step mounts the host socket, and repos are not trusted.
- **Pipeline.** The accounting pipeline builds the backend, frontend and deploy-bundle images with one shared tag `origin-<branch with / → ->-<sha7>`. It then notifies the Panel at `https://panel.dssconsulting.id/api/deploy-hooks/builds`, which is the Access bypass path, with an HMAC signature.
- **Panel side.** The Panel has the deploy app `dplk-accounting` and one deploy target per environment. Auto-deploy is on only for dev (.129) and dev2 (.115).

**Spec:** `docs/superpowers/specs/2026-11-03-ci-build-deploy-design.md`. Contract: `docs/deploy.md`. Previous plans: A (Panel deploy, released 2026-11-04) and B (prerequisites, done 2026-11-04).

## Global Constraints

- **Sucor rules (`~/dss/CLAUDE.md`):**
  - A push to `sucor/development` auto-deploys through Jenkins to .129 and .115 while those jobs are enabled, so push only after Romi's explicit yes.
  - .129 and .115 have separate databases.
  - The demo VPS 103.54.170.47 needs Romi's go-ahead plus a backup before any change, and SSH to it works only from the office IP.
  - `IMAGE_TAG=latest` is never deployed.
- **Fixed facts (checked 2026-11-04):**
  - The accounting compose services are `accounting-backend` and `accounting-frontend`. Images are `${DOCKER_REGISTRY}/dplk-accounting-{backend,frontend}:${IMAGE_TAG}`.
  - .115 and .129 run tag `origin-sucor-development-debb0af`. Their `/deployments/dplk-accounting/compose.yaml` matches `origin/sucor/development` byte for byte.
  - Their `.env` already contains `DOCKER_REGISTRY`, `IMAGE_TAG`, `FRONTEND_PORT` and `BACKEND_PORT`, so no Jenkins export needs moving for dev and dev2.
  - `flock` exists on .115, .129, .138 and .117.
  - Bitbucket repo: `dss-consulting/dplk-accounting`. HEAD of `sucor/development` is `3b5489b`.
  - The Woodpecker repo for accounting is active and was trusted (volumes) during the spike.
- **Tag rule:** the tag is `origin-${CI_COMMIT_BRANCH//\//-}-${CI_COMMIT_SHA:0:7}`. It must be byte-identical to what Jenkins produced for the same commit, so cutover tags stay valid.
- **Bundle:** `dplk-accounting-deploy:<tag>`, `FROM scratch`, containing only `/bundle/compose.yaml`. Never `.env` and never `compose.override.yaml`.
- **Secrets:**
  - Woodpecker org secrets `registry_username`, `registry_password` (the htpasswd account Jenkins uses: credential `registry-credentials-id`, or `/root/.docker/config.json` on .113) and `opsdeck_notify_dplk-accounting`.
  - Values are never printed. They go from file or stdin straight into the Woodpecker API.
- **No `trusted` flag, `privileged` step or `docker.sock` mount** in any pipeline after Task 2.

## Review Focus

1. **The first Woodpecker build of a commit Jenkins already built** (`debb0af`). Woodpecker re-pushes the same tag. The images must be equivalent, and the Panel must record the build so a manual deploy of the running tag is possible. Check: Task 4.
2. **Two pushes in quick succession on `sucor/development`.** Woodpecker must cancel the older pipeline ("cancel previous pipelines" on push), so an older build never auto-deploys last. Check: Task 3 repo setting and Task 6.
3. **The Panel down or Access misconfigured when CI notifies.** The notify step fails visibly (red pipeline) but the images are pushed. A replay after the Panel recovers is idempotent. Check: Task 3 step design.
4. **A step that tries to reach the host Docker daemon.** It must fail, because there is no socket. Check: Task 2 probe.
5. **Cutover of one environment leaves Jenkins also deploying it.** For each environment, the Jenkins job is disabled in the same step that enables Panel auto-deploy. Check: Task 6 ordering.

---

### Task 1: Inputs from Romi [go-ahead]

- [ ] Romi creates a Woodpecker personal access token (Woodpecker UI → user settings → Personal access token) and saves it to `~/.config/secrets/dss/woodpecker-token` (0600).
- [ ] Romi creates two environments in the Panel project "Sucor Accounting": "Dev 1" and "Dev 2". Each has `accounting-backend`/`accounting-frontend` services on server .129 or .115 respectively, and a db service matching the membership environments on the same host. This lets the deploy target pick that server. The existing "Sucor Acconuting Demo" (VPS) environment stays as it is. Environments for .138 and .117 come in Task 7.

### Task 2: Rootless BuildKit on .113 and agent wiring [go-ahead]

- [ ] Create `/opt/woodpecker/buildkitd.toml` with the registry stanza:

  ```toml
  [registry."192.168.56.113:5000"]
    http = true
  ```

- [ ] Add a service `buildkitd` to `/opt/woodpecker/compose.yaml`:
  - image `moby/buildkit:v0.34.2-rootless`, `restart: unless-stopped`
  - `security_opt: [seccomp=unconfined, apparmor=unconfined, systempaths=unconfined]`
  - command `--addr tcp://0.0.0.0:1234 --config /home/user/.config/buildkit/buildkitd.toml`
  - the toml mounted read-only
  - volume `buildkit-cache:/home/user/.local/share/buildkit`
  - network `ci-build` only, with no published port
- [ ] Give the agent `WOODPECKER_BACKEND_DOCKER_NETWORK: ci-build`, and declare the network `ci-build` with `name: ci-build`, so step containers can resolve `buildkitd`.
- [ ] Run `docker compose up -d`. Then check:
  - `docker exec woodpecker-buildkitd-1 buildctl --addr tcp://127.0.0.1:1234 debug workers` lists a worker.
  - `id` inside the container shows uid 1000.
- [ ] **Probe pipeline** (Review Focus 4). On the spike branch `spike/woodpecker` of dplk-accounting, replace `.woodpecker.yaml` with a probe that checks three things:
  - A buildx remote build of the backend reaches the registry under `spike/`.
  - `docker ps` fails in a step with no socket.
  - The repo's `trusted` flag is turned off before the run.
- [ ] Remove the spike's `docker.sock` dependence from the docs and memory (`woodpecker-spike-113.md`).

### Task 3: Accounting pipeline file (code, reviewed) [push needs go-ahead]

**File:** `dplk-accounting/.woodpecker.yaml` on a worktree branch from `origin/sucor/development`.

- [ ] Triggers: `event: [push, manual]` on branches `sucor/development` and `sucor/demo`.
- [ ] Step `build` (image `docker:29-cli`):
  1. Compute `TAG` and write it to `.tag`.
  2. Write `~/.docker/config.json` from `registry_username`/`registry_password`, because `docker login` needs a daemon.
  3. Run `docker buildx create --name remote --driver remote tcp://buildkitd:1234 --use`.
  4. Build and push the backend (`backend/`) and the frontend (`frontend/`, `--build-arg VUE_APP_API_URL=/api`) with `docker buildx build --push`.
  5. Build and push the bundle from an inline `FROM scratch` / `COPY compose.yaml /bundle/compose.yaml` Dockerfile.
- [ ] Step `notify` (image `alpine:3` with curl and openssl):
  - Build `body.json` with `app=dplk-accounting`, branch, tag from `.tag`, commit, and `pipelineUrl=${CI_PIPELINE_FORGE_URL}`.
  - Compute the signature with `openssl dgst -sha256 -hmac` over the exact file.
  - Send `curl -fsS -H 'Content-Type: application/json' -H "X-Opsdeck-Signature: sha256=…" --data-binary @body.json https://panel.dssconsulting.id/api/deploy-hooks/builds`. A non-2xx response fails the step.
- [ ] Woodpecker repo settings through the API: `trusted` off; cancel previous pipelines on `push`; pipeline timeout 60 min. Then add the three org or repo secrets through the API.
- [ ] Panel: `docker exec opsdeck-app bun dist/deploy-app.js create dplk-accounting dplk-accounting-deploy`. The secret goes straight into the Woodpecker secret through the API, never to the terminal.
- [ ] A fresh reviewer subagent reviews the YAML against this plan, `docs/deploy.md` and the spec build rules.
- [ ] **[go-ahead]** Commit `ci: build with Woodpecker and notify the Panel` and push to `sucor/development`. This push triggers one more Jenkins deploy of HEAD to .129/.115 (expected and harmless, because Jenkins still owns them).

### Task 4: First build and Panel targets

- [ ] Watch the Woodpecker pipeline for the push. Expected:
  - Three images pushed with tag `origin-sucor-development-<sha7 of the new commit>`.
  - The Panel `builds` row is created, and `deploymentIds` is empty because no target exists yet.
- [ ] Run a Woodpecker manual pipeline on commit `debb0af` (the running tag), or otherwise get a bundle for `origin-sucor-development-debb0af`. The Panel then has a build to "deploy the running tag" (Review Focus 1).
- [ ] Romi creates a Panel deploy target in "Dev 2" through the UI. I supply the values:
  - app `dplk-accounting`, branch `sucor/development`, server .115
  - deployDir `/deployments/dplk-accounting`
  - services `accounting-backend`, `accounting-frontend`
  - tagVariable `IMAGE_TAG`
  - healthUrl `http://localhost:8082/actuator/health` (answers 200 on .115, checked 2026-11-04), healthTimeoutSeconds 300
  - auto-deploy **off**, backup-before-deploy off for dev

### Task 5: Prove the path on dev2 (.115) [go-ahead]

- [ ] Panel → Dev 2 → Deploy `origin-sucor-development-debb0af` (the running tag). Expected:
  - The run streams, the compose services are recreated or unchanged, HEALTHY, and the deployment is `success`.
  - The current tag shown is `debb0af`.
  - QA impact is minimal (containers restart for ~1 minute), so tell Wella/Aisha before or pick a quiet time.
- [ ] Deploy the new Woodpecker tag (Task 4) to .115 manually, then roll back to `debb0af` through the UI, then deploy forward again. This exercises rollback.

### Task 6: Cut over dev2 and dev [go-ahead per environment]

For each environment, .115 first and then .129:
- [ ] Disable Jenkins `SUCOR/sucor-dev2-accounting` (or `sucor-dev-accounting`) through `POST …/disable`.
- [ ] Turn on auto-deploy on the Panel target. For .129, create its target as in Task 4 first.
- [ ] **[go-ahead]** Push a trivial commit, or use the next real push. Verify:
  - The Woodpecker build runs.
  - The Panel auto-deploys only to the environments that are cut over.
  - Jenkins does not deploy.
  - Two quick pushes produce one deploy of the newest build (Review Focus 2).

### Task 7: Demo environments [go-ahead each; VPS needs office IP + backup]

- [ ] Romi creates Panel environments or targets for .117 (demo2) and .138 (demo) with auto-deploy **off**. Check each server's `.env` against the Jenkins exports (`DOCKER_REGISTRY`, `FRONTEND_PORT=82`, `BACKEND_PORT=8082`) and add the missing ones after backing up `.env`.
- [ ] Deploy their currently running tag through the Panel (bundle as in Task 4), then disable `SUCOR/sucor-demo2-accounting` and `sucor-demo-accounting`.
- [ ] VPS (demo3): its jobs are already disabled. When Romi is on the office network:
  - back up `/deployments/dplk-accounting/.env` and the accounting DB;
  - create a target with `backupBeforeDeploy` on;
  - deploy the running tag;
  - keep its Jenkins job disabled.

### Task 8: Clean-up and records

- [ ] Remove the spike:
  - branch `spike/woodpecker` (Bitbucket + the local worktree `~/dss/dplk-accounting-wt-woodpecker`)
  - registry repos `spike/*`
  - the spike pipeline history if wanted
- [ ] Remove the `docker.sock`/trusted mentions from Woodpecker settings.
- [ ] Update the memories:
  - DSS `woodpecker-spike-113.md`: rename it to a production note (`woodpecker-113.md`), with BuildKit, network, secrets and settings.
  - DSS `jenkins-113.md`: `SUCOR/*-accounting` disabled, replaced by Woodpecker + Panel.
  - opsdeck `panel-deploy-feature.md`: first live app.
  - DSS `sucor-dev-vms-129-115.md`: accounting deploys come from the Panel.
- [ ] Write plan D (cms → portal BE+FE → membership → investment) using what this pilot taught.

# Setup wizard: New app stepper, Add environment, shared Review (plan 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer creates an app or an environment and gets it deployed from one flow in the Panel UI, without SQL, SSH, Woodpecker or Cloudflare knowledge.

**Architecture:** One server endpoint creates the whole environment in a single DB transaction:
- the environment and its services;
- the deploy target;
- the variables;
- the database binding;
- the domain binding.

It then starts the existing resumable provisioning run (plans 3b-1/3b-2), which does the remote side. The "New app" stepper first registers the app through the existing `registerApp` (plan 2), then calls the same endpoint, then triggers the first build. "Add environment" is one page that copies from an existing environment. Both end on one Review component fed by a server-side preview.

Two small backend pieces make a fresh environment work end to end:
- **Repo detection:** compose services and Dockerfiles, read through the forge.
- **Compose overlay:** joins the app's services to a shared database host's Docker network (Romi's decision 2026-11-07). It is written as `compose.opsdeck.yaml` next to the managed `.env`, which carries `COMPOSE_FILE=compose.yaml:compose.opsdeck.yaml`.

A third, "deploy when built", handles environments whose branch has no build yet.

**Tech Stack:** Bun, Hono, React 19 + TanStack (Router, Query, Form patterns already in the repo), shadcn/ui on Base UI, Drizzle (hand-written SQL), `yaml` 2.x, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-04-app-environment-wizard-design.md`, sections "Flows" (New app, Add environment, Review and provisioning), "Variables" (copy rules), "Decisions → Wizard shape". It builds on plans 2 (`registerApp`), 3a (variables, managed `.env`), 3b-1 (`provisioning`) and 3b-2 (domains).

## Global Constraints

- **Wizard shape** (spec decision): "New app" is a stepper: Repo → Environment → Database → Variables → Domain → Review. "Add environment" is one page with collapsible sections, prefilled by copying from an existing environment of the same app. Both end on the same Review.
- **Who** (spec):
  - "New app" is open to project maintainers and admins. Maintainers register `custom`-pipeline components only, as `registerApp` already enforces.
  - "Add environment" is open to maintainers of the target project.
  - Placement, database and domain rules are the existing ones (`requireEnvironmentPlacement`, shared-db rules, domain/port/policy rules). The setup endpoint must call the same checks, not re-implement weaker ones.
- **Atomicity:** every Panel DB row of a setup is written in one transaction. Nothing is written when any check fails. The remote side runs only through the provisioning run (resumable, visible).
- **Environments created by the wizard** always have `env_file_managed = true`.
- **Copy rules** (spec "Variables"):
  - `generated` variables are regenerated, never copied.
  - `secret` values are copied only for a caller who may read the source's secrets (project maintainer/admin of the source project); for others the value is left blank and is required.
  - `plain` values are copied as is.
  - Escrowed variables are never copied: generated ones are regenerated, others must be entered *(controller's call: the app model has no per-app copy rule, and a new environment has a new database, so a new key is the safe default)*.
  - Secret values never travel to the browser. Copying happens server-side by `copyFromEnvironmentId`.
- **Compose overlay** (Romi 2026-11-07):
  - It applies when the environment's db binding is `shared` and its database host has a `network`.
  - The Panel then writes `compose.opsdeck.yaml` with, for each target service, `networks: [default, <network>]`, plus top-level `networks: { <network>: { external: true } }`.
  - It adds `COMPOSE_FILE=compose.yaml:compose.opsdeck.yaml` to the rendered `.env` (the Panel writes `COMPOSE_*` itself; user variables with that prefix stay refused).
  - It is staged and installed exactly like the `.env` (same deploy, after the bundle step, 0600, `*.opsdeck-prev` kept).
  - When the binding no longer needs it, the Panel removes the file and the `COMPOSE_FILE` line.
- **Free entry port:**
  - The preview suggests one from the server's stored preflight via `pickFreePort` in 8100–8999, excluding other environments' `entry_port`.
  - If the server has no preflight yet, the field is required and empty.
  - Maintainers may only use 8100–8999 (plan 3b-2 rule).
- **Deploy when built:**
  - When the target's branch has no build, the provisioning `deploy` step sets `deploy_targets.deploy_next_build = true`, ends `done` and logs "waits for the first build of `<branch>`".
  - `recordBuild` deploys the next build of that branch once (trigger `auto`, actor from the build) and clears the flag in the same transaction, even for a manual target.
- **Process:**
  - UI strings go in all five `messages/*.json`, and `id` is real Indonesian.
  - Read `~/.claude/projects/-var-home-romi/memory/shadcn-2026-base-ui-metrics.md` before sizing UI.
  - The migration is additive, `SET lock_timeout = '5s'` first, applied before the build.
  - `bun run typecheck`, `bun run lint` and `bun run test` green before each commit.

## Review Focus

1. **A setup whose last check fails** (e.g. a domain label taken, or a port in use) leaves no environment, service, target, variable or binding behind (Task 4: transaction test with the failure in the last validation).
2. **Copy from an environment with secrets:**
   - secret values are copied server-side for a maintainer;
   - a caller without access to the source gets 404 for the source;
   - generated and escrowed values are never copied;
   - no secret value appears in the preview or the API responses (Task 4).
3. **Compose overlay on a host where the app's compose already declares custom networks:** `docker compose config` of base plus overlay is valid, keeps the service's own networks and adds the external network (Task 2: a test that runs `docker compose config` through the podman wrapper when available, otherwise a YAML merge unit test plus a go-live check).
4. **Deploy-when-built races:**
   - two builds landing at once deploy only one;
   - a manual deploy before the first build clears the flag;
   - a deploy lock holds the build like any auto deploy (Task 3).
5. **New app, partially failed creation** (registration OK, setup refused): the app exists, the page says so, and "Add environment" is offered with the same inputs prefilled. No silent half state (Task 6).

---

### Task 1: Schema, forge file reading, repo detection

**Files:**
- Create: `drizzle/20261107000000_setup_wizard/migration.sql`, `lib/setup/detect.ts` (pure), `server/services/setup-detect.ts`, `server/routes/setup.ts` (detection route; Task 4 adds more)
- Modify: `lib/db/schema.ts`, `lib/ci/forges/bitbucket.ts` (+ the forge interface used by `registerApp`), `server/app.ts`
- Test: `tests/setup-wizard-migration.test.ts`, `tests/setup-detect.test.ts`, `tests/ci-bitbucket.test.ts`

**Interfaces:**
- Produces:
  - **Schema:**
    - `database_hosts.network text null`, a Docker network name matching `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`, set by admins in the database host UI;
    - `deploy_targets.deploy_next_build boolean not null default false`.
  - **Forge:**
    - `readRepoFile(auth, repoFullName, ref, path): Promise<string | null>`. It uses Bitbucket `GET /2.0/repositories/{repo}/src/{ref}/{path}`; a 404 gives null; the body is capped at 256 KiB.
    - `listRepoDir(auth, repoFullName, ref, path): Promise<{ path: string; type: "file" | "dir" }[]>`, from the same endpoint's directory listing, following `next`.
  - **`detectRepo(files: { path: string; content?: string }[]): RepoDetection`**, a pure function:
    - `RepoDetection = { composeFile: string | null; services: { name: string; image: string | null; build: string | null; ports: { host: string | null; container: number }[]; profiles: string[] }[]; dockerfiles: string[]; entryService: string | null; entryContainerPort: number | null; issues: ("no_compose" | "no_dockerfile" | "compose_parse_error")[] }`.
    - **Compose file:** the first that exists of `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`, parsed with `yaml`.
    - **Dockerfiles:** files named `Dockerfile` or `*.Dockerfile` at depth ≤ 2.
    - **Entry service:** the first service with `ports`; otherwise the one named `frontend`, `web` or `app`; otherwise null.
    - **Runtime services:** services with no `profiles`.
  - **`detectComponentRepo(connectionId, repoFullName, branch): Promise<RepoDetection>`.** It reads the root and depth-1 dirs, and only the compose file's content. It is gated on the same permission as `listRegistrableRepos`.
  - **Route:** `GET /api/setup/detect?connectionId&repo&branch`.

- [ ] **Step 1: Failing tests:**
  - **Migration:** static checks: additive, `lock_timeout` first.
  - **Bitbucket:**
    - `readRepoFile` URL encoding of a path with a slash;
    - 404 → null;
    - `listRepoDir` pagination.
  - **`detectRepo`:**
    - **HRIS-like fixture** (`hris-db`/`hris-backend`/`hris-frontend` with `ports: ["127.0.0.1:8091:80"]`, `hris-migrate` with `profiles: [tools]`, `backend/Dockerfile`, `frontend/Dockerfile`): gives services `[hris-db, hris-backend, hris-frontend]` (no migrate), entry `hris-frontend`, container port 80, and both dockerfiles.
    - **No compose:** issue `no_compose`.
    - **Broken YAML:** `compose_parse_error`, and it does not throw.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces. Add a "Network" field to the database host register form and list, defaulting to the container's first non-default network from `docker inspect` when the host is verified. Use the existing verify SSH call: `docker inspect -f '{{json .NetworkSettings.Networks}}'`.
- [ ] **Step 4: Run** the tests and the full check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(setup): repo detection and wizard schema`

### Task 2: Compose overlay for shared database networks

**Files:**
- Create: `lib/variables/compose-overlay.ts` (pure)
- Modify: `lib/variables/env-file.ts` (an optional `composeFile` line), `lib/variables/managed-env.ts`, `lib/jobs/deploy.ts` (stage the overlay with the `.env`), `lib/deploy/script.ts` (`installStagedEnvFile` gains `overlay?: boolean`: install `compose.opsdeck.yaml` the same way, or remove it with its `-prev` kept when absent)
- Test: `tests/compose-overlay.test.ts`, `tests/deploy-script.test.ts`, `tests/env-file.test.ts`, `tests/deploy-job.test.ts`

**Interfaces:**
- Produces:
  - `renderComposeOverlay(services: string[], network: string): string`. Deterministic YAML with a header comment "Written by the DSS Panel; do not edit".
  - `COMPOSE_OVERLAY_FILE = "compose.opsdeck.yaml"`.
  - `renderEnvFile(vars, tags, registry, opts?: { composeFiles?: string[] })` writes `COMPOSE_FILE=<joined by ':'>` when the option is given.
  - **Deploy job:** when the environment is managed and its db binding is shared with a host `network`, it stages the overlay for the target's `services` and passes `composeFiles: ["compose.yaml", COMPOSE_OVERLAY_FILE]`. Otherwise it passes nothing, and the script removes a leftover overlay.
- Uses: plan 3a staging (`stagedEnvFileName`), keeping its install semantics.

- [ ] **Step 1: Failing tests:**
  - **Overlay:** for `["hris-backend"]` / `shared-postgres` the YAML parses back to `{ services: { "hris-backend": { networks: ["default", "shared-postgres"] } }, networks: { "shared-postgres": { external: true } } }`. A service name with a quote is refused by `composeServiceSchema`.
  - **Env file:** a `COMPOSE_FILE` line when the option is given, none otherwise. User variable names starting with `COMPOSE_` are still refused.
  - **Script:**
    - with `overlay: true` it installs both files atomically after the bundle step;
    - a failed install leaves both previous files in place;
    - with `overlay: false` and an existing overlay it moves the overlay to `compose.opsdeck.yaml.opsdeck-prev`;
    - it never runs `compose down`.
  - **Job:** a shared binding with a network stages two files; without a network, one file plus removal.
  - **Review Focus 3:** when `podman compose`/`docker compose` is on PATH, `docker compose -f base -f overlay config` on a base whose service declares `networks: [internal]` lists `internal`, `default` and `shared-postgres` for that service. Otherwise the test is skipped and the controller checks it at go-live.
- [ ] **Step 2: Run** the test files. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the tests and the full check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): compose overlay joins shared database networks`

### Task 3: Deploy when built, and triggering the first build

**Files:**
- Modify: `lib/jobs/provision.ts` (the `deploy` step), `server/services/deploy-builds.ts` (`recordBuild`), `lib/deploy/repository.ts` (atomic clear), `server/services/deployments.ts` (a manual deploy clears the flag), `lib/ci/types.ts` + `lib/ci/woodpecker.ts` (`triggerPipeline`)
- Test: `tests/provisioning-job.test.ts`, `tests/deploy-hooks.test.ts`, `tests/deploy-repository.test.ts`, `tests/ci-woodpecker.test.ts`

**Interfaces:**
- Produces:
  - `CiProvider.triggerPipeline(ciRepoId: string, branch: string): Promise<{ number: number }>`. It is Woodpecker `POST /api/repos/{id}/pipelines` with body `{ branch }`.
  - **Provision `deploy` step:** when there is no build, it sets `deploy_next_build = true`, ends `done`, and logs "Waiting for the first build of `<branch>`; it deploys when it lands".
  - **`recordBuild`:** for each target of the component and branch with `deploy_next_build = true`, it requests an `auto` deployment as for auto targets. It clears the flag in the same transaction that places the deployment, with `UPDATE … SET deploy_next_build = false WHERE id = $1 AND deploy_next_build RETURNING id`. Only a returned row places the deployment.
  - **Manual deploy** of a target clears the flag.

- [ ] **Step 1: Failing tests:**
  - **Provision step:** with no build it sets the flag and ends `done`, with that message.
  - **Hook:**
    - a target with the flag (`autoDeploy` false) gets one deployment, and the flag is cleared;
    - two concurrent notifications for the same branch give one deployment (Review Focus 4);
    - with the lock active, the deployment is `held`;
    - a manual deploy clears the flag.
  - **Woodpecker:** `triggerPipeline` URL and body; a 404 becomes `CiProviderError`.
- [ ] **Step 2: Run** the test files. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the tests and the full check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): deploy the first build when it lands`

### Task 4: Setup service (preview + create, copy-from)

**Files:**
- Create: `lib/setup/schema.ts` (zod input), `server/services/environment-setup.ts`, routes in `server/routes/setup.ts`
- Modify (only to extract transaction-capable internals; keep the public behaviour and their tests unchanged):
  - `server/services/environments.ts` (create in a `tx`, placement checks);
  - `server/services/deploys.ts` (target insert in a `tx`);
  - `server/services/variables.ts` (variable writes in a `tx`, template application);
  - `server/services/environment-domains.ts` (validation plus save in a `tx`);
  - `server/services/provisioning.ts` (start after commit).
- Test: `tests/environment-setup-api.test.ts`

**Interfaces:**
- **`EnvironmentSetupInput`** (zod):
  - `projectId`, `appId`, `name`, `kind?`, `ownerId?`.
  - `copyFromEnvironmentId?`.
  - `server: { serverId }`.
  - `target: { componentKey, sourceBranch, autoDeploy, deployDir, services, tagVariable, preStartCommand?, healthUrl?, healthTimeoutSeconds, backupBeforeDeploy }`, with one entry per component of the app.
  - `database: { kind: "shared"; databaseHostId; dbName; dbRole; passwordVariable } | { kind: "container"; serviceName } | { kind: "external" } | { kind: "none" }`.
  - `variables: { name; kind; value?: string; copy?: boolean }[]`. `value` is for plain/secret entries; `copy` means "take the source's value server-side".
  - `domain: { kind: "none" } | { kind: "tunnel"; zoneId; label; accessPolicyId: string | null; entryPort } | { kind: "external"; hostname }`.
- **`previewEnvironmentSetup(input)`:** `POST /api/setup/environments/preview`. It returns `{ issues: { field: string; code: string }[]; plan: ProvisioningStepSpec[]; creates: string[]; suggestedEntryPort: number | null; slug: string }`.
  - It runs every check the create would run, without writing.
  - `creates` lists the Panel rows in words, e.g. "Environment Staging in HRIS", "Deploy target hris → DSS .56.113 /deployments/hris-staging", "12 variables (3 generated, 1 copied secret)", "Domain hris-staging.dssconsulting.id".
- **`createEnvironmentSetup(input)`:** `POST /api/setup/environments`. It runs the same checks, then one `db.transaction` that writes everything. After commit it starts provisioning (`startProvisioning`). It returns `{ environmentId, projectKey, envSlug, runId }`.
  - It records activity `environment.setup` (names only).
  - A failure after commit, e.g. enqueue, leaves the environment, and the response says provisioning can be started from its Deploys page.
- **`getCopySource(environmentId)`:** `GET /api/setup/environments/copy-source/:id`. It returns:
  - the source's non-secret config: target(s), database kind/host (never the name), domain kind, zone and policy;
  - variables as `{ name, kind, escrow, hasValue, copyable: boolean }`, never values except `plain`.
  - It needs project read on the source; a source that is not visible gives 404.
- **Database rules:** `container` creates a db service bound to `serviceName` on the deploy server (`serviceType: docker`, postgres). `none` creates no db service.

- [ ] **Step 1: Failing tests:**
  - **Happy path:** a maintainer on an open server with a shared db and a tunnel domain gets exactly one environment, its services, one target with the given fields, the variables (generated ones created with length from the template, copied secrets equal to the source's encrypted values after decrypting both), the db binding and the domain, plus one provisioning run started.
  - **Review Focus 1:** a label taken by another environment → 409, and zero rows of every table.
  - **Review Focus 2:**
    - a QA contributor → 403;
    - copy-source on an invisible project → 404;
    - generated/escrow values are never equal to the source's;
    - the preview and the response contain no secret value (search the JSON for each source secret's plaintext);
    - copy for a caller without secret access gives a blank required secret and a validation issue.
  - **Preview:**
    - it lists the same issues the create would raise;
    - `suggestedEntryPort` skips other environments' ports;
    - it writes nothing.
  - **Existing tests** for environments, deploys, variables and domains stay green.
- [ ] **Step 2: Run** `bunx vitest run tests/environment-setup-api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the tests and the full check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(setup): environment setup preview and create`

### Task 5: Add environment page and the shared Review

**Files:**
- Create:
  - `web/routes/$locale/_app/-components/setup/review.tsx` (shared Review: `creates` list, plan sentences reusing the provisioning panel's sentence component, issues, a "Create & deploy" button);
  - `web/routes/$locale/_app/-components/setup/environment-sections.tsx` (Server, Database, Variables, Domain, Deploy sections, reused by Task 6);
  - `web/routes/$locale/_app/apps.$appKey.environments.new.tsx` (Add environment).
- Modify:
  - `web/routes/$locale/_app/apps.$appKey.index.tsx`: an "Add environment" button for maintainers.
  - `web/routes/$locale/_app/environments.new.tsx` and `$projectKey.environments.new.tsx`: when an app is chosen, link to the new page. The old free-form create stays for `managedOnly`/legacy environments.
  - `messages/*.json`.
- Test: `tests/setup-review.test.tsx`, `tests/add-environment-page.test.tsx`

**Interfaces:**
- Consumes: the Task 4 API.
- **Behaviour:**
  1. The page asks for the project (only projects where the user is maintainer) and a name.
  2. "Copy from" offers the app's environments the user can see. Choosing one fills every section from `copy-source`. Secrets show "will be copied" or "enter a value". Generated and escrowed variables show "a new value will be generated" or "enter a value".
  3. Sections are collapsible and summarised when closed.
  4. Each change re-runs the preview, debounced 500 ms.
  5. "Create & deploy" is disabled while issues remain. On success the page navigates to the new environment's Deploys page, where the provisioning panel shows the run.

- [ ] **Step 1: Failing tests:**
  - **Review:** it renders `creates`, the plan sentences and the issues; the button is disabled with issues.
  - **Page:**
    - selecting a copy source fills the sections;
    - a secret row shows "will be copied" without any value in the DOM;
    - submit posts the input built from the sections.
- [ ] **Step 2: Run** the two test files. Expected: FAIL.
- [ ] **Step 3: Implement**, following existing patterns (TanStack Query hooks in `web/api`, react-hook-form + zod as in `components/environment-form.tsx`, shadcn/Base UI components already in the repo).
- [ ] **Step 4: Run** the tests and the full check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(setup): add environment page and shared review`

### Task 6: New app stepper

**Files:**
- Create: `web/routes/$locale/_app/apps.new.tsx` (replace its body with the stepper; keep the existing registration form's logic as the Repo step's "advanced" part), `web/routes/$locale/_app/-components/setup/new-app-stepper.tsx`
- Modify: `messages/*.json`
- Test: `tests/new-app-stepper.test.tsx`

**Interfaces:**
- Consumes:
  - `GET /api/setup/detect` (Task 1);
  - `registerApp` (existing `POST`);
  - the Task 4 API;
  - `triggerPipeline` exposed as `POST /api/apps/:appKey/components/:componentKey/build { branch }` (maintainer of the app's projects or admin; add it in this task's route file).
- **Steps:**
  1. **Repo:** pick a repo (existing `listRegistrableRepos`) and a branch. The detection shows compose services, Dockerfiles, the entry service and issues; the build spec and runtime spec are prefilled and editable. A maintainer gets custom pipeline mode, an admin may choose generated.
  2. **Environment:** project, name, server (filtered by placement), branch, auto/manual.
  3. **Database:** none/shared/container/external.
  4. **Variables:** entries (a new app has no template yet). Each is a name, a kind and a value; generated ones are created.
  5. **Domain:** none/tunnel/external.
  6. **Review:** the Task 5 component. The plan also lists "Register app `<key>`" and "Start the first build of `<branch>`".
- **"Create" runs in order** and shows each line's result:
  1. register the app;
  2. create the environment setup;
  3. trigger the first build.
  - If a line fails, the next ones don't run.
  - If registration succeeded but setup failed, the page keeps the inputs, says the app exists, and links to Add environment with the inputs prefilled through router state (Review Focus 5).
  - On success it navigates to the environment's Deploys page.

- [ ] **Step 1: Failing tests:**
  - **Navigation:** steps validate before moving on; detection prefills the services and the entry port's container side.
  - **Create:** with mocked APIs, the three calls run in order.
  - **Review Focus 5:** a setup failure after registration shows the message and the Add environment link with the state.
  - **Permission:** a maintainer never sees the generated-mode option.
- [ ] **Step 2: Run** `bunx vitest run tests/new-app-stepper.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the full check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(setup): new app stepper`

### Task 7: Go live (controller)

- [ ] Take a backup, dry-run the migration, and apply it. Merge and push. Romi runs Jenkins `DSS/dss-panel`; health must return 200.
- [ ] Set `shared-postgres` as the network of the `shared-postgres` database host.
- [ ] **Canary A** (Add environment): copy PCAN/Canary into a new environment "Canary 2" on .113:
  - shared db `pcan_canary2`;
  - tunnel `panel-canary2.dssconsulting.id` with DSS Internal;
  - port suggested by the preview.

  Expected:
  - provisioning is all done;
  - the container joins `shared-postgres` (`docker inspect`), and `docker compose config` in the deploy dir is valid;
  - `https://panel-canary2…` returns 302 to Access;
  - Canary's own config is untouched.
- [ ] **Canary B** (New app): register a second throwaway repo only if Romi provides one; otherwise report the stepper as tested by unit tests only.
- [ ] Report the cleanup that is still manual until plan 5: Canary 2's route, DNS, Access app and database.

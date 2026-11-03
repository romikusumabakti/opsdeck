# Panel Deploy Implementation Plan (plan A of the CI/deploy spec)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Panel receives signed build notifications, auto-deploys them to dev environments, lets maintainers deploy any recorded build or roll back, and shows the running tag and deploy history per environment.

**Architecture:** There are four parts:
- **Build notifications.** A public HMAC-verified Hono endpoint records builds in a `builds` table.
- **Deploy configuration.** Per-environment `deploy_targets` say which app, branch, server and directory to deploy.
- **Deploy runs.** A deploy is a `runs` row with `kind='deploy'` plus a `deployments` row (queued/running/success/failed/superseded). A BullMQ job `deploy/run.requested` claims the deployment (one running per environment), optionally runs the existing DB backup, then executes one generated shell script over SSH. The script pulls the bundle and the images, copies the bundle files, sets the tag variable in `.env`, runs `compose up -d --no-deps <services>`, and waits for health.
- **UI.** A new environment page "Deploys".

**Tech Stack:** Bun, Hono (+ `@hono/zod-validator` via `server/validation.ts`), Drizzle + Postgres, BullMQ/Valkey, React + TanStack Router/Query, use-intl, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-ci-build-deploy-design.md`. Other plans implement the rest of that spec, and this plan does not cover them:
- Plan B: Panel prerequisites (Access, backups, credential encryption).
- Plan C: Woodpecker hardening plus the accounting pilot.
- Plan D: the remaining app cutovers.

## Global Constraints

- All code, identifiers, logs, error messages, docs and test names in English. UI text only in `messages/{ar,en,es,id,zh}.json`, and every new key goes into all five files in the same commit.
- **Migrations** are hand-written SQL files in `drizzle/<YYYYMMDDHHMMSS>_<name>/migration.sql`, each wrapped in an explicit `BEGIN; … COMMIT;` with a comment header. No `drizzle-kit generate`. A new enum value goes in its own migration, because it can't be used in the transaction that adds it.
- **Tags** match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$` and must never equal `latest` (case-insensitive). The tag format produced by CI is `origin-<branch with / → ->-<shorthash>`; the Panel validates the regex only.
- **Deploys never run `docker compose down`** and never restart services outside the target's `services` list. Postgres is never touched.
- **Deploy and rollback are maintainer-only.** Configuring targets is maintainer-only. Viewing is for any project role.
- **No automatic rollback.** A failed deploy stays failed. Rollback = a new deployment of the previous successful tag of the same target.
- **At most one deployment `running` per environment.** A new `auto` deployment supersedes older `queued` `auto` deployments of the same target.
- **The Panel stores no app config.** Its only `.env` change on the server is the target's tag variable.
- **The deploy bundle convention** (decided here; the spec leaves it to the builder):
  - The image is `<registry>/<bundleImage>:<tag>`, built `FROM scratch` with the files laid out exactly as they should appear in the deploy dir under `/bundle/`.
  - The deploy extracts it with `docker create <img> noop`, then `docker cp <cid>:/bundle/. <deployDir>/`, then `docker rm <cid>`.
  - The server's compose file is always `compose.yaml` in the deploy dir. A server-only `compose.override.yaml` is merged by compose automatically.
- **Registry:** new env var `DEPLOY_REGISTRY` (e.g. `192.168.56.113:5000`). It is optional; when unset, the deploy feature is disabled and the hook answers 503.
- **Build-notification signature:** header `X-Opsdeck-Signature: sha256=<hex HMAC-SHA256 of the raw request body>`, using the app's notify secret. Secrets are stored encrypted with `encryptSecret` (`enc:v1:`).

## Review Focus

1. **A tag of `latest`, a tag with shell metacharacters, or an over-long tag.** It is rejected at the hook (400), at the deploy API (400) and at the job payload. Tests: Task 2 and Task 4.
2. **Two pushes to `sucor/development` within seconds.** The older queued auto deployment becomes `superseded`. Two deployments never run in the same environment at once, and the second one waits and then runs. Tests: Task 5.
3. **"Back up before deploy" is on and the backup fails.** The deploy fails before any SSH deploy command runs, and the environment is untouched. Test: Task 5.
4. **Containers never become healthy (crash loop).** The script exits non-zero within `healthTimeoutSeconds`. The run and the deployment are `failed`, there is no automatic rollback, and the UI offers a rollback to the previous successful tag. Tests: Task 2 (script) and Task 5 (status).
5. **A hook with a bad or missing signature, for an unknown app, or a replay of the same build.** The first three answer 401 with the same body, and nothing is recorded. A replayed build creates no second build row and no second deployment. Tests: Task 4.

---

### Task 1: Schema, migrations, permissions

**Files:**
- Modify: `lib/db/schema.ts` (`runKindEnum` ~L270; add new tables after `runs`)
- Create: `drizzle/20261104000000_run_kind_deploy/migration.sql`
- Create: `drizzle/20261104000100_deploy_tables/migration.sql`
- Modify: `lib/permissions.ts` (`projectStatements` L68-79, `projectRoles.maintainer` L100-110)
- Test: `tests/permissions.test.ts`

**Interfaces — Produces:**
- `runKindEnum` gains `"deploy"`.
- `deployTriggerEnum = pgEnum("deploy_trigger", ["auto","manual","rollback"])`.
- `deploymentStatusEnum = pgEnum("deployment_status", ["queued","running","success","failed","superseded"])`.
- Table `deployApps`:
  - `appKey` text PK (e.g. `dplk-accounting`)
  - `bundleImage` text not null (e.g. `dplk-accounting-deploy`)
  - `notifySecret` text not null (encrypted)
  - `createdAt`
- Table `deployTargets`:
  - `id` uuid PK uuidv7
  - `environmentId` → environments, cascade
  - `appKey` → deployApps, restrict
  - `serverId` → servers, restrict
  - `sourceBranch` text not null
  - `autoDeploy` bool not null default false
  - `deployDir` text not null
  - `services` text[] not null
  - `tagVariable` text not null default `'IMAGE_TAG'`
  - `preStartCommand` text null
  - `healthUrl` text null
  - `healthTimeoutSeconds` integer not null default 180
  - `backupBeforeDeploy` bool not null default false
  - `createdAt`, `updatedAt`
  - unique (`environmentId`, `appKey`); index `appKey`
- Table `builds`:
  - `id` uuid PK
  - `appKey` → deployApps, cascade
  - `branch` text not null
  - `tag` text not null
  - `commitSha` text not null
  - `pipelineUrl` text null
  - `receivedAt` timestamp default now
  - unique (`appKey`, `tag`); index (`appKey`, `branch`, `receivedAt` desc)
- Table `deployments`:
  - `id` uuid PK
  - `targetId` → deployTargets, cascade
  - `environmentId` (denormalised for the per-environment claim) → environments, cascade
  - `runId` → runs, cascade
  - `tag` text not null
  - `trigger` deployTriggerEnum not null
  - `status` deploymentStatusEnum not null default `queued`
  - `buildId` → builds, set null
  - `createdAt`, `startedAt` null, `finishedAt` null
  - index (`targetId`, `createdAt` desc); partial unique index on (`environmentId`) where `status = 'running'`. This index is the DB-level guarantee of one running deploy per environment.
- Exported types `DeployApp`, `DeployTarget`, `Build`, `Deployment` (`$inferSelect`), and `NewDeployTarget` (`$inferInsert`).
- `projectStatements.deploy = ["view","run","rollback","configure"]`. Viewer and contributor get `deploy: ["view"]`; maintainer gets all four.

- [ ] **Step 1: Write failing tests in `tests/permissions.test.ts`**

```ts
test("only maintainers may run, roll back and configure deploys", () => {
  for (const p of ["run", "rollback", "configure"] as const) {
    expect(canProject("maintainer", { deploy: [p] })).toBe(true);
    expect(canProject("contributor", { deploy: [p] })).toBe(false);
    expect(canProject("viewer", { deploy: [p] })).toBe(false);
  }
  expect(canProject("viewer", { deploy: ["view"] })).toBe(true);
});
```

- [ ] **Step 2: Run** `bun --bun vitest run tests/permissions.test.ts`. Expected: FAIL (a type error or `false`).
- [ ] **Step 3: Implement the permissions and schema above.** Write the two migrations to match the schema exactly. The first contains only `ALTER TYPE "run_kind" ADD VALUE IF NOT EXISTS 'deploy';`. The second has the enums, tables, indexes and the partial unique index `deployments_one_running_per_env_idx`.
- [ ] **Step 4: Run** `bun --bun vitest run tests/permissions.test.ts && bun run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(deploy): schema, migrations and deploy permissions`.

---

### Task 2: Validation schemas and the deploy script builder (pure)

**Files:**
- Create: `lib/deploy/validation.ts`
- Create: `lib/deploy/script.ts`
- Test: `tests/deploy-script.test.ts`

**Interfaces — Produces:**
- **In `lib/deploy/validation.ts`:**
  - `deployTagSchema`: the tag regex above, refined so it is not `latest`.
  - `appKeySchema`: `^[a-z0-9][a-z0-9-]{0,63}$`.
  - `branchSchema`: `^[A-Za-z0-9][A-Za-z0-9/_.-]{0,199}$`, with no `..`.
  - `envVarNameSchema`: `^[A-Z_][A-Z0-9_]{0,63}$`.
  - `deployDirSchema`: absolute, `^/[A-Za-z0-9/_.-]+$`, with no `..` segment.
  - `composeServiceSchema`: `^[a-z0-9][a-z0-9_.-]{0,63}$`.
  - `commitShaSchema`: `^[0-9a-f]{7,40}$`.
- **In `lib/deploy/script.ts`:** `interface DeployScriptInput { registry: string; bundleImage: string; tag: string; deployDir: string; services: string[]; tagVariable: string; preStartCommand: string | null; healthUrl: string | null; healthTimeoutSeconds: number }` and `buildDeployScript(input: DeployScriptInput): string`.
  - The input is validated with the schemas above, and the function throws on an invalid one.
  - Every interpolated value goes through `shq` from `lib/sh.ts`.
  - `preStartCommand` is operator-entered config and is inserted verbatim after `cd`.

The script, in order:
1. `set -eu`, then `cd <deployDir>`.
2. `docker pull <registry>/<bundleImage>:<tag>`.
3. `cid=$(docker create <img> noop)`, then `docker cp "$cid":/bundle/. .`, then `docker rm "$cid"`.
4. Set the tag variable: if the line `^<VAR>=` exists in `.env`, replace it with `sed -i`; otherwise append `<VAR>=<tag>`.
5. `docker compose pull <services…>`.
6. The pre-start command, if any.
7. `docker compose up -d --no-deps <services…>`.
8. **The health loop**, until `healthTimeoutSeconds`, every 5 s:
   - Each service's container must be running.
   - Its health must be `healthy` or none (via `docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' <services…>`).
   - If a `healthUrl` is set, `curl -fsS -o /dev/null --max-time 5 <url>` must succeed.
   - On timeout, print `HEALTH TIMEOUT` and `exit 1`.

- [ ] **Step 1: Write failing tests in `tests/deploy-script.test.ts`.** The stub-docker tests follow the `spawnSync` pattern in `tests/job-commands.test.ts`: put a fake `docker`/`curl` on `PATH` that records argv to a log file and prints canned `compose ps` output.
  - `rejects tag "latest" and "LATEST"`: `buildDeployScript({...base, tag: "latest"})` throws.
  - `rejects tag with shell metacharacters`: tag `x;rm -rf /` throws.
  - `never stops or removes the stack`: the output does not match `/compose\s+(down|stop|rm)/`, and it contains `up -d --no-deps`.
  - `orders bundle → env → pull → pre-start → up → health`: the indexes of `docker pull`, `docker cp`, `sed -i`/append, `compose pull`, the pre-start marker, `up -d` and `compose ps` are strictly increasing.
  - `stub run, healthy`: the stub `compose ps` prints `backend running healthy`. The script exits 0. `.env` (in a temp deployDir seeded with `IMAGE_TAG=old\nOTHER=1\n`) ends up with `IMAGE_TAG=<tag>` and keeps `OTHER=1`.
  - `stub run, tag variable absent`: a seeded `.env` without the variable gets `BACKEND_IMAGE_TAG=<tag>` appended.
  - `stub run, never healthy`: the stub prints `backend restarting`, with `healthTimeoutSeconds: 6`. The script exits 1 within 15 s, and stdout contains `HEALTH TIMEOUT`. (Review Focus 4.)
- [ ] **Step 2: Run** `bun --bun vitest run tests/deploy-script.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement both files.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): validated deploy script builder`.

---

### Task 3: Deploy repository (DB access) and the `deploy-app` script

**Files:**
- Create: `lib/deploy/repository.ts`
- Create: `scripts/deploy-app.ts`
- Test: `tests/deploy-repository.test.ts` (SQL-shape tests only, with `db` mocked as in the existing tests; skip if the existing tests never assert SQL. Then the logic is covered in Tasks 4–5.)

**Interfaces — Produces** (all `async`, using `db` from `lib/db`):
- `getDeployApp(appKey: string): Promise<(DeployApp & { notifySecretPlain: string }) | null>` decrypts with `decryptSecret`.
- `insertBuildIfNew(b: { appKey; branch; tag; commitSha; pipelineUrl: string | null }): Promise<{ build: Build; created: boolean }>` uses `ON CONFLICT (app_key, tag) DO NOTHING` and returns the existing row when there is a conflict.
- `findAutoTargets(appKey: string, branch: string): Promise<DeployTarget[]>`
- `getTarget(id: string): Promise<DeployTarget | null>`
- `listTargetsForEnvironment(environmentId: string): Promise<TargetState[]>`, where `TargetState = DeployTarget & { runningTag: string | null; previousTag: string | null; recentBuilds: Build[] /* same appKey+sourceBranch, newest 20 */; recentDeployments: (Deployment & { userName: string | null })[] /* newest 20 */ }`.
  - `runningTag` = the newest `success` tag.
  - `previousTag` = the newest `success` tag different from `runningTag`.
- `findBuild(appKey: string, tag: string): Promise<Build | null>`
- `insertDeployment(d: { targetId; environmentId; runId; tag; trigger; buildId: string | null }): Promise<Deployment>`
- `supersedeQueuedAuto(targetId: string, exceptId: string): Promise<number>` sets `status='superseded'`, `finishedAt=now()` on `queued`+`auto` rows of the target, except `exceptId`.
- `claimDeployment(id: string): Promise<"claimed" | "busy" | "gone">`.
  - In a transaction: `UPDATE deployments SET status='running', started_at=now() WHERE id=$1 AND status='queued'`. A unique-violation on `deployments_one_running_per_env_idx` returns `"busy"`. Zero rows updated returns `"gone"` (superseded or already handled).
- `finishDeployment(id: string, status: "success" | "failed"): Promise<void>`
- `upsertTarget(input: NewDeployTarget & { id?: string }): Promise<DeployTarget>` and `deleteTarget(id: string): Promise<void>`

**`scripts/deploy-app.ts`:**
- Run with `bun --conditions react-server scripts/deploy-app.ts <create|rotate> <appKey> [bundleImage]`.
- Generates a 32-byte random secret, stores it with `encryptSecret`, and prints the plaintext ONCE to stdout with a one-line warning to put it in the Woodpecker org secret `opsdeck_notify_<appKey>`.

- [ ] **Step 1: Write a failing test.** At minimum: `claimDeployment maps unique violation to "busy"`. Mock `db.transaction` to throw a postgres error with `code: "23505"` and `constraint_name: "deployments_one_running_per_env_idx"`, and expect `"busy"`.
- [ ] **Step 2: Run** `bun --bun vitest run tests/deploy-repository.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the repository and the script.**
- [ ] **Step 4: Run** the test and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): deploy repository and app secret script`.

---

### Task 4: Build-notification endpoint

**Files:**
- Create: `lib/deploy/signature.ts`
- Create: `server/services/deploy-builds.ts`
- Create: `server/routes/deploy-hooks.ts`
- Modify: `server/app.ts` (mount `.route("/api/deploy-hooks", deployHooksRouter)`)
- Modify: `lib/env.ts` (optional `DEPLOY_REGISTRY`, via the `checkOptional` pattern)
- Modify: `tests/authz-guards.test.ts` (`PUBLIC` map: `"server/routes/deploy-hooks.ts": ["POST /builds"]`)
- Test: `tests/deploy-hooks.test.ts`

**Interfaces:**
- Consumes: Task 3 `getDeployApp`, `insertBuildIfNew`, `findAutoTargets`. Task 5 `requestDeployment` (mock it here; Task 5 implements it).
- Produces:
  - `verifySignature(rawBody: string, header: string | undefined, secret: string): boolean`, in constant time, accepting only `sha256=<64 hex>`.
  - `buildNotificationSchema = z.object({ app: appKeySchema, branch: branchSchema, tag: deployTagSchema, commit: commitShaSchema, pipelineUrl: z.url().optional() })`.
  - `recordBuild(n: BuildNotification): Promise<{ buildId: string; created: boolean; deploymentIds: string[] }>`. It only requests auto deployments when `created` is true, which makes a replay a no-op.
  - Route `POST /api/deploy-hooks/builds` on `publicRouter()`:
    1. Read the raw body (`c.req.text()`).
    2. `JSON.parse` it, catching errors.
    3. Look up the app by `app`.
    4. Verify the signature.
    5. Validate the schema.
    6. Then call `recordBuild`.
  - Responses:
    - `503 {error:"Deploy disabled"}` when `DEPLOY_REGISTRY` is unset.
    - `401 {error:"Unauthorized"}`, with an identical body, for an unknown app, a missing signature or a bad signature.
    - `400 {error:"Invalid request"}` for invalid JSON or a schema failure after the signature passes.
    - `202 { buildId, created, deploymentIds }` on success.

- [ ] **Step 1: Write failing tests in `tests/deploy-hooks.test.ts`.** Mock `@/lib/deploy/repository` and `@/server/services/deployments`, and call `app.request(...)` as in `tests/routes-batch-a.test.ts`.
  - `verifySignature accepts the right HMAC and rejects wrong, missing, non-hex and wrong-length`.
  - `401 with identical body for unknown app, missing signature, bad signature; nothing recorded` (asserts `insertBuildIfNew` is not called). (Review Focus 5.)
  - `400 for tag "latest" and tag "a;b" with a valid signature`. (Review Focus 1.)
  - `202 and one auto deployment per matching target on first delivery`.
  - `replayed build: created=false, requestDeployment not called`. (Review Focus 5.)
  - `503 when DEPLOY_REGISTRY unset`.
- [ ] **Step 2: Run** `bun --bun vitest run tests/deploy-hooks.test.ts tests/authz-guards.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the signature helper, the service and the route; mount the route; add the env var.
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): signed build notification endpoint`.

---

### Task 5: Requesting and running deployments (service + job)

**Files:**
- Create: `server/services/deployments.ts`
- Create: `lib/jobs/deploy.ts`
- Modify: `lib/queue.ts`
  - `JobMap` gets `"deploy/run.requested": { deploymentId: string; runId: string }`.
  - `EnqueueOptions` gets `delayMs?: number`, mapped to BullMQ `delay`.
- Modify: `lib/jobs/payloads.ts` (schema: both fields `uuidSchema`)
- Modify: `lib/jobs/processor.ts`:
  - Add `case "deploy/run.requested": return handleDeploy(parseJobPayload(name, raw));`.
  - Export `handleCreateDatabaseBackup`.
- Test: `tests/deploy-job.test.ts`

**Interfaces:**
- Consumes: Task 2 `buildDeployScript`; Task 3 repository functions; `createRun`/`appendRunOutput`/`completeRun`/`failRun` (`lib/run-progress.ts`); `loadEnvironmentWithServers`; `executeRemoteCommand` (`lib/ssh.ts`); `enqueue`.
- Produces:
  - `requestDeployment(input: { targetId: string; tag: string; trigger: "auto" | "manual" | "rollback"; userId: string | null; buildId: string | null }): Promise<{ deploymentId: string; runId: string }>`
    1. Creates the run with `kind: "deploy"` and description `Deploy <appKey> <tag> (<trigger>)`.
    2. Inserts the deployment.
    3. If the trigger is `auto`, calls `supersedeQueuedAuto(targetId, newId)`.
    4. Enqueues `deploy/run.requested`.
  - `handleDeploy(data: JobMap["deploy/run.requested"]): Promise<{ status: "success" | "failed" | "superseded" | "requeued" }>`:
    1. Call `claimDeployment`.
       - `"gone"`: append `Superseded by a newer build` to the run, complete the run, and return `superseded`.
       - `"busy"`: append `Waiting for the running deploy in this environment`, re-enqueue the same payload with `delayMs: 15000`, and return `requeued`.
    2. If `backupBeforeDeploy`: create a child run with `kind: "backup"` and await `handleCreateDatabaseBackup({ environmentId, runId: childRunId })`. On a throw, append `Backup failed — deploy aborted`, `finishDeployment(failed)`, `failRun`, and return `failed`. No deploy SSH command is sent.
    3. Run `executeRemoteCommand(serverCreds, buildDeployScript(...), 20 * 60_000)`. The SSH credentials come from the target's `serverId`, loaded through the same decrypting path `loadEnvironmentWithServers` uses: add `loadServerCredentials(serverId)` to `lib/environments.ts`.
    4. Append the output, then `finishDeployment` + `completeRun`/`failRun`. Any error leads to `failed`; it never triggers a rollback.

- [ ] **Step 1: Write failing tests in `tests/deploy-job.test.ts`.** Mock the ssh, repository, run-progress, environments and queue modules, as in `tests/job-timeouts.test.ts`.
  - `superseded deployment does nothing on the server` (`claimDeployment` → `"gone"`; `executeRemoteCommand` not called). (Review Focus 2.)
  - `busy environment re-enqueues with delayMs 15000 and no SSH`. (Review Focus 2.)
  - `requestDeployment(auto) supersedes older queued auto deployments of the same target`.
  - `backup failure aborts before any deploy command`. Here `backupBeforeDeploy` is true, the backup throws, `executeRemoteCommand` is never called with a script containing `compose up`, and the status is `failed`. (Review Focus 3.)
  - `health failure marks failed and does not enqueue a rollback`. Here `executeRemoteCommand` throws `SSH Command Failed (exit 1): HEALTH TIMEOUT`; `finishDeployment(…,"failed")` is called and `enqueue` is not called. (Review Focus 4.)
  - `success completes run and deployment`.
  - `job payload rejects non-uuid ids` (in `tests/job-payloads.test.ts`).
- [ ] **Step 2: Run** `bun --bun vitest run tests/deploy-job.test.ts tests/job-payloads.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests plus the full suite, `bun run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): queued, serialized deploy job`.

---

### Task 6: Session API for targets, deploy and rollback

**Files:**
- Create: `server/services/deploys.ts`
- Create: `server/routes/deploys.ts`
- Modify: `server/app.ts` (`.route("/api/deploys", deploysRouter)`)
- Create: `web/api/deploys.ts`
- Test: `tests/deploys-api.test.ts`; add the new paths to the `GATED` list in `tests/routes-batch-a.test.ts`

**Interfaces:**
- Consumes: Task 3 repository; Task 5 `requestDeployment`; `requireProjectPermission` (`lib/authz.ts`).
- Produces. All routes are on `sessionRouter()`, and validation uses `json`/`query` from `server/validation.ts`:
  - `GET /api/deploys/targets?environmentId=` (needs `deploy:["view"]`) returns `TargetState[]`.
  - `POST /api/deploys/targets` (needs `deploy:["configure"]`) takes a body with the fields of `deployTargets` minus ids and timestamps, all validated with the Task 2 schemas. `serverId` must be a server already used by a service of that environment. Returns `DeployTarget`.
  - `PATCH /api/deploys/targets/:id` and `DELETE /api/deploys/targets/:id` (`configure`).
  - `POST /api/deploys/deploy` with `{ targetId, tag }` (needs `run`). The tag must exist in `builds` for the target's `appKey` and `sourceBranch` (404 `{error:"Build not found"}` otherwise). Returns `{ deploymentId, runId }` with `trigger: "manual"`.
  - `POST /api/deploys/rollback` with `{ targetId }` (needs `rollback`). Uses `previousTag` (409 `{error:"No previous successful deploy"}` if null). Returns `{ deploymentId, runId }` with `trigger: "rollback"`.
  - Permission checks scope by the target's `environmentId`. `web/api/deploys.ts` mirrors these with `parseResponse`, in the style of `web/api/services.ts`.

- [ ] **Step 1: Write failing tests in `tests/deploys-api.test.ts`** (mock repository, deployments service and authz):
  - `contributor gets 403 on deploy, rollback and target create`.
  - `deploy of a tag not built for the target branch is 404`.
  - `deploy with tag "latest" is 400`. (Review Focus 1.)
  - `rollback without previous tag is 409`.
  - `rollback deploys previousTag with trigger rollback`.
  - `target create rejects deployDir with ".."` and `rejects a server not used by the environment`.
  - All new paths answer 401 without a session (the `GATED` list).
- [ ] **Step 2: Run** `bun --bun vitest run tests/deploys-api.test.ts tests/routes-batch-a.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): target, deploy and rollback API`.

---

### Task 7: Deploys page, history kind, i18n

**Files:**
- Create: `web/routes/$locale/_app/$projectKey.$envSlug.deploys.tsx`
- Create: `web/routes/$locale/_app/-components/env/deploys/deploys-client.tsx`
- Create: `web/routes/$locale/_app/-components/env/deploys/target-form-dialog.tsx`
- Modify: `components/app-sidebar.tsx:72` (add `{ key: "deploys", url: "/deploys", icon: Rocket }` after services)
- Modify: `web/routes/$locale/_app/-components/env/history-client.tsx:26-40` (`KINDS` + `KIND_LABEL_KEY.deploy = "kindDeploy"`)
- Modify: `web/routes/$locale/_app/-components/home/attention-list.tsx:15` (`KINDS` + `deploy`)
- Modify: `messages/{ar,en,es,id,zh}.json` (new namespace `deploys`; `history.kindDeploy`; `homePage.kind.deploy`; sidebar key)

**Interfaces — Consumes:** Task 6 `web/api/deploys.ts`; `useProjectCan` (`components/project-role.tsx`); `LiveRunDialog`.

**Behaviour:**
- One card per target, showing:
  - App key, source branch, and an auto-deploy badge.
  - The running tag, or "never deployed".
  - The last 20 builds (tag, commit, received time, pipeline link), each with a **Deploy** button. The running tag's button is disabled.
  - A **Rollback to <previousTag>** button, with a confirm dialog warning that DB migrations are not reverted.
  - The last 20 deployments: tag, trigger, status, user or "auto", time, and a link to the run.
- Deploy and rollback buttons render only when `useProjectCan({ deploy: ["run"] })` / `{ deploy: ["rollback"] }`. Add and edit target only with `configure`.
- After an action, open `LiveRunDialog` for the returned `runId`.
- A failed latest deployment shows a destructive badge.
- Use existing shadcn/ui (Base UI) components and Panel page patterns. Before writing markup, read `~/.claude/projects/-var-home-romi/memory/shadcn-2026-base-ui-metrics.md`.

- [ ] **Step 1:** Add the i18n keys to all five catalogues. Add a test in `tests/` asserting that every key under `deploys` exists in all five files with the same key set. Copy any existing catalogue-parity test; otherwise write it in this task.
- [ ] **Step 2: Run** that test. Expected: FAIL until the keys exist, then PASS.
- [ ] **Step 3:** Implement the route, the components, the sidebar entry and the kind lists.
- [ ] **Step 4: Run** `bun run typecheck && bun run lint && bun run test`. Expected: all pass.
- [ ] **Step 5:** Run `bun run dev`. Using a target pointed at a throwaway compose project on a dev box, check the following, and record any you could not check:
  - The page renders.
  - A contributor sees no action buttons.
  - A manual deploy streams its run.
- [ ] **Step 6: Commit** `feat(deploy): environment deploys page`.

---

### Task 8: Contract doc and release checklist

**Files:**
- Create: `docs/deploy.md`

**Content (decides, not just describes):**
- The hook contract: URL, header, body, response codes, and the replay semantics.
- The bundle convention (Global Constraints).
- An example Woodpecker notify step:
  - `curl` with `openssl dgst -sha256 -hmac "$OPSDECK_NOTIFY_SECRET"` over the exact body file.
  - `--data-binary @body.json`.
- Server prerequisites:
  - The SSH user can run `docker` and write the deploy dir.
  - `.env` is hand-placed with every deploy-time value.
  - `compose.override.yaml` stays server-only.
- How to register an app (`scripts/deploy-app.ts`) and a target (the UI).
- The release order:
  1. Apply the migrations by the hand procedure in the opsdeck memory `db-migrations.md` (pg_dump → `ROLLBACK` dry run → apply `20261104000000` then `20261104000100` → add rows to that memory's table).
  2. Set `DEPLOY_REGISTRY` in `/deployments/dss-panel/.env`.
  3. Deploy the Panel.
- [ ] **Step 1:** Write `docs/deploy.md`.
- [ ] **Step 2:** Run `bun run lint` (Biome ignores md; just confirm nothing else changed). Commit `docs(deploy): build hook contract and release checklist`.
- [ ] **Step 3: Stop.** Applying the migrations to production and deploying the Panel are outside this plan. They need Romi's go-ahead, and Plan B's prerequisites must be done first.

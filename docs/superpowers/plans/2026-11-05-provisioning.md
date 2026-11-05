# Provisioning: database hosts, preflight, provisioning run (plan 3b-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An environment can be provisioned from the Panel without SSH or SQL: a server preflight finds runtime, disk, ports and postgres candidates; admins record shared postgres containers as database hosts; a shared database binding gets its role and database created; a resumable provisioning run prepares the deploy dir, creates the database and queues the first deploy.

**Architecture:** Pure command builders and parsers (`lib/provisioning/*`) are kept apart from SSH and DB side effects, following `lib/jobs/commands.ts`. A provisioning plan is stored as ordered rows in `provisioning_steps` per environment. A BullMQ job (`provision/run.requested`) runs the steps in order from the first one not `done`, inside an ordinary `runs` row (kind `provision`). That makes a retry a new run that skips completed steps. Every step is idempotent on the server.

**Tech Stack:** Bun, Hono, React 19 + TanStack, Drizzle (hand-written SQL migration), BullMQ/Valkey, node-ssh, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-04-app-environment-wizard-design.md`: "Server (existing, extended)", "Environment → Database binding", "Review and provisioning". The plan split is the controller's call. Plan 3b-2 follows and adds the Cloudflare steps: an account token record, remotely-managed tunnel route, DNS and Access. Its prerequisite is that Romi creates the account-level token. Plan 4 (wizard UI) builds the Review screen on this plan's `planProvisioning`.

## Global Constraints

- Database kinds on the db service: `shared` (a registered database host), `container` (the app's own compose service; no provisioning step), `external` (connection details live in variables; no provisioning step). Null = legacy binding, behaviour unchanged.
- A shared binding's database and role are named `<projectkey lowercased>_<suffix>` (e.g. `hris_staging`). This matches `^[a-z][a-z0-9_]{0,62}$` and is unused by any other environment bound to that host *(controller's call: SQL identifiers use underscores; the spec example is `hris_staging`)*.
- The role password is the environment variable named by `db_password_variable` (kind `generated` or `secret`). Postgres receives only a SCRAM-SHA-256 verifier computed in the Panel. SQL goes to `docker exec -i <container> psql -U postgres -v ON_ERROR_STOP=1` on stdin. No plaintext password in argv, the run log, the Panel log or the postgres log.
- The Panel stores no superuser password (spec). It uses trusted local auth inside the container, as the existing db ops do.
- Free entry ports are picked in `8100–8999` *(controller's call)*. They exclude listening TCP ports (`ss -Htln`), docker published ports, and `environments.entry_port` of other environments deploying to the same server.
- One provisioning run per environment at a time, enforced in the DB by `pg_advisory_xact_lock` on the environment id when the run is created.
- Who may provision: the caller must hold `deploy` permission on the environment's project (project maintainer or admin). Provisioning never re-checks placement; placement was checked when the bindings were saved.
- Database hosts and preflight are managed with org `server:manage`.
- Migration is additive, `BEGIN; … COMMIT;`, and applied (backup → dry run → apply) before the build.
- English for code/comments/commits; UI strings in all five `messages/*.json` (en, id translated).
- `bun run typecheck`, `bun run lint`, `bun run test` green before each commit.

## Review Focus

1. **Open server + shared host:** a maintainer without `server:manage` binds a sandbox to the registered `dplk-postgres` on an open server. Expected: allowed only with a `<key>_` database/role name that no other environment on that host uses. Database ops (backup/restore/create/drop/rename, database list) for that binding are confined to the bound name and names starting with `<dbName>_`, so another environment's database can't be dropped through it. The SQL shell is refused for such a caller (Task 3).
2. **Retry after a failed step** (e.g. the DB host container stopped): the retry run skips `done` steps, re-runs the failed one, and a second create of an existing role/database succeeds without changing ownership of a database owned by someone else. A database that exists with another owner fails with a clear message (Task 3, Task 4).
3. **Two clicks on "Provision"** (or provision while a run is still `started`): the second request gets 409 and no second job is queued (Task 4).
4. **Secrets:** the run log and the thrown errors of the database step never contain the password or the verifier, including when psql fails (Task 3).
5. **Deploy step with no build yet / a deploy lock active:** the step fails with a message naming the branch, or the lock reason and expiry. Earlier steps stay `done`. A retry after the first build lands queues the deployment (Task 4).

---

### Task 1: Schema and migration

**Files:**
- Create: `drizzle/20261105050000_provisioning/migration.sql`
- Modify: `lib/db/schema.ts`
- Test: `tests/provisioning-migration.test.ts`

**Interfaces:**
- Produces (schema, Drizzle names in parentheses):
  - enum `database_kind` = `shared | container | external`;
  - enum `provisioning_step_kind` = `prepare_deploy_dir | create_database | deploy`;
  - enum `provisioning_step_status` = `pending | running | done | failed`;
  - `run_kind` gains `provision` (`ALTER TYPE … ADD VALUE`, outside the transaction block per Postgres rules; put it first and note it in the file).
  - `database_hosts` (`databaseHosts`): `id uuid pk uuidv7()`, `server_id uuid not null → servers restrict`, `container_name text not null`, `backup_path text not null` (path inside the container), `label text not null`, timestamps; unique `(server_id, container_name)`; index `server_id`.
  - `environment_services`: `db_kind database_kind null` (`dbKind`), `database_host_id uuid null → database_hosts restrict` (`databaseHostId`), `db_role text null` (`dbRole`), `db_password_variable text null` (`dbPasswordVariable`); index on `database_host_id`; partial unique index `(database_host_id, db_name) where database_host_id is not null`.
  - `environments.entry_port integer null` (`entryPort`), check `entry_port between 1 and 65535`.
  - `servers.preflight jsonb null` (`$type<ServerPreflight>()`), `servers.preflight_at timestamp null`.
  - `provisioning_steps` (`provisioningSteps`): `id uuid pk`, `environment_id → environments cascade`, `position integer not null`, `kind provisioning_step_kind not null`, `params jsonb not null` (non-secret only), `status provisioning_step_status not null default 'pending'`, `last_error text null`, `last_run_id uuid null → runs set null`, `completed_at timestamp null`, `updated_at`; unique `(environment_id, position)`; index `last_run_id`.
  - Type `ServerPreflight` exported from `lib/provisioning/preflight.ts` (Task 2 fills it; Task 1 declares it).

- [ ] **Step 1: Failing static migration test** — `tests/provisioning-migration.test.ts`: the file contains `ALTER TYPE "run_kind" ADD VALUE IF NOT EXISTS 'provision'` before `BEGIN;`, creates the three enums and two tables, adds the four service columns, `entry_port` with its check, `preflight`/`preflight_at`, and contains no `DROP`, no `ALTER COLUMN … SET NOT NULL` and no `RENAME`. Same style as `tests/deploy-lock-migration.test.ts`.
- [ ] **Step 2: Run** `bunx vitest run tests/provisioning-migration.test.ts`. Expected: FAIL (file missing).
- [ ] **Step 3: Write the migration and the schema** (Interfaces above). Apply it on the controller's scratch copy (`provision-scratch`) and confirm `\d provisioning_steps`.
- [ ] **Step 4: Run** the test, then `bun run typecheck && bun run lint && bun run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(provisioning): schema for database hosts, preflight and provisioning steps`

### Task 2: Server preflight and free port

**Files:**
- Create: `lib/provisioning/preflight.ts` (pure: command + parser), `lib/provisioning/ports.ts` (pure), `server/services/preflight.ts`
- Modify: `server/routes/servers.ts`, `web/routes/$locale/_app/servers.$id.index.tsx` (+ a `-components/servers/preflight-card.tsx`), `messages/*.json`
- Test: `tests/preflight.test.ts`, `tests/ports.test.ts`, `tests/preflight-api.test.ts`

**Interfaces:**
- Produces:
  - `type ServerPreflight = { runtime: { docker: string | null; compose: string | null; podman: string | null }; registry: { url: string; ok: boolean; status: number | null } | null; disk: { mount: string; freeBytes: number; totalBytes: number }[]; cloudflared: { systemd: boolean; containers: string[] }; listeningPorts: number[]; publishedPorts: number[]; postgresCandidates: { container: string; image: string }[] }`
  - `buildPreflightCommand(registry: string | null): string`: one POSIX `sh` script. Each probe is fenced by marker lines `@@<name>` and tolerates a missing tool (`|| true`). The probes: `docker version --format '{{.Server.Version}}'`, `docker compose version --short`, `podman version --format '{{.Version}}'`, `curl -s -o /dev/null -m 5 -w '%{http_code}' https://<registry>/v2/` (only when registry is set; shq-quoted), `df -PB1 / /deployments 2>/dev/null`, `systemctl is-active cloudflared`, `docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'`, `ss -Htln`.
  - `parsePreflight(output: string, registry: string | null): ServerPreflight`. Postgres candidates are containers whose image's repository part (before `:`/`@`, after the last `/`) is `postgres` or starts with `postgis`. Cloudflared containers are those whose image contains `cloudflared`. Published ports reuse `parsePublishedPorts` from `lib/tunnels/remote.ts`. `df` duplicates by mount are dropped.
  - `pickFreePort(taken: Iterable<number>, range?: { from: number; to: number }): number | null`: default `{ from: 8100, to: 8999 }`; lowest free.
  - `runServerPreflight(serverId: string): Promise<ServerPreflight>`: SSH with a 30 s timeout. It stores `preflight` + `preflight_at` and records activity `server.preflight` (no output in the log entry).
  - `suggestEntryPort(serverId: string): Promise<{ port: number | null; preflightAt: Date | null }>`: taken ports = stored preflight listening + published ports + `entry_port` of environments with a deploy target on that server.
  - Routes (org `server:manage`): `POST /api/servers/:id/preflight` → `ServerPreflight`; `GET /api/servers/:id/preflight` → `{ preflight, preflightAt }`; `GET /api/servers/:id/free-port` → `{ port, preflightAt }`.

- [ ] **Step 1: Failing tests:**
  - `parsePreflight` on a fixture output captured from a .113-like host (docker 29.x, compose v5.1.4, no podman, registry 200, two df rows, cloudflared active, `dplk-postgres postgres:18.6`, `hris-db postgres:18.6`, `opsdeck-db postgres:18-alpine`, a `cloudflare/cloudflared:2026.8.2` container, ports 22/80/5000/8091) returns those exact fields.
  - Missing-tool output (empty sections) gives `null` runtimes and empty lists, and does not throw.
  - `buildPreflightCommand("registry.example:5000")` contains the shq-quoted registry URL. `buildPreflightCommand(null)` contains no `curl`.
  - `pickFreePort([8100, 8101, 8103])` → `8102`; a fully taken range → `null`.
  - API: a non-`server:manage` caller gets 403. The happy path stores the result (SSH mocked like `tests/deploy-job.test.ts`). `free-port` excludes another environment's `entry_port` on the same server (Review Focus: port collision between two pending environments).
- [ ] **Step 2: Run** `bunx vitest run tests/preflight.test.ts tests/ports.test.ts tests/preflight-api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces. Server page card: "Run preflight" button, last-run time, runtime/compose versions, registry status, free disk per mount, cloudflared state, postgres candidates (with "Register as database host" from Task 3 wired later; render the list only here).
- [ ] **Step 4: Run** the tests and the full check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(servers): preflight probe and free entry port`

### Task 3: Database hosts, shared database binding, guarded db ops

**Files:**
- Create: `lib/provisioning/database.ts` (pure), `server/services/database-hosts.ts`, `server/routes/database-hosts.ts`
- Modify: `lib/ssh.ts` (`executeRemoteCommand` gains an options object with `stdin?: string`; existing positional `timeoutMs` callers keep working), `lib/validation.ts` (environment input: db binding fields), `server/services/environments.ts` (`requireEnvironmentPlacement` + binding derivation), `server/services/databases.ts` + `server/services/backups.ts` (name confinement), `server/routes/terminal.ts`/its authorize path (shell refusal), server page card (register/delete host), `messages/*.json`
- Test: `tests/provisioning-database.test.ts`, `tests/database-hosts-api.test.ts`, `tests/placement.test.ts` (extend), `tests/shared-db-confinement.test.ts`

**Interfaces:**
- Consumes: `ServerPreflight.postgresCandidates` (Task 2), schema (Task 1).
- Produces:
  - `scramSha256Verifier(password: string, opts?: { salt?: Uint8Array; iterations?: number }): string`: RFC 7677/5803 format `SCRAM-SHA-256$<iter>:<b64 salt>$<b64 StoredKey>:<b64 ServerKey>`; default 4096 iterations, 16-byte random salt; `node:crypto` `pbkdf2Sync`/`createHmac`/`createHash`.
  - `sharedDatabaseNameSchema`: zod, `^[a-z][a-z0-9_]{0,62}$`.
  - `pgProvisionDatabaseSql(input: { database: string; role: string; verifier: string }): string`: SQL for psql stdin. It creates the role `LOGIN` with `PASSWORD '<verifier>'` when missing, else `ALTER ROLE … PASSWORD '<verifier>'`. It then checks `pg_database`: when the database is missing it runs `CREATE DATABASE … OWNER <role>` through `\gexec`; when it exists with another owner it raises `database % exists with owner %`. Identifiers go through `pgQuoteId`, literals through `pgQuoteLiteral`. Each statement ends with `;`. `\set ON_ERROR_STOP on` comes first.
  - `provisionSharedDatabase(host: { server: Server; containerName: string }, input: { database: string; role: string; password: string }): Promise<void>`: runs `docker exec -i <shq container> psql -U postgres -X -q` with the SQL on stdin. On failure it throws an `Error` whose message passes through `redactSecrets(message, [password, verifier])` (replaces each occurrence with `[redacted]`).
  - Database hosts service (org `server:manage`): `listDatabaseHosts(serverId?)`, `createDatabaseHost({ serverId, containerName, backupPath, label })` (verifies with `docker exec <c> psql -U postgres -Atc 'select 1'`), `deleteDatabaseHost(id)` (409 when bound). Routes `GET/POST /api/database-hosts`, `DELETE /api/database-hosts/:id`; activity `database_host.create|delete`.
  - Environment input: db service may carry `dbKind`, `databaseHostId`, `dbRole`, `dbPasswordVariable`. With `dbKind: "shared"` the service derives `serverId`, `serviceType: "docker"`, `serviceName = host.containerName`, `dbType: "postgres"`, `dbBackupPath = host.backupPath` from the host and ignores client values for those. `dbName`/`dbRole` must pass `sharedDatabaseNameSchema` and start with `<key lowercased>_`; `dbPasswordVariable` must match `envVarNameSchema`.
  - Placement rule change (`requireEnvironmentPlacement`): on an open server, a caller without `server:manage` may bind a db service to a **registered database host**, by (serverId, containerName) or `databaseHostId`, instead of a `<key>-` service name, provided its `dbName` is `<key>_`-prefixed and unused by another environment's db service on that host. Any other unprefixed name keeps failing as today.
  - Confinement `allowedDatabaseName(binding, name, canManageServers): boolean`: a pure helper in `lib/provisioning/database.ts`. When `dbKind === "shared"` and the caller lacks `server:manage`, only `dbName` itself and names starting with `${dbName}_` are allowed. Everything else is unchanged. Applied to every client-supplied `database` in databases.ts (create/drop/rename both names, list filters the result to allowed names) and backups.ts (backup/restore target and source). The SQL shell (`buildDbShellCommand` path) and the server terminal refuse such a caller on that environment with 403.

- [ ] **Step 1: Failing tests:**
  - **Verifier:**
    - with salt `0x00…0f` (16 bytes) and 4096 iterations it has the exact format `SCRAM-SHA-256$4096:AAECAwQFBgcICQoLDA0ODw==$<44 chars>:<44 chars>`;
    - recomputing `StoredKey = SHA256(HMAC(SaltedPassword, "Client Key"))` and `ServerKey = HMAC(SaltedPassword, "Server Key")` in the test matches;
    - two calls without a salt differ;
    - the scratch-DB integration test (below) proves postgres accepts it: `psql` login as the role with the plaintext password succeeds.
  - **SQL:** contains no plaintext password. Quotes `x"y` role names. Starts with `\set ON_ERROR_STOP on`. Contains `\gexec`.
  - **provisionSharedDatabase:**
    - the SSH mock receives the SQL on `stdin`, and argv has no password/verifier;
    - a psql failure whose stderr echoes the verifier yields an error message without it (Review Focus 4).
  - **Scratch-DB integration:** create → re-run (idempotent, password changed) → database exists with another owner → error (Review Focus 2). Behind `PROVISION_SCRATCH_URL`, skipped when unset; the controller runs it.
  - **Placement:**
    - an open server with host `dplk-postgres` registered: a contributor-maintainer binding `{dbKind:"shared", databaseHostId, dbName:"pcan_sandbox1"}` passes;
    - `dbName:"other_db"` → 403;
    - the same `pcan_sandbox1` already used by another environment → 403;
    - an unregistered unprefixed container → 403 (unchanged).
  - **Confinement** (Review Focus 1):
    - a shared binding `pcan_sandbox1` for a maintainer: drop `pcan_sandbox1_copy` → allowed; drop `hris_dss` → 403;
    - list returns only allowed names;
    - restore with `database:"hris_dss"` → 403;
    - SQL shell → 403;
    - the same calls by an admin → allowed.
  - **Hosts API:** 403 without `server:manage`; delete while bound → 409.
- [ ] **Step 2: Run** the four test files. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces. The server page postgres candidates get "Register" (prefills container name; backup path default `/var/lib/postgresql/backups`); registered hosts list with delete.
- [ ] **Step 4: Run** the tests and the full check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(provisioning): database hosts and shared database bindings`

### Task 4: Provisioning plan, run and API

**Files:**
- Create: `lib/provisioning/plan.ts` (pure), `lib/provisioning/repository.ts`, `lib/jobs/provision.ts`, `server/services/provisioning.ts`, `server/routes/provisioning.ts`
- Modify: `lib/queue.ts` (`"provision/run.requested": { environmentId: string; runId: string }`), `lib/jobs/payloads.ts`, `lib/jobs/processor.ts` (dispatch), `server/router.ts`
- Test: `tests/provisioning-plan.test.ts`, `tests/provisioning-job.test.ts`, `tests/provisioning-api.test.ts`

**Interfaces:**
- Consumes:
  - `provisionSharedDatabase`, `decodeVariableValue` (`lib/variables/managed-env.ts`);
  - `placeDeployment` (`lib/deploy/repository.ts`, trigger `manual`, user = run's user);
  - the deploy lock outcome `locked`.
- Produces:
  - `type ProvisioningStepSpec = { kind: "prepare_deploy_dir"; params: { serverId: string; deployDir: string } } | { kind: "create_database"; params: { databaseHostId: string; database: string; role: string; passwordVariable: string } } | { kind: "deploy"; params: { targetId: string; branch: string } }`.
  - `planProvisioning(env: { targets: { id: string; serverId: string; deployDir: string; sourceBranch: string }[]; db: { dbKind: string | null; databaseHostId: string | null; dbName: string | null; dbRole: string | null; dbPasswordVariable: string | null } | null }): ProvisioningStepSpec[]`. Order: one `prepare_deploy_dir` per distinct (server, deployDir), then `create_database` when `dbKind === "shared"`, then one `deploy` per target. It throws `ProvisioningPlanError` with code `missing_db_fields` when a shared binding lacks role/password variable, and code `no_targets` when there are no targets.
  - `prepare_deploy_dir` runs `install -d -m 0750 <shq dir>` over SSH. This is idempotent; it never chmods an existing dir. The command is `[ -d dir ] || install -d -m 0750 dir`.
  - `create_database` loads the password variable. It must exist, be non-empty and have kind `generated`/`secret`; otherwise it fails with "variable X missing". Then it calls `provisionSharedDatabase`.
  - `deploy` takes the newest `builds` row for the target's component and branch:
    - no build → fail "No build of `<branch>` yet; retry after the first build";
    - `placeDeployment` → `locked` → fail with the lock reason + expiry (WIB);
    - queued/held → `done` with the deployment id logged. The provisioning run does not wait for the deploy; the deploy has its own run.
  - Repository:
    - `savePlan(environmentId, specs)`: replaces all non-`done` steps. `done` steps whose kind+params equal a spec are kept in place, so a re-plan after an edit keeps finished work;
    - `listSteps(environmentId)`;
    - `startProvisioningRun(environmentId, userId): Promise<{ runId: string } | { conflict: true }>`: one transaction with `pg_advisory_xact_lock(hashtextextended(environmentId, 0))`; conflict when a `provision` run of that environment is `started`;
    - `markStep(id, status, { error?, runId })`.
  - Job `runProvisioning({ environmentId, runId })`:
    - for each step in position order that is not `done`: mark `running`, log `▶ <kind> <safe summary>`, execute, mark `done`;
    - on error: mark `failed` with the redacted message, `failRun`, stop;
    - when all are done: `completeRun`.
    - A worker crash leaves a step `running`. The next run treats `running` like `failed`, which is safe because every step is idempotent.
  - API (project `deploy` permission on the environment):
    - `GET /api/environments/:id/provisioning` → `{ steps, plan: ProvisioningStepSpec[], activeRunId }`. `plan` is a dry preview from the current config;
    - `POST /api/environments/:id/provisioning` → `savePlan` + `startProvisioningRun` + enqueue → `{ runId }`; 409 on conflict; 422 with the plan error code;
    - activity `environment.provision` (no params with secrets).

- [ ] **Step 1: Failing tests:**
  - **Plan:**
    - a shared DB + one target gives `[prepare_deploy_dir, create_database, deploy]`;
    - `container`/`external`/null kinds have no `create_database`;
    - two targets in the same dir give one `prepare_deploy_dir`;
    - missing role → `missing_db_fields`.
  - **savePlan:** keeps an identical `done` step, replaces a changed one.
  - **Job:**
    - a step failing at `create_database` leaves `prepare_deploy_dir` `done` and fails the run;
    - a second run skips it and finishes (Review Focus 2);
    - `deploy` with no build → failed with the branch in the message;
    - lock active → failed with the reason (Review Focus 5);
    - a `running` leftover is retried;
    - the log never contains the password (Review Focus 4).
  - **API:**
    - a contributor (QA) → 403;
    - a maintainer → 200 + job enqueued;
    - a second POST while `started` → 409 and only one job enqueued (Review Focus 3);
    - plan error → 422 with its code.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the tests and the full check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(provisioning): resumable provisioning run`

### Task 5: Environment UI — database binding and provisioning panel

**Files:**
- Modify: `web/routes/$locale/_app/$projectKey.$envSlug.settings.tsx` and its db-service form component (database kind select; for `shared`: database host select filtered to the db server choices, database name, role, password variable select from the environment's `generated`/`secret` variables; suggest `<key>_<envslug with - → _>` for name and role), the environment overview page (`$projectKey.$envSlug.index.tsx` or the deploys page), `messages/*.json`
- Create: `web/routes/$locale/_app/-components/env/provisioning-panel.tsx`
- Test: `tests/provisioning-panel.test.tsx`, existing environment form tests

**Interfaces:**
- Consumes: Task 3 environment input fields and `GET /api/database-hosts`; Task 4 provisioning API.

- [ ] **Step 1: Failing tests:**
  - The panel renders the preview plan as an ordered list using the human sentences from the spec, e.g. "Create role and database `hris_staging` on `dplk-postgres` (.113)", "Prepare `/deployments/hris`", "Deploy the latest `main` build".
  - Statuses (pending/running/done/failed) show with the step's error.
  - "Provision" (or "Retry" when any step failed) is disabled while `activeRunId` is set and links to the run log.
  - The button is hidden for users without deploy permission.
  - The form sends `dbKind`/`databaseHostId`/`dbRole`/`dbPasswordVariable` for shared and omits them for other kinds.
- [ ] **Step 2: Run** `bunx vitest run tests/provisioning-panel.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement**. Use shadcn/Base UI components already used by the deploys page (read `~/.claude/projects/-var-home-romi/memory/shadcn-2026-base-ui-metrics.md` before sizing). Poll the GET every 3 s while a run is active.
- [ ] **Step 4: Run** the tests and the full check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(provisioning): database binding form and provisioning panel`

### Task 6: Go live (controller)

- [ ] Take a backup, dry-run the migration in a transaction, and apply it. Merge and push. Romi runs Jenkins `DSS/dss-panel`; health must return 200.
- [ ] Run preflight on .113 from the server page. Check the result against `ssh` facts: compose v5.1.4, cloudflared active, `dplk-postgres`/`hris-db`/`opsdeck-db` candidates.
- [ ] Register `dplk-postgres` on .113 as a database host. *(Assumption: it exists on .113 — verify from the preflight first; if not, use the postgres container the preflight lists for the canary.)*
- [ ] On project PCAN, environment Canary:
  - add generated variable `DB_PASSWORD`;
  - set the db service to shared `pcan_canary` / role `pcan_canary` / `DB_PASSWORD`;
  - press Provision. Expected: three steps done, `pcan_canary` exists with owner `pcan_canary`, `rolpassword` starts with `SCRAM-SHA-256$`, the run log has no password, the deploy is queued and succeeds.
- [ ] Report as not tested live: a stopped database host container. .113 is production; the failure + retry path is covered by Task 4 tests and the scratch integration test.

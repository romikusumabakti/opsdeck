# Variables, `.env` rendering and environment access (plan 3a of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Environments can hold their variables in the Panel (plain, secret, generated; encrypted at rest), and a deploy of an environment that opts in writes the server's `.env` from them; servers carry a placement policy, the environment owner stays a label (owner rights removed after the final review; a deploy lock follows in plan 3a.1), and pipeline-file commits refuse branches that do not exist.

**Architecture:** Two new tables (`app_variable_templates`, `environment_variables`) plus `environments.env_file_managed` (opt-in, default off, so every existing environment keeps today's behaviour) and `servers.placement`. A pure renderer turns variables into `.env` text; the deploy job uploads it over SFTP (never in a command line) and the deploy script installs it under the existing lock. Authorization grows one rule: placement (who may put an environment on a server); the ownership rule first built here was removed after the final review.

**Tech Stack:** Bun, Hono, React 19 + TanStack, Drizzle (hand-written SQL migrations), Zod, Vitest, Biome, node-ssh (existing `lib/ssh.ts`).

**Spec:** `docs/superpowers/specs/2026-11-04-app-environment-wizard-design.md` (sections "Variables", "Server (existing, extended)", decisions "Users", "Restriction", "Environment owner"). Plan 3b (provisioning steps: database hosts, Cloudflare, preflight, ports, provisioning run) and plans 4–5 follow.

## Global Constraints

- Variables: values encrypted with `lib/secrets.ts` for kinds `secret` and `generated`; `plain` stored as text. Secret values are visible only to project maintainers and admins; never in logs, run output, error messages or command lines.
- `.env` is rendered from the Panel's variables plus the tag variable(s) on every deploy **only when `environments.env_file_managed` is true**; otherwise the deploy behaves exactly as today (only the tag line changes). Server-only files other than `.env` are never touched.
- `.env` on the server: mode `0600`, written atomically (temp file + rename in the same directory), the previous file kept as `.env.opsdeck-prev` (`0600`), and the hand-written file from before the first managed deploy kept once as `.env.opsdeck-unmanaged` (`0600`, never overwritten).
- Reserved names: variable and template names may not start with `COMPOSE_`, `DOCKER_` or `BUILDKIT_` (Compose/Docker read them from `.env`; `COMPOSE_PROJECT_NAME` or `COMPOSE_FILE` would retarget the deploy) — refused when saved, and the `.env` render refuses rows saved earlier.
- Escrowed variables also block deleting their environment (409) unless an admin with org `integration:manage` confirms it (`confirmEscrowedDeletion`).
- Escrowed variables (`escrow = true`, e.g. HRIS `DATA_ENCRYPTION_KEY`) can never be regenerated or deleted through the UI/API; the UI warns they must also be stored outside the Panel.
- Placement: `servers.placement` is `restricted` (default — today's rule: project `environment:create` + org `server:manage`) or `open` (project `environment:create`, i.e. project maintainers, without org `server:manage`; contributors (QA) never create environments). On an open server a caller without `server:manage` binds only service names that start with the project key lowercased plus `-` and that no other environment on that server uses. Existing servers stay `restricted`.
- Owner: owner rights were removed after the final review (owner decision 2026-11-05: QA do not deploy; developers are project maintainers). `environments.owner_id` is a label (the creator by default) and grants nothing; deploys, variables and environment edits follow the project role only. The owner gets a deploy lock in a follow-up plan (3a.1).
- English for code/comments/commits; UI strings in all five `messages/*.json` (en, id translated).
- Migrations additive, `BEGIN; … COMMIT;`, applied before the build that needs them.
- `bun run typecheck`, `bun run lint`, `bun run test` green before each commit.

## Review Focus

1. A variable value containing `#`, spaces, `=`, quotes, `$` or a backslash must round-trip through `.env` exactly as Docker Compose reads it (no interpolation of `$`, no truncation at `#`); a value with a newline is rejected when saved.
2. A deploy of an environment with `env_file_managed = false` must send no `.env` upload and run a script byte-identical to today's for the same input.
3. A failed upload or install of `.env` must stop the deploy before `docker compose pull/up` and leave the previous `.env` in place.
4. ~~An owner who is only `viewer` can deploy their own environment~~ — superseded (owner rights removed): an owner who is only `viewer` or `contributor` gets 403 on `deploy:run` and `variable:read` like anyone with that role.
5. Changing a server from `open` to `restricted` must not affect existing environments on it, only new placements.

---

### Task 1: Schema

**Files:**
- Create: `drizzle/20261105020000_variables_and_access/migration.sql`
- Modify: `lib/db/schema.ts`, `lib/db/relations.ts`
- Test: `tests/variables-migration.test.ts`

**Interfaces:**
- Produces:
  - `variableKindEnum = pgEnum("variable_kind", ["plain", "secret", "generated"])`, `serverPlacementEnum = pgEnum("server_placement", ["restricted", "open"])`.
  - `appVariableTemplates`: `id`, `appId → apps.id on delete cascade`, `name text`, `kind`, `required boolean default false`, `defaultValue text null` (plain only; may contain placeholders `{host}`, `{url}`, `{envSlug}`), `generatedLength integer null` (generated only, 16–128, default 32), `escrow boolean default false`, `description text null`, timestamps; unique `(app_id, name)`.
  - `environmentVariables`: `id`, `environmentId → environments.id on delete cascade`, `name`, `kind`, `value text` (encrypted unless plain), `escrow boolean default false`, `updatedBy uuid null → users.id on delete set null`, timestamps; unique `(environment_id, name)`.
  - `environments.envFileManaged boolean not null default false`; `servers.placement server_placement not null default 'restricted'`.

- [ ] **Step 1:** failing static test (one transaction, no DROP/RENAME, both enums, both unique indexes, both defaults).
- [ ] **Step 2–3:** FAIL → write migration + schema + relations.
- [ ] **Step 4:** apply on the scratch copy prepared by the controller (`var-mig-scratch`, db `dss_panel`); every environment reads `env_file_managed = false`, every server `restricted`; tests + typecheck green.
- [ ] **Step 5: Commit** `feat(db): environment variables, app templates, placement policy`

### Task 2: `.env` renderer and variable rules

**Files:**
- Create: `lib/variables/env-file.ts`, `lib/variables/validation.ts`
- Test: `tests/env-file.test.ts`, `tests/variables-validation.test.ts`

**Interfaces:**
- Produces:
  - `variableNameSchema` — `^[A-Z_][A-Z0-9_]*$`, max 128; reserved: the environment's tag variable names (passed in) may not be defined as variables.
  - `variableValueSchema` — string, max 8192, no `\n`/`\r`/NUL.
  - `renderEnvFile(vars: { name: string; value: string }[], tags: Record<string, string>): string` — lines sorted by name, tag lines last, trailing newline; header `# Managed by DSS Panel — edit variables in the Panel; local edits are overwritten on the next deploy.`; quoting rule: a value without `'` is written single-quoted (`NAME='value'`, literal in compose-go's dotenv parser: no interpolation, `#` kept); a value containing `'` is written double-quoted with `\` → `\\`, `"` → `\"` and `$` → `$$`. Verify this against compose-go's dotenv parser source (the version used by Docker Compose v2 on the hosts) before relying on it, and pin it with the tests below. Document the chosen rule in a comment citing compose-go.
  - `resolvePlaceholders(value: string, ctx: { host: string | null; url: string | null; envSlug: string }): string` — replaces `{host}`, `{url}`, `{envSlug}`; an unknown `{…}` is left as is; a placeholder whose context value is null → error `Placeholder {url} has no value for this environment`.
  - `generateValue(length: number): string` — URL-safe random (base64url of `crypto.randomBytes`), exactly `length` characters.

- [ ] **Step 1: Failing tests** (Review Focus 1): round-trip table for `a#b`, `with space`, `x=y`, `it's`, `say "hi"`, `$HOME`, `${VAR}`, `back\slash`, `''`, unicode — parse the rendered file with a **reference parser written in the test from compose-go's documented rules** and expect the original values; newline/CR/NUL rejected by `variableValueSchema`; names sorted, tags last; placeholders; `generateValue(32).length === 32` and only `[A-Za-z0-9_-]`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(variables): render .env files and validate variables`

### Task 3: Authorization — placement and ownership

> **Note:** owner rights removed after final review (owner decision). `OWNER_PERMISSIONS`, `canEnvironment` and the owner-aware guards were deleted in the final fix wave; `open` placement became project `environment:create` only. The interfaces below are kept as the record of what was first built.

**Files:**
- Modify: `lib/permissions.ts`, `lib/authz.ts`, `server/services/environments.ts` (create path), `server/services/deploys.ts` (deploy/rollback/configure checks), the server edit form/service (`placement` field, admin only)
- Test: `tests/placement.test.ts`, `tests/owner-rights.test.ts`

**Interfaces:**
- Produces:
  - `canPlaceEnvironment(orgRole: string | null | undefined, projectRole: ProjectRole | null, placement: "restricted" | "open"): boolean` — `restricted`: `canCreateEnvironment(orgRole, projectRole)`; `open`: `canProject(projectRole, { environment: ["create"] })` or projectRole ∈ {contributor, maintainer}.
  - `OWNER_PERMISSIONS: ProjectPermissions` = `{ deploy: ["view","run","rollback","configure"], environment: ["update","delete"], variable: ["read","write"] }` (add statement `variable: ["read","write"]` to `projectStatements`; maintainer gets both, contributor and viewer none).
  - `requireProjectPermission` (existing, `lib/authz.ts:201`) accepts the environment's owner for any request fully covered by `OWNER_PERMISSIONS`, provided the user has at least `viewer` on the project (Review Focus 4). Ownership is read fresh per request (no cache beyond the existing request cache).
  - Environment creation picks the rule from the chosen servers: all servers bound by the environment must allow the placement; the creator becomes `owner_id` when none is given.

- [ ] **Step 1: Failing tests:** placement matrix (admin/infra/member × viewer/contributor/maintainer × restricted/open); owner-viewer can `deploy:run` own env, not a sibling env; owner removed → 403; owner without any project role → 403; server form: only `server:manage` can change placement; changing placement leaves existing environments untouched (Review Focus 5 — assert no environment rows are read or written by the update).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(authz): server placement policy and environment owner rights`

### Task 4: Variables API and UI

**Files:**
- Create: `server/services/variables.ts`, `server/routes/variables.ts`, `web/api/variables.ts`, `web/routes/$locale/_app/$projectKey.$envSlug.variables.tsx`, `web/routes/$locale/_app/apps.$appKey.variables.tsx` (template editor) — follow the existing env route and app page patterns
- Modify: `server/app.ts`, `components/app-sidebar.tsx` (env item "Variables", `perm: { variable: ["read"] }`), messages
- Test: `tests/variables-api.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `GET /api/environments/:id/variables` (`variable:read`; secret/generated values masked as `null` with `hasValue: true` unless `?reveal=1`, which also requires `variable:read` and writes an activity entry `variables.revealed`), `PUT /api/environments/:id/variables/:name` (`variable:write`; body `{ kind, value?, escrow? }`; `generated` without value → generated now with the template's length or 32), `DELETE …/:name` (refused 409 for escrowed), `POST …/:name/regenerate` (generated only; refused for escrowed), `POST /api/environments/:id/variables/apply-template` (fills missing variables from the app template: defaults with placeholders resolved, generated values created, required-without-default listed back as `missing`), `PATCH /api/environments/:id/env-file-managed` (`variable:write` + `deploy:configure`; turning it on requires every required template variable to exist → else 409 listing them).
  - Template CRUD on `/api/apps/:appKey/variable-templates` (`integration:manage`).
  - Every write records `updatedBy`; responses never contain decrypted values except `reveal`.
  - Env page: table (name, kind, value masked/revealed, escrow badge, updated by/at), add/edit dialog, regenerate, "Fill from app template", the `env_file_managed` switch with an explanation ("When on, the next deploy replaces the server's .env with these variables").

- [ ] **Step 1: Failing tests:** permission matrix per route (maintainer, owner-viewer, contributor non-owner → 403); masked by default; reveal logs activity; escrowed delete/regenerate → 409; apply-template resolves `{url}` and reports missing required; turning `env_file_managed` on with a missing required → 409; no response body ever contains a decrypted secret without `reveal`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(variables): manage environment variables in the Panel`

### Task 5: Deploys write `.env` for managed environments

**Files:**
- Modify: `lib/deploy/script.ts` (input `installStagedEnvFile: boolean`), `lib/jobs/deploy.ts` (render + upload before running the script), `lib/ssh.ts` (add `uploadRemoteContent(creds, content, remotePath, mode)` — writes via SFTP from memory, no local temp file, sets mode before data is written)
- Test: `tests/deploy-script.test.ts`, `tests/deploy-job.test.ts`

**Interfaces:**
- Consumes: Task 2 `renderEnvFile`, `resolvePlaceholders`; Task 1 tables.
- Produces:
  - Job: when the target's environment has `envFileManaged`, decrypt its variables, render with the tag variable set to the deploying tag (and, for multi-component apps, the other components' tag variables keep the server's current values — read with `grep` of only those lines from the server `.env`), upload to `<deployDir>/.env.opsdeck-new` with mode `0600`; then run the script with `installStagedEnvFile: true`.
  - Script: after taking the lock and after the bundle step (`docker rm $cid`), before the tag step and `docker compose pull`, when `installStagedEnvFile`: keep the hand-written `.env` once as `.env.opsdeck-unmanaged` (`0600`, if absent), `cp -p .env .env.opsdeck-prev` (if `.env` exists), `chmod 600 .env.opsdeck-new`, `mv -f .env.opsdeck-new .env`; on any failure exit non-zero before pull (Review Focus 3). Without the flag, the script is byte-identical to today's (Review Focus 2 — snapshot test).
  - Run output shows `Wrote .env (N variables)` — never values or names of secret variables.

- [ ] **Step 1: Failing tests:** script snapshot unchanged without the flag; with the flag, the install lines come after the lock and before the first `docker compose pull`; job uploads only when managed; upload failure → deployment failed, script never run; run output contains no variable value (assert against a fixture with distinctive secret strings); multi-component tag preservation.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(deploy): write .env from Panel variables for managed environments`

### Task 6: Pipeline-file commits refuse unknown branches

**Files:**
- Modify: `lib/ci/forges/bitbucket.ts` (`branchExists(auth, repoFullName, branch): Promise<boolean>` via `GET /2.0/repositories/<repo>/refs/branches/<urlencoded branch>` — 200 true, 404 false, other → `CiProviderError`), `lib/apps.ts` / `server/services/apps.ts` (`commitPipelineFiles` checks first and records `error: "Branch <name> does not exist"` for that branch without committing)
- Test: `tests/ci-bitbucket.test.ts`, `tests/apps-api.test.ts`

- [ ] **Step 1: Failing tests:** 404 → false; `feature/x` is URL-encoded as `feature%2Fx`; a missing branch is recorded and no `/src` POST happens; other branches still commit.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `fix(apps): do not create branches when committing pipeline files`

### Task 7: Go live (controller, after Romi's go-ahead)

- [ ] **Step 1:** backup, dry-run, apply the additive migration; merge, push; Romi runs Jenkins `DSS/dss-panel`; health 200.
- [ ] **Step 2:** Canary on the `panel-canary` app (plan 2): create a project `Panel Canary` (key `PCAN`, Romi + Indri maintainers) and an environment `Canary` on .113 (deploy dir `/deployments/panel-canary`, service `panel-canary`, manual deploy), add two variables (`GREETING='it''s $HOME #1'` plain, `API_KEY` generated), turn `env_file_managed` on, deploy `origin-main-f11b7f8`; on the server: `.env` mode 600, contents match (compare with `docker compose config --environment` and `printenv` inside the container, resolving `GREETING` to the literal string), `.env.opsdeck-prev` absent on first deploy and present on the second, `.env.opsdeck-unmanaged` holding the hand-written file; a variable named `COMPOSE_PROJECT_NAME` is refused; run output shows no value.
- [ ] **Step 3:** Set `.113` placement `restricted` (default), leave Sucor dev VMs `.129`/`.115` `restricted` until Romi decides which servers are open.
- [ ] **Step 4:** Memory: opsdeck `panel-deploy-feature.md` (variables, managed `.env`, placement, owner is a label), `db-migrations.md`.

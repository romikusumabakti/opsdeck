# Apps model foundation (plan 1 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put apps, app components and CI connections into the Panel's data model, link environments to apps, and let an environment have only the services it really has, with every existing row remapped and every existing feature still working.

**Architecture:** One hand-written migration adds `ci_connections` and `apps`, renames `deploy_apps` to `app_components` (and `app_key` to `component_key` wherever it appears), adds `environments.app_id`, and backfills all of it from today's data. Code follows the rename; the CI build hook keeps its JSON contract (`"app"` is the component key). The fixed db/backend/frontend triple becomes "the services this environment has": the backend stays required, the database and frontend become optional in the form, the API and every screen.

**Tech Stack:** Bun, Hono, React 19 + TanStack Router/Query, Drizzle ORM (hand-written SQL migrations under `drizzle/<timestamp>_<name>/migration.sql`, no drizzle-kit journal), Zod, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-04-app-environment-wizard-design.md`

The spec is split into five plans; this is plan 1 ("Rollout" step 1, data model). Later plans: 2 CI connections (Woodpecker provider, configuration extension, app registration UI), 3 provisioning (variables, `.env` rendering, database hosts, Cloudflare, preflight, placement policy, environment owner rights), 4 wizard UI, 5 adoption (`.env` import confirmation) and lifecycle (delete, stale sandboxes).

## Global Constraints

- An app is one deployable stack (one `compose.yaml`, one deploy dir, one `.env`) built from one or more repos; a component = one repo + its build spec + its tag variable.
- Each app component points to one CI connection; a CI connection is one configured instance of a provider (today exactly one: "Woodpecker – Bitbucket").
- Environments of apps the Panel does not deploy (systemd, Kubernetes, legacy) stay valid with no app ("managed without deploy").
- The build-notify hook contract (`POST /api/deploy-hooks/builds`, body field `app`, HMAC header `X-Opsdeck-Signature`) must not change: pipelines on seven repos send it today.
- Migrations: hand-written SQL in `drizzle/<YYYYMMDDHHMMSS>_<name>/migration.sql` wrapped in `BEGIN; … COMMIT;`, applied to live by hand (backup → dry-run with `ROLLBACK` → apply) **before** the build that needs it is deployed.
- Never print or log secret values (notify secrets stay encrypted via `lib/secrets.ts`).
- English for code, identifiers, comments, commit messages; UI strings go to `messages/en.json` and `messages/id.json`.
- Checks that must pass before each commit: `bun run typecheck`, `bun run lint`, `bun run test`.

## Review Focus

1. An environment whose services span two servers (12 live environments keep the database on another server) must keep working after the migration; nothing may assume one server per environment.
2. The customer portal's two components (`dplk-customer-portal-backend`, `dplk-customer-portal-frontend`) become one app `dplk-customer-portal`; both targets in each portal environment must still deploy with their own tag variable (`BACKEND_IMAGE_TAG`, `FRONTEND_IMAGE_TAG`).
3. A replayed or new build notification with `"app": "<component key>"` must still record the build and trigger auto deploys after the rename.
4. Editing an environment that has no frontend/database must not recreate the missing service or null out another one; unticking "has frontend" deletes exactly that service row.
5. An environment without a database must not crash the Databases, backup/restore and mock-time screens; their nav items are hidden and direct URLs show an empty state.

---

## File structure

| File | Responsibility |
| --- | --- |
| `drizzle/20261105000000_apps_model/migration.sql` | New tables, renames, `environments.app_id`, backfill, removal of the investment duplicate frontend rows |
| `lib/db/schema.ts` | `ciConnections`, `apps`, `appComponents` (renamed from `deployApps`), `componentKey` columns, `environments.appId` |
| `lib/db/relations.ts` | Relations for the new tables |
| `lib/apps.ts` (new) | Read helpers: `getAppByKey`, `listApps`, `getComponent`, `assertTargetMatchesEnvironmentApp` |
| `lib/deploy/*`, `server/services/deploy*.ts`, `server/routes/deploy*.ts`, `lib/jobs/deploy.ts`, `scripts/deploy-app.ts` | Follow the rename; target creation sets/validates `environments.app_id` |
| `lib/services.ts` | `findService`, `hasService`; `getService` keeps throwing for callers that need the role |
| `lib/validation.ts`, `server/services/environments.ts`, `components/environment-form.tsx` | Optional database/frontend in input, storage and form |
| `components/app-sidebar.tsx`, `web/routes/$locale/_app/-components/env/{environment-stack,services-client}.tsx`, database/mock-time routes | Render only the services an environment has |
| `docs/deploy.md` | Apps/components/CI connections vocabulary; hook `app` = component key |

---

### Task 1: Migration and schema

**Files:**
- Create: `drizzle/20261105000000_apps_model/migration.sql`
- Modify: `lib/db/schema.ts` (tables at lines ~344–470: `deployApps`, `deployTargets`, `builds`; `environments` at ~137), `lib/db/relations.ts`
- Test: `tests/apps-migration.test.ts` (new, static checks of the SQL), plus the scratch-database run in Step 4

**Interfaces:**
- Produces (Drizzle, `lib/db/schema.ts`):
  - `ciProviderEnum = pgEnum("ci_provider", ["woodpecker"])`, `forgeKindEnum = pgEnum("forge_kind", ["bitbucket", "github", "gitlab", "gitea", "forgejo"])`
  - `ciConnections`: `id uuid pk default uuidv7()`, `name text not null unique`, `provider ci_provider not null`, `forge forge_kind not null`, `baseUrl text not null`, `createdAt`, `updatedAt`
  - `apps`: `id uuid pk`, `appKey text not null unique`, `name text not null`, `createdAt`, `updatedAt`
  - `appComponents` (table `app_components`, renamed from `deploy_apps`): `componentKey text pk` (was `app_key`), `appId uuid not null → apps.id on delete restrict`, `ciConnectionId uuid not null → ci_connections.id on delete restrict`, `repoFullName text not null`, `ciRepoId text` (nullable), `bundleImage`, `notifySecret`, `createdAt`; index `app_components_app_idx(app_id)`
  - `builds.componentKey`, `deployTargets.componentKey` (columns renamed from `app_key`, FKs unchanged in meaning); index names renamed `builds_component_tag_idx`, `builds_component_branch_received_idx`, `deploy_targets_environment_component_idx`, `deploy_targets_component_idx`
  - `environments.appId uuid null → apps.id on delete restrict`, index `environments_app_idx`
  - Types `CiConnection`, `App`, `AppComponent` (`$inferSelect`)

- [ ] **Step 1: Write the failing static test** `tests/apps-migration.test.ts`:

```ts
const sql = readFileSync("drizzle/20261105000000_apps_model/migration.sql", "utf8");
it("is one transaction", () => {
  expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
  expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
});
it("renames instead of recreating, so FKs and rows survive", () => {
  expect(sql).toMatch(/ALTER TABLE deploy_apps RENAME TO app_components;/);
  expect(sql).toMatch(/ALTER TABLE builds RENAME COLUMN app_key TO component_key;/);
  expect(sql).toMatch(/ALTER TABLE deploy_targets RENAME COLUMN app_key TO component_key;/);
  expect(sql).not.toMatch(/DROP TABLE/i);
});
it("backfills the portal as one app with two components", () => {
  expect(sql).toContain("'dplk-customer-portal'");
  expect(sql).toMatch(/dplk-customer-portal-backend[\s\S]*dss-consulting\/dplk-customer-portal-backend/);
  expect(sql).toMatch(/dplk-customer-portal-frontend[\s\S]*dss-consulting\/customer-portal/);
});
it("fails loudly when a component is left without app or CI connection", () => {
  expect(sql).toMatch(/ALTER COLUMN app_id SET NOT NULL/);
  expect(sql).toMatch(/ALTER COLUMN ci_connection_id SET NOT NULL/);
});
```

- [ ] **Step 2: Run it** — `bun --bun vitest run tests/apps-migration.test.ts` → FAIL (file missing).

- [ ] **Step 3: Write the migration and the schema.** Order inside the transaction: create enums and `ci_connections`, `apps`; rename table/columns/indexes; add nullable `app_id`, `ci_connection_id`, `repo_full_name`, `ci_repo_id` to `app_components`; backfill; `SET NOT NULL` on `app_id`, `ci_connection_id`, `repo_full_name`; add `environments.app_id` + index and backfill it; delete the duplicate investment frontend rows. Backfill values (live data 2026-11-04):

| component_key | app_key (app name) | repo_full_name | ci_repo_id |
| --- | --- | --- | --- |
| dplk-accounting | dplk-accounting (DPLK Accounting) | dss-consulting/dplk-accounting | 1 |
| dplk-cms | dplk-cms (DPLK Customer Portal CMS) | dss-consulting/dplk-customer-portal-cms | 2 |
| dplk-customer-portal-backend | dplk-customer-portal (DPLK Customer Portal) | dss-consulting/dplk-customer-portal-backend | 3 |
| dplk-customer-portal-frontend | dplk-customer-portal | dss-consulting/customer-portal | 4 |
| dplk-membership | dplk-membership (DPLK Membership) | dss-consulting/dplk-membership | 5 |
| hris | hris (HRIS) | dss-consulting/hris | 6 |
| dplk-investment | dplk-investment (DPLK Investment) | dss-consulting/investment | 7 |

  CI connection row: name `Woodpecker – Bitbucket`, provider `woodpecker`, forge `bitbucket`, base_url `https://ci.dssconsulting.id`. Backfill by `component_key` with explicit `UPDATE … WHERE component_key = '…'` lines, so an unknown component left over makes `SET NOT NULL` fail the whole migration. `environments.app_id` = the single app of the environment's targets (`SELECT DISTINCT a.app_id … GROUP BY environment_id HAVING count(DISTINCT app_id) = 1`); end the backfill with a guard `DO $$ … RAISE EXCEPTION … $$` when any environment has targets of two different apps. Duplicate investment frontend rows: `DELETE FROM environment_services f USING environment_services b WHERE f.role = 'frontend' AND b.role = 'backend' AND f.environment_id = b.environment_id AND f.server_id = b.server_id AND f.service_name = b.service_name` (live: exactly the 4 Sucor Investment environments created 2026-11-04). Mirror every change in `lib/db/schema.ts` and add relations (`apps` 1—* `appComponents`, `apps` 1—* `environments`, `ciConnections` 1—* `appComponents`).

- [ ] **Step 4: Prove it on a copy of live.** Dump live (`ssh root@192.168.56.113 'docker exec opsdeck-postgres pg_dump -U postgres -Fc -d dss_panel' > /tmp/dss_panel.dump`, never commit it, delete it at the end), restore into a scratch `postgres:18` container (podman via the `docker` wrapper), run the migration with `psql -v ON_ERROR_STOP=1`, then check:
  - `select count(*) from app_components where app_id is null` → 0; `select count(*) from apps` → 6; `select app_key, count(*) from apps join app_components c on c.app_id = apps.id group by 1` shows `dplk-customer-portal|2`;
  - every environment with deploy targets has `app_id` set; environments without targets keep `app_id` null;
  - `select count(*) from builds`, `deployments`, `deploy_targets` unchanged against the dump;
  - Sucor Investment environments have exactly `db` and `backend` services.
  Remove the container and the dump afterwards.

- [ ] **Step 5:** `bun --bun vitest run tests/apps-migration.test.ts` → PASS; `bun run typecheck` fails only in files Task 2 renames (expected; note them in the report).

- [ ] **Step 6: Commit** — `git add drizzle/20261105000000_apps_model lib/db tests/apps-migration.test.ts && git commit -m "feat(db): apps, app components and CI connections"`

### Task 2: Code follows the rename; targets belong to the environment's app

**Files:**
- Create: `lib/apps.ts`
- Modify: `lib/deploy/repository.ts`, `lib/deploy/validation.ts`, `lib/jobs/deploy.ts`, `server/services/deploy-builds.ts`, `server/services/deployments.ts`, `server/services/deploys.ts`, `server/routes/deploy-hooks.ts`, `server/routes/deploys.ts`, `scripts/deploy-app.ts`, `web/routes/$locale/_app/-components/env/deploys/{deploys-client,target-form-dialog}.tsx`, `docs/deploy.md`
- Test: `tests/deploy-hooks.test.ts`, `tests/deploy-job.test.ts`, `tests/deploys-api.test.ts`, `tests/deploy-repository.test.ts`, new `tests/apps.test.ts`

**Interfaces:**
- Consumes: Task 1 schema (`appComponents`, `apps`, `ciConnections`, `environments.appId`).
- Produces:
  - `lib/apps.ts`: `getComponent(componentKey: string): Promise<(AppComponent & { app: App }) | undefined>`, `listApps(): Promise<(App & { components: AppComponent[] })[]>`, `assertTargetMatchesEnvironmentApp(environmentId: string, componentKey: string): Promise<void>` (throws `HttpError(409, "Component belongs to another app than this environment")` when the environment already has a different `app_id`; sets `environments.app_id` when it is null).
  - Deploy target API/UI field renamed `appKey` → `componentKey` (JSON and types); the build hook keeps reading `app` and maps it to `componentKey`.
  - `scripts/deploy-app.ts` usage: `create <componentKey> <bundleImage> --app <appKey> --repo <owner/name> [--ci <connection name>]` (creates the app with name = appKey when missing; `--ci` may be omitted when exactly one connection exists, otherwise exit 2 listing the names); `rotate <componentKey>` unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `tests/apps.test.ts`: `assertTargetMatchesEnvironmentApp` — (a) environment with `appId` null and component of app A → sets `appId` = A; (b) environment already A, component of A → resolves; (c) environment A, component of B → rejects with status 409 and the message above. Use the existing `vi.mock("@/lib/db", …)` style of `tests/deploy-repository.test.ts`.
  - `tests/deploy-hooks.test.ts`: existing cases keep posting `{ "app": "dplk-accounting", … }`; add `it("maps the hook's app field to the component key")` asserting the build insert receives `componentKey: "dplk-accounting"`.
  - `tests/deploys-api.test.ts`: target creation for a component of another app → 409; payload uses `componentKey`.
- [ ] **Step 2:** `bun run test` → the new cases FAIL, typecheck errors from the rename.
- [ ] **Step 3: Implement.** Mechanical rename `deployApps`→`appComponents`, `appKey`→`componentKey` (DB-facing and API-facing). Call `assertTargetMatchesEnvironmentApp` inside `createDeployTarget` before the insert (same transaction when the repository supports one). `docs/deploy.md`: add an "Apps, components and CI connections" section (vocabulary from the spec; hook field `app` = component key; CLI usage above).
- [ ] **Step 4:** `bun run typecheck && bun run lint && bun run test` → all pass.
- [ ] **Step 5: Commit** — `git commit -m "refactor(deploy): deploy apps become app components of an app"`

### Task 3: Optional database and frontend services

**Files:**
- Modify: `lib/services.ts`, `lib/validation.ts` (`environmentInputSchema` ~line 108, `environmentUpdateSchema` ~159), `server/services/environments.ts` (value builders ~45–90, update ~425–470, create), `components/environment-form.tsx`, `messages/en.json`, `messages/id.json`
- Test: `tests/services.test.ts`, `tests/validation.test.ts`, `tests/environments.test.ts`

**Interfaces:**
- Produces:
  - `lib/services.ts`: `findService<S extends { role: string }>(env: WithServices<S>, role: ServiceRole): S | undefined`; `hasService(env, role): boolean`. `getService`/`dbService`/`backendService`/`frontendService` keep throwing; their comment no longer claims every environment has all three roles.
  - `environmentInputSchema` gains `hasDatabase: z.boolean().default(true)` and `hasFrontend: z.boolean().default(true)`; `db*` and `frontend*` fields become optional and are **required when** the matching flag is true (`superRefine`, issue path on the missing field). Backend fields stay required.
  - Create inserts only the roles present. Update: flag false → delete that role's row; flag true and row missing → insert it from the payload (all its required fields must be present, else 400 "Database fields are required" / "Frontend fields are required"); flag absent → today's partial patch.

- [ ] **Step 1: Write the failing tests.**
  - `tests/services.test.ts`: `findService` returns `undefined` for a missing role; `hasService` true/false; `getService` still throws `environment <id> has no frontend service`.
  - `tests/validation.test.ts`: payload with `hasFrontend: false` and no `frontend*` fields → success; `hasFrontend: true` without `frontendServiceName` → error at path `frontendServiceName`; same pair for `hasDatabase` / `dbServiceName`; payload without the flags behaves as today (all three required).
  - `tests/environments.test.ts`: create with `hasDatabase: false` inserts `backend` + `frontend` rows only; update with `hasFrontend: false` deletes only the frontend row; update with `hasFrontend: true` on an environment without frontend inserts it; update with `hasFrontend: true` but no frontend fields → `{ success: false, message: "Frontend fields are required" }`.
- [ ] **Step 2:** run those three files → FAIL.
- [ ] **Step 3: Implement** schema, service create/update, and the form: two switches "This environment has a separate database" / "… a separate frontend" (default on; edit mode reflects the stored services) that hide their sections when off. Strings in both message files (`environmentForm.hasDatabase`, `environmentForm.hasFrontend`, plus the two hint lines "Off for apps without a database" / "Off when the backend also serves the web UI").
- [ ] **Step 4:** `bun run typecheck && bun run lint && bun run test` → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(environments): database and frontend services are optional"`

### Task 4: Screens show only the services an environment has

**Files:**
- Modify: `components/app-sidebar.tsx` (`projectItems` ~line 71), `web/routes/$locale/_app/-components/env/environment-stack.tsx` (~73–110), `web/routes/$locale/_app/-components/env/services-client.tsx` (~79), `web/routes/$locale/_app/$projectKey.$envSlug.databases.tsx`, `web/routes/$locale/_app/$projectKey.$envSlug.mock-time.tsx`, `web/routes/$locale/_app/$projectKey.$envSlug.services.$role.logs.tsx`, `web/routes/$locale/_app/-components/env/{backup-database,restore-database}.tsx`, `web/routes/$locale/_app/-components/env/databases/databases-tabs.tsx`, `server/services/mock-time.ts`, `lib/jobs/processor.ts`, message files
- Test: `tests/env-sections.test.ts` (new)

**Interfaces:**
- Consumes: `findService`, `hasService` (Task 3).
- Produces: `lib/env-sections.ts` (new) `visibleEnvSections(env: { services: { role: ServiceRole }[] }): Set<"databases" | "mockTime">` — `databases` iff a `db` service exists, `mockTime` iff a `backend` service exists; the sidebar filters `projectItems` with it.

- [ ] **Step 1: Write the failing test** `tests/env-sections.test.ts`: backend-only environment → set without `databases`, with `mockTime`; db+backend+frontend → both.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** Stack and services pages build their role cards from the services present (order db, backend, frontend). Databases, backup/restore and mock-time routes render an empty state ("This environment has no database" / "… no backend") instead of calling the throwing helpers; the logs route returns `notFound()` for a role the environment lacks. Server side (`server/services/mock-time.ts`, `lib/jobs/processor.ts`) keeps `getService` but turns its error into the same HTTP 404/400 message the routes use today for a missing environment.
- [ ] **Step 4:** `bun run typecheck && bun run lint && bun run test` → pass; `bun run dev`, open a backend-only environment (local DB): dashboard renders two cards, Databases/Mock time hidden, `/databases` shows the empty state.
- [ ] **Step 5: Commit** — `git commit -m "feat(environments): screens follow the services an environment has"`

### Task 5: Apply to live (controller, after Romi's go-ahead)

Runs on production data; the controller does it, not a subagent, and only after Romi says go.

- [ ] **Step 1:** Backup per the opsdeck db-migrations procedure (`dss_panel_pre_apps_model_<date>.dump` on .113 and a copy in `~/backups/opsdeck/`, md5 compared).
- [ ] **Step 2:** Dry-run the migration against live with `COMMIT` → `ROLLBACK`; expect no error.
- [ ] **Step 3:** Merge the branch into `main`, push; apply the migration; ask Romi to run Jenkins `DSS/dss-panel`.
- [ ] **Step 4:** Verify on live: `curl -s -H 'Host: panel.dssconsulting.id' http://localhost:80/api/health` → 200; the queries of Task 1 Step 4 on live; Woodpecker re-run of one cheap pipeline (cms) records a build and auto-deploys Dev 1/Dev 2 as before; Romi opens Sucor Investment / Dev 1 dashboard (two service cards) and one portal environment's Deploys page (two targets).
- [ ] **Step 5:** Record the migration in opsdeck memory `db-migrations.md`.

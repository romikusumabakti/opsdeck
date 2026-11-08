# Panel Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users see only Project → Environment. An engineer creates an environment from a repo with four visible fields. Settings are split into tabs, with everything advanced kept behind "Advanced options".

**Architecture:**
- The existing setup service (`server/services/environment-setup.ts`) stays the engine. A new thin layer turns the short "new environment" input into a full `EnvironmentSetupInput`, registering repos on the way. This layer is a pure resolver in `lib/setup/new-environment.ts` plus a service in `server/services/new-environment.ts`.
- The UI gets one new page.
- Settings becomes tabs.
- The Apps, Tunnels and CI admin surfaces fold into fewer pages.
- Roles are renamed in the database enum.

**Tech Stack:** Bun, Hono, React 19 + TanStack Router/Query, shadcn/ui on Base UI (`components/ui/collapsible.tsx`), Drizzle with hand-written SQL migrations, zod, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-08-panel-simplification-design.md`

## Global Constraints

- **User-facing copy:**
  - Every new or changed user-facing string goes in all 5 `messages/{ar,en,es,id,zh}.json`.
  - `en` and `id` are real translations.
  - `ar`, `es` and `zh` may copy `en` where the repo already does so.
- **Migrations:**
  - Hand-written under `drizzle/<timestamp>_<name>/migration.sql`.
  - `SET lock_timeout = '5s';` is the first statement; `BEGIN;` … `COMMIT;` follow.
  - `ALTER TYPE … ADD VALUE` would go before `BEGIN`; none is planned. `RENAME VALUE` is transactional.
  - Each migration gets a static test like `tests/setup-wizard-migration.test.ts`.
- **API errors** keep a stable `code` in the body. New setup issue codes are added to `lib/setup/issues.ts` and get messages in all locales.
- **Security rules that must still hold:**
  - secrets are readable only with `variable:read`;
  - `prod` kind, and public/bypass/everyone access policies, need org `server:manage`;
  - foreign Cloudflare objects are never taken over;
  - non-`server:manage` users are limited to entry ports 8100–8999.
- **Simple by default.** Advanced fields live inside a `Collapsible` labelled "Advanced options" (`setup.advancedOptions`). No advanced capability that exists today is removed.
- **Do not rework the QA pages** (databases, mock time, mail, issues, history) beyond what a task says.
- **Commits:** English, conventional (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`).
- **Before each commit:**
  - Run `bun run check`, `bun run typecheck` and `bun run test`.
  - `bun run test` must run without a `SECRETS_KEY` in the shell environment (`env -u SECRETS_KEY bun run test`).

## Review Focus

1. **A new branch created from `main` inherits the Panel's generated `.woodpecker.yaml`, whose branch filter lacks the new branch.** The Panel must regenerate and commit it there, or the first build never runs. Task 4 test `adds a branch and recommits a Panel-generated file`.
2. **A repo that already belongs to a different app is picked for a new environment.** It must be refused with issue `repoOtherApp` naming the owning app, never registered twice. Task 5 test `refuses a repo of another app`.
3. **No project default server and no `open` server.** Create is refused with `noServerAvailable`, and the page shows the "ask an admin" message, not a 500 or an empty select. Task 5 test `no server available` and Task 7 test `shows ask-an-admin when no server`.
4. **Two creates race for the same name or subdomain.** The loser gets an issue code (`nameTaken` / `domainTaken`), not a 500. Task 6 test `unique violation maps to an issue`.
5. **A QA user opens `/KEY/environments/new` or Settings by URL.** They get the forbidden page, and the API returns 403. Task 2 tests `qa cannot create environments`, and Task 7 test `qa sees forbidden`.

---

## File Structure

- `drizzle/20261108000000_panel_simplification/migration.sql`: the one migration for this plan.
  - role rename;
  - `projects.default_server_id`;
  - host → url copy;
  - drop `environments.host` and `environments.owner`;
  - `cloudflare_zones.api_token` made nullable.
- `lib/permissions.ts`: roles `viewer | qa | engineer`, QA restart, `canCreateProject`, `canPlaceEnvironment` with the project default.
- `lib/setup/detect.ts` and `server/services/setup-detect.ts`: compose `name:` / `container_name`, pipeline-file check, generated build spec.
- `server/services/apps.ts`: engineers may register generated pipelines; `ensureComponentBranch`.
- `lib/setup/new-environment.ts` (new, pure): `NewEnvironmentInput` schema and `resolveNewEnvironment`.
- `server/services/new-environment.ts` (new) and `server/routes/setup.ts`: preview and create endpoints.
- `web/routes/$locale/_app/$projectKey.environments.new.tsx` and `-components/setup/new-environment-form.tsx` (new): the page.
- `web/routes/$locale/_app/$projectKey.$envSlug.settings.tsx` and `-components/env/settings/*` (new): the tabs.
- `components/app-sidebar.tsx`, `components/command-palette.tsx`, and the `admin.repositories.*` routes (moved from `apps.*`), `admin.ci.index.tsx`, `admin.cloudflare.tsx`: the navigation.

---

### Task 1: Migration and schema

**Files:**
- Create: `drizzle/20261108000000_panel_simplification/migration.sql`, `tests/panel-simplification-migration.test.ts`
- Modify:
  - `lib/db/schema.ts`: `projectRoleEnum` lines 815-819, `projects` 201-214, `environments` around 237 (`legacyOwner`) and the `host` column, `cloudflareZones.apiToken` line 1413.

**Interfaces:**
- Produces:
  - `projects.defaultServerId: uuid | null`;
  - `projectRoleEnum` values `viewer`, `qa`, `engineer`;
  - `environments` without `host` / `legacyOwner`;
  - `cloudflareZones.apiToken: text | null`.

- [ ] **Step 1: Write the failing migration test.** It asserts that the SQL:
  - starts with `SET lock_timeout = '5s';` before `BEGIN;` and ends with `COMMIT;`;
  - contains `ALTER TYPE project_role RENAME VALUE 'contributor' TO 'qa';` and `ALTER TYPE project_role RENAME VALUE 'maintainer' TO 'engineer';`;
  - contains `ADD COLUMN default_server_id uuid REFERENCES servers(id) ON DELETE SET NULL`;
  - contains `UPDATE environments SET url = 'http://' || host WHERE url IS NULL AND host IS NOT NULL;`, and that this UPDATE appears before `DROP COLUMN host`;
  - contains `DROP COLUMN owner`;
  - contains `ALTER TABLE cloudflare_zones ALTER COLUMN api_token DROP NOT NULL`.
- [ ] **Step 2: Run the test** with `bun --bun vitest run tests/panel-simplification-migration.test.ts`. Expected: FAIL (file missing).
- [ ] **Step 3: Write `migration.sql` and update `lib/db/schema.ts` to match.**
  - Every consumer of `environments.host` loses it. Grep `\.host` on environment rows:
    - `server/services/environments.ts` lines 898 and 1054;
    - `lib/variables/repository.ts:42`;
    - `server/services/variables.ts:412`;
    - `components/environment-form.tsx` (host field);
    - `components/command-palette.tsx` lines 281 and 290;
    - `components/projects-overview.tsx:337`;
    - `components/nav/environment-switcher.tsx` lines 104 and 111;
    - `web/routes/$locale/_app/$projectKey.index.tsx:213`.
  - `EnvironmentHost` call sites show the URL's host instead: `new URL(env.url).host` when `env.url` parses, else nothing.
  - Remove `host` from `environmentFields` in `lib/validation.ts`.
  - Remove `{host}` from `PlaceholderContext` / `resolvePlaceholders`, and make template validation reject a `{host}` placeholder with the existing unknown-placeholder error.
- [ ] **Step 4: Run** `bun run typecheck && bun run test`. Expected: PASS. Update existing tests that referenced `host` or the old role names only where the rename forces it.
- [ ] **Step 5: Commit:** `feat(db): rename project roles, add project default server, drop environment host`.

### Task 2: Roles and permissions

**Files:**
- Modify:
  - `lib/permissions.ts`;
  - `lib/deploy/lock.ts`;
  - `web/routes/$locale/_app/-components/project/project-members-client.tsx`;
  - `server/services/project-catalog.ts` (`addProject`);
  - `server/services/environments.ts` (`updateEnvironment` rebinding gate, around line 972);
  - all 5 `messages/*.json` (role labels).
- Test: `tests/permissions.test.ts`, `tests/project-catalog.test.ts` (create if absent).

**Interfaces:**
- Consumes: the Task 1 enum.
- Produces:
  - `PROJECT_ROLES = ["viewer", "qa", "engineer"] as const`;
  - `canCreateProject(orgRole: string | null | undefined, projectRoles: readonly ProjectRole[]): boolean`;
  - `canPlaceEnvironment(orgRole, projectRole, placement: "restricted" | "open", isProjectDefault: boolean): boolean`. A restricted server is allowed when `isProjectDefault && canProject(projectRole, { environment: ["create"] })`.

- [ ] **Step 1: Write failing tests.**
  - `qa can restart services`: `canProject("qa", { service: ["control"] })` is true.
  - `qa cannot create environments`: `canProject("qa", { environment: ["create"] })` is false.
  - `engineer can create a project`: `canCreateProject("member", ["engineer"])` is true, `canCreateProject("member", ["qa"])` is false, and `canCreateProject("admin", [])` is true.
  - `project default server admits engineers`: `canPlaceEnvironment("member", "engineer", "restricted", true)` is true, and with `false` it is false.
  - `addProject makes the creator engineer`: after `addProject` by a member who is engineer elsewhere, `project_members` holds `(newProjectId, userId, 'engineer')`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Rename `contributor` → `qa` and `maintainer` → `engineer` everywhere, including `PROJECT_RANK`, `implicitProjectRole` and `canRegisterApp`.
  - QA keeps today's contributor statements and adds `service: ["logs", "control"]`.
  - `addProject` checks `canCreateProject` instead of `requireOrgPermission({ project: ["create"] })`, and inserts the creator's engineer membership in the same transaction when the creator is not an admin.
  - `updateEnvironment`: rebinding servers (`changedInfraFields` that are server ids) is allowed without `server:manage` when every new server passes `canPlaceEnvironment` and no deploy of the environment exists (`deployments` row count 0). Other infra fields keep needing `server:manage`.
  - The labels are "Viewer" / "QA" / "Engineer" (id: "Viewer" / "QA" / "Engineer").
- [ ] **Step 4: Run** `bun run test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(permissions): Viewer/QA/Engineer roles, QA restart, engineers create projects`.

### Task 3: Repo detection extensions

**Files:**
- Modify: `lib/setup/detect.ts`, `server/services/setup-detect.ts`
- Test: `tests/setup-detect.test.ts`

**Interfaces:**
- Produces, added to `RepoDetection`:
  - `projectName: string | null`, the compose top-level `name:`;
  - `DetectedService.containerName: string | null`, the compose `container_name`;
  - `pipeline: { kind: "none" } | { kind: "panel"; componentKey: string } | { kind: "custom"; notifiesPanel: boolean }`;
  - `suggestedBuildSpec(detection: RepoDetection, componentKey: string, branch: string): BuildSpec | null`, exported from `lib/setup/detect.ts`.

- [ ] **Step 1: Write failing tests.**
  - `reads compose name and container_name`: compose with `name: hris` and a service with `container_name: hris-web` gives `projectName === "hris"` and `containerName === "hris-web"`.
  - `recognises a Panel-generated pipeline`: a file containing `# Generated by DSS Panel for panel-canary-2` gives `{ kind: "panel", componentKey: "panel-canary-2" }`.
  - `custom pipeline that notifies`: a file containing `opsdeck_notify` gives `{ kind: "custom", notifiesPanel: true }`; without it, `notifiesPanel: false`.
  - `suggests a build spec`: root `Dockerfile` plus `compose.yaml` plus `compose.override.yaml` gives:
    - `images: [{ name: "<key>", dockerfile: "Dockerfile", context: "." }]`;
    - `bundleFiles: [{from:"compose.yaml",to:"compose.yaml"},{from:"compose.override.yaml",to:"compose.override.yaml"}]`;
    - `branches: [branch]`, `checks: []`, `timeoutMinutes: 60`.
  - A sub-directory `api/Dockerfile` adds image `<key>-api` with context `api`.
  - No Dockerfile or no compose gives `null`.
- [ ] **Step 2: Run** `bun --bun vitest run tests/setup-detect.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The service reads `.woodpecker.yaml` (or the first file in `.woodpecker/`) only when present, as it does for compose.
  - The pipeline marker is the comment written at `lib/ci/pipeline.ts:249`; parse the key from it with one regex exported next to it (`PANEL_PIPELINE_MARKER`).
  - `container_name`, when present, wins over the `<basename(dir)>-<svc>-1` rule in `composeContainerName` callers. `projectName` replaces `basename(dir)` in that rule.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(setup): detect compose names, pipeline files and a build spec`.

### Task 4: Registration for engineers and additive branches

**Files:**
- Modify: `server/services/apps.ts` (lines 228-372 `registerApp`, 147 `builtBranches`, 413 `retryPipelineFileCommit`), `lib/permissions.ts` (`canRegisterApp` doc)
- Test: `tests/apps.test.ts`

**Interfaces:**
- Consumes: `RepoDetection.pipeline` (Task 3).
- Produces: `ensureComponentBranch(componentKey: string, branch: string): Promise<{ added: boolean }>`.
  - For a generated component whose `build_spec.branches` lacks `branch`, it appends the branch, saves the build spec, and commits the regenerated file to **every** built branch via `commitPipelineFiles`.
  - A no-op for custom components and for branches already listed.

- [ ] **Step 1: Write failing tests** (provider and forge mocked as in the existing `apps.test.ts`).
  - `engineer may register a generated pipeline`: no 403.
  - `refuses to overwrite a non-Panel pipeline file`: registering generated on a repo whose detection says `{kind:"custom"}` fails with code `pipelineFileExists`.
  - `adds a branch and recommits a Panel-generated file`: component with `branches:["main"]`; `ensureComponentBranch(key, "feature-x")` stores `["main","feature-x"]` and commits to both branches.
  - `idempotent for a listed branch`: it returns `{added:false}` and makes no commit.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Drop the `canManagePipelines` check for `pipelineMode === "generated"` at registration.
  - `retryPipelineFileCommit` and rotation stay `integration:manage`.
  - Before committing, read the branch's current file. Skip and record `error: "pipelineFileExists"` if it exists and has no `PANEL_PIPELINE_MARKER`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(apps): engineers register generated pipelines; add environment branches`.

### Task 5: The new-environment resolver (pure)

**Files:**
- Create: `lib/setup/new-environment.ts`
- Modify: `lib/setup/issues.ts` (new codes)
- Test: `tests/new-environment-resolve.test.ts`

**Interfaces:**
- Consumes:
  - `EnvironmentSetupInput` (`lib/setup/schema.ts`);
  - `RepoDetection` and `suggestedBuildSpec` (Task 3);
  - `defaultDeployDir`, `defaultDatabaseName`, `defaultDbContainer` (`lib/setup/draft.ts`).
- Produces:

```ts
export const newEnvironmentInputSchema: z.ZodType<NewEnvironmentInput>;
export type NewEnvironmentInput = {
  projectId: string;
  name: string;
  copyFromEnvironmentId?: string | null;
  repos: { ciConnectionId: string; repoFullName: string; branch: string }[]; // 1..20
  needsDatabase: boolean;
  address: { label: string } | null;          // null = no address
  serverId?: string | null;                   // only when the project has no default, or Advanced
  advanced?: Partial<Pick<EnvironmentSetupInput,
    "kind" | "ownerId" | "services" | "database" | "variables" | "domain" | "targets">>;
};
export type NewEnvironmentContext = {
  project: { id: string; key: string; defaultServerId: string | null };
  servers: { id: string; name: string; placement: "restricted" | "open"; databaseHostId: string | null }[]; // already filtered to placeable
  repos: { repoFullName: string; ciConnectionId: string; detection: RepoDetection;
           component: { componentKey: string; appId: string; appKey: string } | null }[];
  appId: string | null;                 // app of the copy source or of the first known repo
  copySource: CopySourceView | null;
  suggestedPort: number | null;         // from preflight
  defaultZoneId: string | null; defaultAccessPolicyId: string | null;
  existingDbNames: string[];            // on the chosen database host
};
export type NewEnvironmentPlan = {
  registrations: { repoFullName: string; ciConnectionId: string; componentKey: string;
                   pipelineMode: "custom" | "generated"; buildSpec: BuildSpec | null }[];
  appKey: string;                       // existing, or new from the first repo's slug
  setup: Omit<EnvironmentSetupInput, "appId">;
  summary: { serverName: string; port: number | null; databaseName: string | null; url: string | null };
  issues: SetupIssue[];
  warnings: { field: string; code: "pipelineNotNotifying" }[];
};
export function resolveNewEnvironment(input: NewEnvironmentInput, ctx: NewEnvironmentContext): NewEnvironmentPlan;
```

- [ ] **Step 1: Write failing tests**, one per rule.
  - `uses the project default server`: `setup.server.serverId === ctx.project.defaultServerId` when `input.serverId` is absent.
  - `no server available`: no default, no `input.serverId` and empty `ctx.servers` gives issue `{field:"serverId", code:"noServerAvailable"}`.
  - `refuses a repo of another app`: a second repo whose `component.appId !== ctx.appId` gives `{field:"repos.1", code:"repoOtherApp"}`.
  - `registers an unknown repo`:
    - detection `pipeline.kind === "none"` gives a registration with `pipelineMode:"generated"` and `buildSpec` from `suggestedBuildSpec`;
    - `kind:"custom"` gives `"custom"` with `buildSpec:null`, and a `pipelineNotNotifying` warning when `notifiesPanel` is false;
    - `suggestedBuildSpec` returning `null` for a generated repo gives issue `repoNotBuildable`.
  - `component key from slug`: `dss-consulting/panel-canary-2` gives `componentKey: "panel-canary-2"`; when the key is taken, `panel-canary-2-2`.
  - `database default`:
    - `needsDatabase` true with a database host on the server gives `{kind:"shared", dbName:"<key>_<slug>", dbRole: same, passwordVariable:"DB_PASSWORD"}`;
    - without a host it gives `{kind:"container", serviceName: defaultDbContainer(...)}`;
    - `needsDatabase` false gives `{kind:"none"}`.
  - `db name never collides with the copy source`: copy source `pcan_canary`, new slug `canary-2`. The suggestion is not one that the X/X_ overlap rule in `existingDbNames` refuses. Assert `pcan_canary_2` is skipped and `pcan_canary2` (or a non-overlapping name) is chosen.
  - `role follows the database name` when `advanced.database.dbRole` is absent.
  - `address default`:
    - `{label}` gives a tunnel domain on `ctx.defaultZoneId` with `ctx.defaultAccessPolicyId`, `entryPort: ctx.suggestedPort`;
    - `null` gives `{kind:"none"}`;
    - the default label is `<projectkey>-<slug>` lowercase.
  - `ENTRY_PORT variable`: with a tunnel domain, `setup.variables` contains plain `ENTRY_PORT` equal to the entry port, unless the input already sets it.
  - `auto-deploy on for non-prod`: every target has `autoDeploy: true` unless `advanced.kind === "prod"`.
  - `copy pre-fills repos and branch`: with `copySource`, empty `repos` take the source's components and branches.
  - `advanced overrides win`: every `advanced` key replaces the resolved value.
- [ ] **Step 2: Run** `bun --bun vitest run tests/new-environment-resolve.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `resolveNewEnvironment` as a pure function (no I/O). Add issue codes `noServerAvailable`, `repoOtherApp`, `repoNotBuildable`, `nameTaken`, `domainTaken` to `lib/setup/issues.ts`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(setup): resolve a short new-environment input into a setup`.

### Task 6: New-environment service and API

**Files:**
- Create: `server/services/new-environment.ts`
- Modify: `server/routes/setup.ts`
- Test: `tests/new-environment-api.test.ts` (pattern: `tests/environment-setup-api.test.ts`)

**Interfaces:**
- Consumes:
  - Task 5;
  - `previewEnvironmentSetup` / `createEnvironmentSetup` (`server/services/environment-setup.ts:835,942`);
  - `registerApp`, `ensureComponentBranch` (Task 4);
  - `detectComponentRepo`;
  - `canPlaceEnvironment` (Task 2).
- Produces:
  - `previewNewEnvironment(input: unknown): Promise<{ plan: NewEnvironmentPlan; preview: SetupPreview | null }>`;
  - `createNewEnvironment(input: unknown): Promise<SetupCreated>`;
  - routes `POST /api/setup/new-environment/preview` and `POST /api/setup/new-environment`;
  - `GET /api/setup/repos?q=` (search the CI connection's repos; each row carries `appKey | null`, so the picker can disable foreign ones).

- [ ] **Step 1: Write failing tests.**
  - `creates from a fresh repo`:
    - registers the app (one component, generated);
    - calls `createEnvironmentSetup` with the resolved setup;
    - sets `deploy_next_build`;
    - triggers the first build;
    - returns the environment.
  - `first server choice becomes the project default`: a project with null `default_server_id` and `serverId` in the input has it saved after create.
  - `adds the environment branch`: an existing generated component plus a new branch calls `ensureComponentBranch`.
  - `unique violation maps to an issue`: a concurrent insert of the same env name gives a 409 with `code: "nameTaken"`; the same subdomain gives `domainTaken`.
  - `qa cannot create environments`: a QA member gets 403.
  - Preview does not register anything and does not write the DB (assert no `apps` row).
  - `port suggestion survives other issues`: a preview whose plan has only a database issue still returns `plan.summary.port` from preflight, and never the "no preflight" message (canary bug 3).
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Build `NewEnvironmentContext` from the DB plus detection, call the resolver, then:
    - preview: return the plan, plus `previewEnvironmentSetup` when the plan has no issues;
    - create: in this order, register missing components (one `registerApp` for a new app; for an existing app, add components to it), `ensureComponentBranch`, `createEnvironmentSetup`, save the project default server, trigger the first build as the New app stepper does today.
  - Registration failure aborts before any environment row exists.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(setup): new-environment preview and create API`.

### Task 7: New environment page

**Files:**
- Create: `web/routes/$locale/_app/-components/setup/new-environment-form.tsx`
- Modify:
  - `web/routes/$locale/_app/$projectKey.environments.new.tsx` (replace the legacy form);
  - `apps.new.tsx` and `apps.$appKey.environments.new.tsx` (redirect: `apps.new` → `/projects` with the palette hint; `apps.$appKey.environments.new` → `/<projectKey>/environments/new?repo=<repo>` when the app has one project, else `/projects`);
  - `web/routes/$locale/_app/$projectKey.index.tsx` ("New environment" button);
  - `components/environment-form.tsx` (delete create mode and the `?from=` duplicate path; keep edit until Task 8 replaces it);
  - messages.
- Test: `tests/new-environment-page.test.tsx` (pattern: `tests/add-environment-page.test.tsx`)

**Interfaces:**
- Consumes: the Task 6 endpoints. Reuse `-components/setup/review.tsx` for the issue and summary list, and `environment-sections.tsx` pieces for the Advanced fields.

- [ ] **Step 1: Write failing component tests.**
  - `shows four fields`: Start from, Name, Repository, "Needs a database" and Address are visible; "Advanced options" is collapsed.
  - `no errors before interaction`: rendering with an empty form shows no `role="alert"`.
  - `errors after Create`: pressing Create with an empty name shows the required error.
  - `no red flash after success`: after a successful create, the preview is not requested again (mocked fetch called once for create, none after) and the app navigates to `/<KEY>/<slug>/deploys`.
  - `shows ask-an-admin when no server`: a preview with issue `noServerAvailable` renders `setup.noServerAvailable` and disables Create.
  - `qa sees forbidden`: the route guard for a QA role renders the forbidden page.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement the page.**
  - **Preview trigger:** preview runs only on Create, when Advanced options opens, or when a repo is picked (to show detection). It does not run on keystrokes.
  - **Summary line** above Create: `setup.summary` = "Server {server} · port {port} · database {db} · {url}".
  - **Server picker:** shown visibly only when the project has no default.
  - **Repo picker:** shows other-app repos disabled, with the owner's app name.
  - **Copy source:** "Start from" defaults to the newest environment when one exists.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(web): one-page New environment with advanced options`.

### Task 8: Environment Settings tabs

**Files:**
- Modify: `web/routes/$locale/_app/$projectKey.$envSlug.settings.tsx`
- Create, under `web/routes/$locale/_app/-components/env/settings/`:
  - `general-tab.tsx`;
  - `source-deploy-tab.tsx`, which moves the deploy-target editor from `env/deploys/target-form-dialog.tsx` in inline; the Deploys page keeps history, deploy and rollback and links "Settings → Source & Deploy";
  - `database-tab.tsx`;
  - `domain-tab.tsx`, which wraps `components/environment-domain-form.tsx`;
  - `mail-mock-time-tab.tsx`, which wraps `mailpit-settings-form.tsx` and the mock-time fields.
- Delete what remains of `components/environment-form.tsx` once its sections live in the tabs.
- Test: `tests/environment-settings-tabs.test.tsx`

**Interfaces:**
- Consumes:
  - `updateEnvironment` with `environmentUpdateSchema` (full payload, built from one shared form state per page);
  - the deploy-target update API (`server/services/deploys.ts:274`).

- [ ] **Step 1: Write failing tests.**
  - `renders six tabs`: General, Source & Deploy, Database, Domain, Mail & Mock time, Danger.
  - `URL is read-only with a domain`: an env with a tunnel domain shows URL disabled; an env without a domain shows URL under Advanced options, editable.
  - `one server picker`: Source & Deploy shows one server select; per-service selects appear only inside Advanced options.
  - `server locked after first deploy`: an env with a deployment renders the server select disabled, with the hint `settings.serverLocked`.
  - `saving one tab keeps others`: changing the name on General and saving sends the stored database fields unchanged.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** Field placement follows the spec section "Environment Settings (tabs)" exactly. `envFileManaged` moves to Source & Deploy → Advanced, and the Variables page toggle is removed.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(web): environment settings in tabs with advanced options`.

### Task 9: Issues default to open

**Files:**
- Modify:
  - `web/routes/$locale/_app/$projectKey.$envSlug.issues.tsx`;
  - `web/routes/$locale/_app/-components/issues-client.tsx` (around line 108);
  - `server/services/issues.ts:648` (`listIssues(projectId, statuses?)`).
- Test: `tests/issues.test.ts`

**Interfaces:**
- Consumes: `resolveStatusFilter`, `OPEN_STATUSES` (`lib/issue-query.ts:35`).

- [ ] **Step 1: Write failing tests.**
  - `env issues default to open`: `listIssues(projectId, OPEN_STATUSES)` excludes `done`/`closed` rows.
  - The client renders a status filter whose default is open + in progress, and choosing "All" shows closed ones.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** The status lives in the search param `status`, as on `/issues`. The project overview Issues tab uses the same default.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(issues): open issues by default on project and environment pages`.

### Task 10: Navigation, Repositories, CI card and command palette

**Files:**
- Modify: `components/app-sidebar.tsx` (lines 112-149 admin group, 297 Apps), `components/command-palette.tsx` (165-240)
- Move, keeping the old paths as redirects:
  - `apps.index.tsx` → `admin.repositories.index.tsx`;
  - `apps.$appKey.index.tsx` → `admin.repositories.$appKey.index.tsx`;
  - `apps.$appKey.variables.tsx` → `admin.repositories.$appKey.variables.tsx`.
- Modify: `admin.ci.index.tsx` (single card), and the project settings page `$projectKey.settings.tsx` (Details tab gets "Default server", editable with `server:manage`, a select of all servers).
- Test: `tests/app-sidebar.test.tsx`, `tests/command-palette.test.tsx`

- [ ] **Step 1: Write failing tests.**
  - `no Apps entry`: the sidebar has no `/apps` link for any role.
  - `admin group`: Activity, Users, Repositories, Jira, CI, Cloudflare; no Tunnels.
  - `palette lists gated pages`: an admin sees Storage, Repositories, CI, Cloudflare and New environment; a QA member sees none of Repositories, CI or Cloudflare.
  - `CI single card`: with one connection, `/admin/ci` renders the edit form directly, with no table; with more than one, the table.
  - `default server editable by server:manage only`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** Repositories is gated by `integration:manage`, the same as variable templates today. The project default-server update goes through `editProject` with a `defaultServerId` field guarded by `server:manage`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(web): simpler navigation, repositories under admin, CI as one card`.

### Task 11: One Cloudflare page

**Files:**
- Modify: `web/routes/$locale/_app/admin.cloudflare.tsx`
- Move:
  - the zone list and forms from `admin.tunnels.zones.*`;
  - the local-tunnel list and editors from `admin.tunnels.*`, into an "Advanced options → Local tunnels" section.
- Old `/admin/tunnels/*` routes redirect to `/admin/cloudflare` (the tunnel detail and edit routes keep working under `/admin/cloudflare/local-tunnels/$id`).
- Modify: `server/services/tunnels.ts` and the zone DNS client, so a zone with null `api_token` uses the Cloudflare account token.
- Test: `tests/cloudflare-zones.test.ts`, `tests/admin-cloudflare-page.test.tsx`

- [ ] **Step 1: Write failing tests.**
  - `zone without token uses the account token`: a DNS write for a zone with `apiToken: null` calls the request helper with the account token.
  - `zone form token optional when an account exists`.
  - The page renders the sections Account, Zones and Tunnels, with Local tunnels collapsed under Advanced options.
  - `/admin/tunnels` redirects.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** A zone with neither its own token nor an account gives the existing "Set up the Cloudflare account first" error code.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(web): one Cloudflare page; zones use the account token`.

---

## Rollout (controller, with Romi's go-ahead)

1. Full suite green on the branch, then the final whole-branch review.
2. **Backup:** `docker exec opsdeck-postgres pg_dump -U postgres -Fc -d dss_panel > /root/backups/dss_panel_pre_panel_simplification_20261108.dump`, copied to `~/backups/opsdeck/` with an md5 check.
3. **Dry-run** the migration with `COMMIT` → `ROLLBACK`, then apply it. There is a window of a few minutes until the new build runs, during which the old code reads `qa`/`engineer` as unknown roles: members without an org role see no projects. Apply and run Jenkins `DSS/dss-panel` back-to-back.
4. Merge fast-forward and push. Romi runs Jenkins. Then run the health check.
5. Romi sets project default servers and marks dev/sandbox servers `open`.
6. **Canary:**
   - an engineer-role test account creates an environment from `dss-consulting/panel-canary-2` with four fields;
   - a QA-role account checks the QA pages and restart.

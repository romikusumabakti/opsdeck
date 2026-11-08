# Panel simplification: Project → Environment, simple by default — design

Status: draft for Romi's review (2026-11-08). This is project 1 of 4. Later projects get their own specs: (2) opsdeck self-install, self-update, test instance and S3 backup; (3) SSH keys for servers; (4) migrating every Jenkins project to the Panel and Woodpecker.

## Why

After plans 3b-1 to 4, a canary run showed the setup is technically complete but hard to use.

- **Too many concepts.** A user meets four: projects, apps, servers and environments. Creating an environment means choosing in two hierarchies.
  - A Project is client × product, e.g. SCMB Sucor Membership. It owns the issue key and the members.
  - An App is a codebase, e.g. `dplk-membership`, shared by many projects.
- **Too many fields**, and two flows that create environments: the legacy `EnvironmentForm`, and New app / Add environment.
- **Overlapping fields:**
  - Host, URL and Domain;
  - one server picker per service;
  - the entry port asked twice.
- **Two Cloudflare pages:**
  - `/admin/tunnels` is the legacy local-`config.yml` model with per-zone DNS tokens;
  - `/admin/cloudflare` is the account token with remotely managed tunnels.
- **The CI page is a table** although there is one Woodpecker.
- **Issues include closed ones.** The environment Issues page lists every issue of the project in every status, while the sidebar badge counts open ones only.
- **QA cannot restart a service,** which they sometimes need.

Romi's goal: "AKU INGIN SEMUANYA MUDAH, SEDERHANA, DAN JELAS". Every engineer should be able to create an environment and deploy it themselves, including from a repo they just created.

## Decisions made with Romi (2026-11-08)

1. **Users see only Project → Environment.** The Apps menu goes away. An environment picks its repo(s) directly, and a repo unknown to the Panel is registered automatically on first use. Servers are managed by admin/infra.
2. **Creating an environment asks for:** repo + branch, environment name, "needs a database", and a subdomain. Everything else is automatic.
3. **Simple by default, advanced kept.** Rarely needed settings stay available behind an **"Advanced options"** Collapsible. Only unused or duplicated things are removed.
4. **Deploy settings live in environment Settings**, which is split into tabs:
   - General;
   - Source & Deploy;
   - Database;
   - Domain;
   - Mail & Mock time;
   - Danger.
5. **Project roles become Viewer / QA / Engineer.**
   - QA is today's contributor plus service restart (`service:control`).
   - Engineer is today's maintainer.
   - The QA pages must not be reworked beyond that: databases, mock time, mail, issues and history.
6. **Every engineer can create environments and deploy.** Engineers may also create a new project.
7. **The server comes from a per-project default server** set by an admin. Engineers may pick another allowed server under Advanced options.
8. **Navigation changes:**
   - remove the Apps menu;
   - merge `/admin/tunnels` into `/admin/cloudflare`;
   - CI becomes one settings card, not a table;
   - complete the command palette;
   - Servers and Storage stay where they are; they are already gated by `server:read` / `storage:read`.
9. **Legacy cleanup:**
   - delete the legacy `EnvironmentForm` create/duplicate flow;
   - drop `environments.host` and `environments.legacy_owner`.
10. **Issues on the environment page** default to open + in progress, with a status filter to show closed. The list stays project-wide.

## Model

The schema keeps its tables. The simplification is mostly about what the UI shows.

### Project
- New `default_server_id` (nullable FK `servers`, `on delete set null`). It is set in project Settings by `server:manage` users.
- The project's environment-create flow uses it as the server.
- Engineers may only pick servers whose `placement = 'open'` (existing enum), plus the project default even if restricted. *(Claude's call: the admin choosing a default is the authorisation; without this rule, an admin would have to open every client server.)*

### App and components (hidden, not removed)
- `apps` / `app_components` stay as the internal registry of repos (build-notify keys, bundle images, pipelines).
- When an environment picks a repo with no component, the Panel registers it:
  - `app_key` and `component_key` come from the repo slug, uniqued;
  - `bundle_image` is `<component_key>-deploy`;
  - the CI connection is the only one.
- One app per product. *(Claude's call.)* The first repo picked for an environment creates the app. Any further repo added to that environment ("Add another repo") is registered as another component of the **same** app. This matches `environments.app_id` (single FK), `componentOtherApp`, `copySourceOtherApp` and the app-keyed variable templates; none of these change. Existing multi-component apps (`dplk-customer-portal` = backend + frontend) keep working.
- A repo that already belongs to another app cannot be added to an environment of a different app. The picker shows such repos disabled, with the owning app's name.
- Admins still see the registry under **Admin → Repositories**: today's apps list and detail, moved there, plus the variable templates.

### Pipeline mode for engineers
- A repo that has a `.woodpecker.yaml` / `.woodpecker/` uses **custom**.
- A repo that has none uses **generated**.
- Engineers may use generated, but the Panel only creates the file when it is absent; it never overwrites one. Editing an existing generated build spec (images, bundle files, checks, timeout) stays admin-only.
- **Branches are additive for engineers.** When an environment uses a branch that a generated component's `build_spec.branches` does not list, create adds the branch and commits the generated file to it (only if absent there). Removing branches stays admin-only. *(Claude's call; without it `deploy_next_build` would wait forever.)*
- **Generated build spec from detection.**
  - Image: the root `Dockerfile` with context `.`; detected sub-directory Dockerfiles become extra images.
  - Bundle files: `compose.yaml` (or `docker-compose.yml`/`compose.yml`) plus `compose.override.yaml` when present.
  - Checks: none.
  - Timeout: 60.
  - No Dockerfile or no compose file is a **blocking issue** with a clear message ("Add a Dockerfile and compose.yaml to the repo, then pick it again"). Admins can instead fill the build spec under Advanced options.
- **Custom pipeline check.** When a repo already has a Woodpecker file, detection checks that it calls the Panel's build-notify webhook, i.e. references the component's notify secret name. If it does not, a warning says the first build will not deploy until the file notifies the Panel, and links to the snippet. It is a warning, not a block.
- *(Claude's call. Today generated is admin-only because the Panel's forge token commits to the repo. Limiting it to "create when absent" keeps that power narrow.)*

### Roles
- Rename stored project-member roles `contributor` → `qa` and `maintainer` → `engineer`, in a migration with `UPDATE` plus code changes.
- Labels: Viewer / QA / Engineer in all 5 locales.
- QA gains `service: ["logs", "control"]`.
- Org permission to create a project:
  - admins;
  - any user who is Engineer in at least one project.
- The creator becomes Engineer of the new project. The issue key is suggested from the name (uppercase, unique, editable).

### Environment fields
- **Drop `host`.** The `{host}` variable placeholder goes with it: no live template uses it (checked 2026-11-08). Template validation rejects `{host}` from now on.
  - The migration first copies `http://<host>` into `url` where `url` is null. 5 live rows carry `ip:port` with no URL.
  - Drop `legacy_owner`.
- **URL:**
  - with a domain, it is derived from it and read-only;
  - without a domain, it is editable under Advanced options.
- **Server:** one server per environment in the simple UI. Per-service servers, needed by old environments, appear under Advanced options in Source & Deploy.
- **Who may rebind servers in Settings:** engineers may, under the same rule as at create: the project default or an `open` server, and only before the first deploy. This replaces today's `server:manage`-only rule for editing bindings. *(Claude's call.)*

## Flows

### New environment (one page, inside a project)

The entry point is the project page, button "New environment". There is a global "New environment" in the command palette that asks for the project first. The page has one column and no stepper.

**Visible fields:**

1. **Start from:**
   - "New" (default when the project has no environments);
   - or "Copy of <env>" (default: the newest environment when one exists).
   - A copy pre-fills repos, branch, database choice and variables under the existing copy rules: secrets only with `variable:read`, generated/escrow are never copied.
2. **Name.** The slug is automatic.
3. **Repository:**
   - a repo picker searching the Bitbucket workspace through the CI connection;
   - the branch, defaulting to the repo's main branch;
   - "Add another repo" for multi-repo products.
   - Detection runs on pick: services, Dockerfile, pipeline file, compose `name:` / `container_name`.
4. **Database:** a checkbox, "Needs a database".
   - Default kind: shared on the server's database host if one exists, else container.
5. **Address:** the subdomain.
   - The default is `<project-key>-<slug>`, lowercase, on the default zone, with access policy "DSS Internal" (the default policy).
   - "No address" is an option.
6. A **Create** button, with a short live summary above it, e.g. "Server .56.129 · port 8104 · database scmb_dev3 · https://scmb-dev3.dssconsulting.id".

**Advanced options (collapsed):**
- server;
- deploy dir;
- services/container names;
- tag variable;
- health URL and timeout;
- pre-start command;
- auto-deploy (default **on** for non-prod); *(Claude's call)*
- backup before deploy;
- database kind, name, role and password variable;
- entry port;
- zone;
- access policy;
- pipeline mode/build spec (admins);
- environment kind and owner;
- variables editor.

**Behaviour:**
- **Preview** runs when the user presses Create or opens Advanced options, not on every keystroke.
- **Errors appear only after interaction or on Create.**
- **Create** runs the existing setup service:
  - register repos if needed;
  - create the environment, deploy targets and provisioning;
  - trigger the first build, which is deployed when built (`deploy_next_build`).
- After Create the user lands on the environment's Deploys page showing provisioning and build progress.

**Fixes for the canary bugs:**
1. No errors before typing.
2. Suggested DB/role names never collide with the copy source under the X/X_ rule.
3. The port suggestion is shown even when only the DB has issues; no misleading "no preflight" message.
4. No red flash after Create: the preview is not rerun after success.
5. The entry port is written as variable `ENTRY_PORT` automatically.
6. The role name follows a DB-name edit until the role is edited itself.
7. Detection reads compose `name:` and `container_name`.

The legacy routes become redirects:
- `apps.new` → the global New environment;
- `apps.$appKey.environments.new` → the same, with the repo preselected;
- `$projectKey.environments.new` → the new page.

### Environment Settings (tabs)

Each tab saves on its own. Advanced fields are in a Collapsible per tab.

- **General:**
  - name, kind, owner, URL (read-only when a domain exists);
  - Advanced: slug (read-only).
- **Source & Deploy:**
  - per repo: repo (read-only), branch, auto-deploy;
  - the environment's server (one picker; changing it is allowed only before the first deploy *(Claude's call, matches the binding-freeze rule)*);
  - Advanced: deploy dir, services, tag variable, health URL/timeout, pre-start, backup before deploy, per-service servers, service types/names (backend/frontend/db), `envFileManaged`.
- **Database:** none / shared / container / external, with the current fields under Advanced, except the kind and DB name.
- **Domain:** subdomain + access policy; Advanced: zone, entry port, external hostname.
- **Mail & Mock time:** Mailpit URL/credentials; mock-time API URL/key.
- **Danger:** delete environment.

The Variables page stays as it is. Lifecycle deletion of routes/DNS/DB (old plan 5) is folded into project 4. *(Claude's call.)*

### Issues on the environment page
- Default filter: status open + in progress, the same as `resolveStatusFilter` on `/issues`.
- A status filter control appears like the one on the global page. The project Issues tab gets the same default.

## Navigation and admin pages

- **Sidebar:** remove Apps. Admin group:
  - Activity;
  - Users;
  - Repositories;
  - Integrations (Jira, CI, Cloudflare);
  - Tunnels goes away.
- **CI:** `/admin/ci` becomes one settings page for the Woodpecker + Bitbucket connection (base URL, API token, forge username/token, verify button).
  - A list appears only if more than one connection exists. Today there is one. *(Claude's call: keep the table code path out; the single-row layout is enough.)*
- **Cloudflare:** one page `/admin/cloudflare` with sections:
  - Account (token, verify);
  - Zones;
  - Tunnels (remote);
  - **Advanced → Local tunnels** (the legacy model, still used by `dss-apps-136` on .136) until project 4 moves it.
  - Zones use the account token. The per-zone DNS token column stays, but is not shown unless a zone has no account coverage. `/admin/tunnels/*` redirects.
- **Command palette:** add every page the sidebar can show, gated by the same permissions:
  - Storage;
  - Repositories;
  - CI;
  - Cloudflare;
  - New environment.

## Migration

1. Hand-written Drizzle migration, following `db-migrations.md` (`SET lock_timeout='5s'`, dry-run with ROLLBACK, backup first):
   - add `projects.default_server_id`;
   - copy host into url where url is null;
   - drop `environments.host` and `legacy_owner`;
   - rename member roles.
2. After deploy, an admin sets the default server for each active project, and marks the dev/sandbox servers engineers may use as `open`. All 28 servers are `restricted` today.
3. **A project with no default server** (e.g. one an engineer just created): the New environment page shows a server picker of `open` servers in the visible fields. The first choice becomes the project default; only `server:manage` can change it later. With no `open` server it shows "Ask an admin to open a server for new environments" and Create is disabled. *(Decided with Romi 2026-11-08.)*

## Constraints
- **Stack and conventions:** Bun, Hono, React 19 + TanStack, shadcn/ui on Base UI (Collapsible from Base UI), Drizzle hand-written migrations, Vitest, Biome.
- **Copy:** user-facing strings go in all 5 `messages/*.json`; English and Indonesian are real translations.
- **Errors:** error bodies keep a stable `code`.
- **Security rules stay:**
  - variable reading gates secrets;
  - public/bypass/everyone access policies and the `prod` kind need admin (`server:manage`);
  - foreign Cloudflare objects are never taken over;
  - engineers are limited to ports 8100–8999.
- Production changes need Romi's go-ahead; the migration follows the established procedure.

## Goals, non-goals, anti-goals
- **Goals:**
  - an engineer goes from a fresh repo to a working URL by filling at most the four visible fields;
  - QA sees the same pages as today, plus restart;
  - one place for each setting.
- **Non-goals:**
  - SSH keys (project 3);
  - self-update and test instance (project 2);
  - Jenkins migration and environment deletion lifecycle (project 4);
  - a redesign of the QA pages.
- **Anti-goals:**
  - hiding information an engineer needs to debug a failed deploy (the Deploys page keeps step detail and logs);
  - removing an advanced capability that exists today;
  - a stepper.

## Left to the builder
- Exact component layout and copy within shadcn/Base UI defaults.
- How the repo picker paginates the workspace.
- Which existing components to reuse from `-components/setup/*`; the review/preview pieces should be reused, not rewritten.

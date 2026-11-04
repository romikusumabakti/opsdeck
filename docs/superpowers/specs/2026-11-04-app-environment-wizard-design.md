# Apps, environments and deploys in one flow — design

Date: 2026-11-04. Status: agreed in discussion with Romi; awaiting written approval.
Builds on `2026-11-03-ci-build-deploy-design.md` (Woodpecker builds, the Panel deploys).

## Why

Setting up a new app or a new environment, and deploying to it, today takes an
operator with shell access and an hour of hand work spread over five systems. The
HRIS and investment cutovers on 2026-11-04 needed all of these by hand:

- activating the repo in Woodpecker and setting its timeout (API calls), registering
  the app with `dist/deploy-app.js` and copying its notify secret into Woodpecker;
- committing a `.woodpecker.yaml` and a bundle layout to each repo;
- inserting `environments`, `environment_services` and `deploy_targets` rows with SQL.
  One omission (no `frontend` service) broke the environment dashboard;
- writing the server `.env` over SSH (random passwords, app keys, SMTP key), creating
  database roles, and keeping an off-host copy of keys;
- tunnel ingress, the DNS record and the Cloudflare Access app through the Cloudflare
  API, using a token minted by `cloudflared tunnel login` for the occasion;
- tricks to trigger a first deploy without a UI session.

Environment setup and deploy are also two separate places in the Panel. **Goal: any
DSS developer can create an app or an environment and get it deployed from the Panel
UI, in one flow, without knowing Woodpecker, Cloudflare or SSH.**

## Decisions made with Romi

| Topic | Decision |
| --- | --- |
| Entry points | Both "New app" and "Add environment" are frequent; both are in scope from the start |
| Users | **Every developer** can use the flow (including per-feature sandboxes) |
| Environment owner | *(Claude's call)* The creator is the environment's **owner** and may deploy, roll back, delete it and see its secrets, even without maintainer role |
| Restriction | **Per server:** an admin marks which users/roles may place environments on each server. Deploy/rollback on an existing environment keeps today's project roles (maintainer) |
| Database | **Chosen at creation:** shared postgres on the server (Panel creates DB + role), own postgres container per environment, or an existing database (connection details). The app's setting picks the default |
| Domain | **Cloudflare Tunnel, fully automated** (ingress + DNS + optional Access app), or **no domain** (IP:port). Domains behind the office nginx on .245 (Sucor) are **not automated**: an "external domain" entry is recorded with manual instructions |
| Forges | **One forge at a time** (Bitbucket now). The Panel's model is forge-neutral; moving DSS to GitHub/GitLab means switching Woodpecker's forge and re-linking repos. Woodpecker's multi-forge support is experimental per its docs, so it is not used |
| Existing environments | **Migrate all at once** (~30, across Sucor, CAR, TMLI, DapenMU, DPSIU, Common, .136) |
| Non-container environments | (CAR legacy systemd + SQL Server, etc.) migrate as **managed without deploy**: DB operations, mock time, service control and issues work as today; build/deploy stays outside the Panel until the app is containerised |
| Who registers apps | **Maintainers and admins** register new apps (connect a repo). Every developer may add environments to registered apps |
| Pipeline source | **Panel + fallback file:** Woodpecker gets the pipeline from the Panel's configuration extension; the Panel also commits the generated `.woodpecker.yaml` to the repo, so builds keep working with the last file while the Panel is down |
| CI/CD direction | Reviewed 2026-11-04: keep Woodpecker (build) + Panel (deploy). **No Dagger for now** (pipelines are three generated steps; its engine runs privileged by default, against the rootless BuildKit setup); revisit if CI grows heavy test matrices. Woodpecker sits behind a **CI provider** boundary in the Panel so a forge-native CI (GitLab CI, Forgejo Actions) can replace it later without changing the app/environment/deploy model |
| Wizard shape | **Hybrid:** "New app" is a stepper (Repo → Environment → Database → Variables → Domain → Review); "Add environment" is one page with collapsible sections, prefilled by **copying from an existing environment**. Both end on the same Review screen |

## Model

### App (new, replaces `deploy_apps`)

An app is **one deployable stack** (one `compose.yaml`, one deploy dir, one `.env`)
built from **one or more repos** *(Claude's call, from the builder check)*. Most apps
have one repo; the customer portal has two (backend repo ships `compose.yaml`,
frontend repo ships only its image), each with its own tag variable
(`BACKEND_IMAGE_TAG`, `FRONTEND_IMAGE_TAG`). A **component** = one repo + its build
spec + its tag variable.

- Per component: forge repo reference (forge-neutral: forge kind + owner/name +
  Woodpecker repo id) and its **build spec**, detected from the repo and editable:
  - images: name, Dockerfile path, build context (e.g. `backend/Dockerfile` → `hris-backend`);
  - bundle files: paths copied into the deploy dir (`compose.yaml` always, plus extra
    config such as `migrate/` or observability files);
  - tag format `origin-<branch>-<sha N>`. N is per app (7, or 9 where history needs it).
- **Runtime spec:** the compose services the Panel restarts on deploy, the pre-start
  command (migrations), the health check (URL or container healthcheck), the timeout.
- **Defaults for new environments:** database kind, variables template (see Variables),
  domain kind, deploy policy.
- Optional: `managedOnly` for apps the Panel does not build/deploy (legacy).

The app owns its pipeline. Woodpecker's **configuration extension** (stable, documented)
asks the Panel for the pipeline on every build, and the Panel answers with the
standard build → bundle → notify pipeline generated from the build spec. The Panel also
commits that generated file to the repo as `.woodpecker.yaml` (fallback when the Panel is
unreachable; the extension's answer wins while it is up). An app marked "custom
pipeline" keeps the repo's own file and the extension returns it unchanged.

### Environment (existing table, extended)

- Belongs to a project and, for deployable environments, to **one app**.
- **Deploy server** (where the app's stack runs) and deploy dir (default
  `/deployments/<app>`). Other services keep their own server: 12 of today's 47
  environments have their database on a separate server (CAR, TMLI, Common), and that
  stays valid (database kind "existing").
- Branch, deploy policy (auto/manual), who may deploy/rollback (project roles, as today).
- **Services:** the current fixed triple db/backend/frontend becomes "the services this
  environment has". Single-container apps (investment) and apps without a database are
  valid. Every screen that assumes the triple must cope.
- **Database binding:** kind (shared / own container / external), name, role, backup
  path. The existing db-ops features (backup, restore, rename, mock time) read from it.
- **Variables** (below), **domain bindings** (below), current tag, deployment history.

### Variables

- Stored in the Panel, **values encrypted** with the existing `SECRETS_KEY` (`enc:v1`).
- Each has a kind: `plain`, `secret` (hidden after save, never shown in logs) or
  `generated` (random value created once, e.g. DB passwords). Each may be `required`.
- The app's **variables template** declares names, kinds, defaults and per-environment
  placeholders (e.g. `CORS_ORIGINS=https://{domain}`), so a new environment starts
  complete.
- On every deploy the Panel **renders `.env`** on the server (0600, owned by the deploy
  user) from the stored variables plus `IMAGE_TAG`. The Panel's copy is the source of
  truth; server-only files other than `.env` (e.g. `compose.override.yaml`) are left
  alone.
- **Escrow flag** for keys whose loss makes data unreadable (HRIS `DATA_ENCRYPTION_KEY`):
  the UI warns that they must be stored outside the Panel too, and they can never be
  regenerated by the wizard.
- Visibility: secret values are visible only to project maintainers, admins and the
  environment's **owner** (below). "Copy from" by someone who may not see the source's
  secrets copies names only: secrets are regenerated (`generated`) or left blank
  (`secret`, must be filled) *(Claude's call)*.

### Domain binding

- **Tunnel** *(Claude's call)*: new tunnels are **remotely managed** (Cloudflare's
  recommended mode; configured through the API). Existing locally-managed tunnels
  (`config.yml`, e.g. `dss-demo-245`) keep working through the Panel's current tunnel
  feature and are converted only when an operator chooses to, never by adoption. The
  account-level Cloudflare token lives in a new settings record (account id + token),
  not in `cloudflare_zones`.
  Binding: hostname under a Cloudflare zone the Panel manages, the server's tunnel,
  the local origin (port of the environment's entry service), and an optional Access
  policy (e.g. "DSS Internal"). The Panel creates and removes ingress, DNS and Access.
- **None:** the environment is reached on `http://<server>:<port>`.
- **External:** a hostname recorded for display, with a checklist (DNS, reverse proxy,
  certificate) the operator completes by hand.

### Server (existing, extended)

- **Placement policy:** which users/roles may create environments on it.
- **Database hosts** *(Claude's call)*: the shared postgres containers on the server
  (e.g. `dplk-postgres`), recorded by an admin (preflight suggests candidates). The
  Panel creates roles and databases through `docker exec … psql -U postgres` on the
  local socket, as the Sucor runbooks do; no superuser password is stored.
- **Capabilities** found by a preflight: runtime (docker/podman + compose), registry
  reachability, free disk, cloudflared tunnel present (and which), ports in use.
- The wizard picks a **free port** for the entry service, avoiding ports already used on
  the server (on .136, every port 80–89 is taken).

## Flows

### New app (stepper)

1. **Repo:** search the forge's repos (through Woodpecker). The Panel reads the repo
   and detects Dockerfiles and `compose.yaml` services; the user confirms or edits the
   build and runtime spec. Missing contract pieces are shown clearly (e.g. "no
   compose.yaml").
2. **Environment:** name, project, server (filtered by placement policy), branch,
   deploy policy.
3. **Database:** shared / own container / external, prefilled from the app default.
4. **Variables:** from the template; required ones must be filled; generated ones are
   created.
5. **Domain:** tunnel (hostname, Access on/off) / none / external.
6. **Review** (shared with Add environment).

On "Create", the Panel activates the repo in Woodpecker, sets its settings and notify
secret, and starts the first build. The environment deploys that build when it lands
(auto), or the Review screen offers "deploy when built" for manual environments.

### Add environment (one page)

App picker, then "copy from" an existing environment of that app. Server, variables
(generated ones are regenerated, never copied; escrowed keys follow the copy rule the
app declares), database kind and domain pattern are prefilled. The user changes only
what differs. Same Review.

### Review and provisioning

The Review lists the concrete plan, e.g.:
"create role and database `hris_staging` on `dplk-postgres` at .113 → write `.env` →
add tunnel route `hris-staging.dssconsulting.id` → create DNS record → create Access app
(DSS Internal) → deploy `origin-main-d53cd2c`".

"Create & deploy" runs the plan as one **provisioning run** in the existing runs/log
UI. Steps are idempotent and the run is **resumable**: a failed step shows its error
and can be retried after a fix, without redoing earlier steps.

### Lifecycle

- **Delete environment:** stop and remove the stack, remove tunnel route, DNS record and
  Access app, take a final database backup and keep it. Confirmation names everything
  that will be removed.
- **Stale sandboxes:** environments without a deploy or a visit for N days are flagged
  to their owner for clean-up; nothing is deleted automatically.

## Migration of existing environments

All existing environments move to the new model in one migration project:

- **Container environments** (Sucor apps, HRIS, .136 stacks, …) are **adopted**: the
  Panel reads the running server (compose services, `.env`, running tag) and creates the
  app, environment, services, variables and domain records. Adoption must not restart or
  change anything on the server. Variables imported from `.env` become Panel-managed
  only after an operator confirms the import for that environment; until then the
  Panel does not rewrite that `.env`.
- **Non-container environments** (28 systemd services today) and **Kubernetes** ones
  (10 services, e.g. Common Portal K3s + Argo CD) become "managed without deploy".
- The data that exists today (environments, services, deploy apps/targets, builds,
  deployments, runs, issues, members) is preserved and remapped, not recreated.

## Rollout *(Claude's call)*

1. Data model migration: every existing environment is remapped at once (Migration
   section). Adopted container environments keep today's deploy behaviour (Panel sets
   only the tag variable) until an operator confirms their `.env` import; the two
   `.env` modes coexist per environment.
2. Wizard and provisioning on top of the new model.

## Integrations

- **CI provider boundary:** everything CI-specific (activate repo, secrets, pipeline
  generation, build notifications) goes through one provider interface; Woodpecker is
  the only implementation now.
- **Woodpecker v3.20.1** (.113): REST API with an admin-capable token (activate repo,
  settings, secrets, trigger pipelines) and the configuration extension endpoint
  served by the Panel (Woodpecker signs those requests; the Panel verifies them).
- **Cloudflare:** a long-lived API token scoped to Tunnel edit, DNS edit on the managed
  zone(s) and Access apps, stored encrypted in the Panel. Today no stored credential can
  edit `dssconsulting.id` DNS; creating that token is a prerequisite.
- **Servers:** the existing SSH credentials and deploy engine (`lib/deploy/script.ts`).

## Constraints

- Existing stack: Bun, Hono, React (TanStack), Drizzle with hand-written migrations
  (backup → dry run in a transaction → apply), Vitest. Panel timestamps are UTC.
- Reuse the existing deploy engine, run log, secrets encryption, roles and
  `requireProjectPermission`.
- Never print or log secret values (current Panel rule; DrizzleQueryError params were a
  past leak).
- Builds stay in Woodpecker on .113 (rootless BuildKit). Target servers never build.

## Goals, non-goals, anti-goals

**Goals:** one flow for app + environment + first deploy; any developer can do it on
allowed servers; no SSH or SQL for routine setup; all existing environments in the
same model.

**Non-goals (now):** several forges at once; Dagger; automating nginx on .245; Kubernetes;
multi-server environments; building on target servers; replacing Woodpecker.

**Anti-goals:** a wizard that hides a half-finished setup (every step's result must be
visible and resumable); secrets visible to people without the right role or written to
logs; adoption that restarts or rewrites a running environment without an explicit
confirmation; a per-server proxy (Traefik-style) that collides with existing compose
stacks and tunnels.

## Left to the builder

Table and API design; detection heuristics for Dockerfiles and compose services; the
exact pipeline template; preflight checks; UI components (shadcn/Base UI per the Panel's
conventions); how the provisioning run stores step state; the stale-sandbox threshold
default; order of implementation phases (proposed in the plan).

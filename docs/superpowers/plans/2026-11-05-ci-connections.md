# CI connections and app registration (plan 2 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins configure CI connections in the Panel, maintainers and admins register apps from the UI (repo activated in Woodpecker, notify secret set, settings applied), and Woodpecker gets each Panel-generated pipeline from the Panel through its configuration extension, with a committed `.woodpecker.yaml` as fallback.

**Architecture:** A provider interface (`lib/ci/`) hides Woodpecker behind `CiProvider`; a CI connection row carries the provider's URL and encrypted credentials. Each app component gets a pipeline mode: `custom` (the repo's own file; the extension answers 204) or `generated` (the Panel renders the standard build → bundle → notify pipeline from a build spec). The configuration extension endpoint verifies Woodpecker's RFC 9421 ed25519 request signature. Fallback files are committed through a forge client (Bitbucket only now).

**Tech Stack:** Bun, Hono, React 19 + TanStack Router/Query, Drizzle (hand-written SQL migrations), Zod, Vitest, Biome, node:crypto (ed25519, sha-256). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-app-environment-wizard-design.md` (sections "App", "CI connections", "Integrations"; decisions "Who registers apps", "Pipeline source", "CI/CD direction", "Forges").

## Global Constraints

- Maintainers (of any project) and admins register new apps; CI connections are managed by org `integration:manage` (admins).
- Pipeline source: the configuration extension supplies generated pipelines; the Panel also commits the generated file as `.woodpecker.yaml` (fallback). Apps marked custom keep the repo's file (extension answers `204 No Content`).
- Woodpecker v3.20.1 facts (verified in its source, `server/services/config/http.go`, `server/pipeline/create.go`, `server/services/utils/http.go`): request body `{repo, pipeline, netrc?, restart, configuration?: [{name, data}]}`; response `{configs: [{name, data}]}` or 204; a non-200/204 status makes Woodpecker fall back to the repo's config, a transport failure fails the pipeline; requests are signed per RFC 9421 with ed25519, components `"@request-target"` and `"content-digest"`, signature name / key id `woodpecker-ci-extensions`; the public key is served at `GET <woodpecker>/api/signature/public-key`; extension hosts in private ranges are blocked unless `WOODPECKER_EXTENSIONS_ALLOWED_HOSTS` allows them; repo fields `config_extension_endpoint`, `config_extension_exclusive`, `config_extension_netrc`.
- The extension endpoint is reached through the public Panel URL `https://panel.dssconsulting.id/api/ci/config/<connectionId>` with a Cloudflare Access bypass for that path (same pattern as `/api/deploy-hooks`).
- Generated pipelines match the existing hand-written ones: tag `origin-<branch with / → ->-<sha cut to tagShaLength>`, BuildKit remote driver `tcp://buildkitd:1234`, org secrets `registry_username`/`registry_password`, repo secret `opsdeck_notify`, notify with curl and header `X-Opsdeck-Signature: sha256=<hex>` to `https://panel.dssconsulting.id/api/deploy-hooks/builds`, block scalars (`- |`) for multi-line commands, `$${VAR}` escaping, `cd` only inside subshells.
- Credentials (Woodpecker token, forge token, notify secrets) are encrypted with `lib/secrets.ts`, write-only in the API and UI, never logged.
- Woodpecker repo ids in URLs: the forge remote id contains `{}` and must be URL-encoded.
- Migrations: `drizzle/<YYYYMMDDHHMMSS>_<name>/migration.sql` in `BEGIN; … COMMIT;`, additive (backward compatible), applied before the build that needs it.
- English for code/comments/commits; UI strings in all five `messages/*.json` (en and id translated; es/zh/ar may carry English).
- `bun run typecheck`, `bun run lint`, `bun run test` green before each commit.

## Review Focus

1. A request to the extension with a valid signature but a body that differs from the signed `content-digest` must be rejected (401), not answered.
2. An extension call for a repo the Panel does not know, or a component in `custom` mode, must answer 204 so Woodpecker keeps the repo file — never 404/500 (which would also fall back, but logs a warning on every build).
3. Registering an app whose repo is already active in Woodpecker (all seven current repos are) must reuse the existing Woodpecker repo and not fail or create a duplicate.
4. A forge commit failure (no forge token, expired token, protected branch) must not undo an otherwise successful registration; the UI shows the fallback file as "not committed" with the reason.
5. Rotating a notify secret from the app page must update both the Panel and the Woodpecker repo secret, or report which side failed.

---

## File structure

| File | Responsibility |
| --- | --- |
| `drizzle/20261105010000_ci_connection_credentials/migration.sql` | credentials and key columns on `ci_connections`; `pipeline_mode` + `build_spec` on `app_components`; fallback commit status columns |
| `lib/ci/types.ts` | `CiProvider` interface, repo/secret types |
| `lib/ci/woodpecker.ts` | Woodpecker REST client implementing `CiProvider` |
| `lib/ci/build-spec.ts` | Zod schema + types for the build spec |
| `lib/ci/pipeline.ts` | `generateWoodpeckerPipeline` |
| `lib/ci/http-signature.ts` | RFC 9421 ed25519 verification for Woodpecker requests |
| `lib/ci/forges/bitbucket.ts` | `commitFile` via the Bitbucket REST API |
| `server/services/ci-connections.ts`, `server/routes/ci-connections.ts` | CRUD (admin), public-key refresh |
| `server/routes/ci-config.ts` | the configuration extension endpoint |
| `server/services/apps.ts`, `server/routes/apps.ts` | app list/register/rotate secret/commit fallback |
| `web/routes/$locale/_app/admin.ci.*.tsx` | CI connections admin pages (pattern: `admin.jira.*`) |
| `web/routes/$locale/_app/apps.*.tsx`, `web/api/apps.ts` | Apps list, registration form, app detail |

---

### Task 1: Schema for credentials, pipeline mode and build spec

**Files:**
- Create: `drizzle/20261105010000_ci_connection_credentials/migration.sql`
- Modify: `lib/db/schema.ts` (`ciConnections`, `appComponents`)
- Test: `tests/ci-schema-migration.test.ts`

**Interfaces:**
- Produces: `ciConnections.apiToken` (text, encrypted, nullable), `ciConnections.forgeUsername` (text, nullable), `ciConnections.forgeToken` (text, encrypted, nullable), `ciConnections.extensionPublicKey` (text PEM, nullable), `ciConnections.extensionPublicKeyFetchedAt` (timestamp, nullable); `pipelineModeEnum = pgEnum("pipeline_mode", ["custom", "generated"])`; `appComponents.pipelineMode` (not null, default `custom`), `appComponents.buildSpec` (jsonb, nullable), `appComponents.fallbackCommittedSha` (text, nullable), `appComponents.fallbackCommitError` (text, nullable).

- [ ] **Step 1: Failing static test:** the SQL is one transaction, contains `CREATE TYPE pipeline_mode AS ENUM ('custom', 'generated')`, adds `pipeline_mode … NOT NULL DEFAULT 'custom'`, contains no `DROP` and no `RENAME`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** write migration (additive only) + schema.
- [ ] **Step 4:** apply to a scratch `postgres:18` restored from a live copy prepared by the controller (container `ci-mig-scratch`, db `dss_panel`); check all 7 components read `custom`; tests + typecheck green.
- [ ] **Step 5: Commit** `feat(db): CI connection credentials and component pipeline mode`

### Task 2: CI provider interface and Woodpecker client

**Files:**
- Create: `lib/ci/types.ts`, `lib/ci/woodpecker.ts`
- Test: `tests/ci-woodpecker.test.ts`

**Interfaces:**
- Produces:
  - `type CiRepo = { ciRepoId: string; fullName: string; forgeRemoteId: string; active: boolean }`
  - `type RepoSettings = { timeoutMinutes: number; cancelPreviousOnPush: boolean; configExtensionEndpoint: string | null }`
  - `interface CiProvider { listRepos(): Promise<CiRepo[]>; activateRepo(forgeRemoteId: string): Promise<CiRepo>; updateRepoSettings(ciRepoId: string, s: RepoSettings): Promise<void>; upsertRepoSecret(ciRepoId: string, name: string, value: string, events: ("push" | "manual")[]): Promise<void>; fetchExtensionPublicKey(): Promise<string> }`
  - `createWoodpeckerProvider(baseUrl: string, apiToken: string, fetchImpl?: typeof fetch): CiProvider`
  - `class CiProviderError extends Error { status: number }` — message never contains the token.
- Endpoints (Woodpecker v3 API): `GET /api/user/repos?all=true`, `POST /api/repos?forge_remote_id=<urlencoded>` (already active → read `GET /api/repos/lookup/<full_name>` and return it), `PATCH /api/repos/<id>` with `timeout`, `cancel_previous_pipeline_events` (`["push"]` or `[]`), `config_extension_endpoint`, `config_extension_exclusive: false`, `config_extension_netrc: false`; secrets `GET/POST /api/repos/<id>/secrets`, `PATCH /api/repos/<id>/secrets/<name>`; `GET /api/signature/public-key`. Auth header `Authorization: Bearer <token>`.

- [ ] **Step 1: Failing tests** (mocked `fetch`): `activateRepo` URL-encodes `{35a90db5-…}` as `%7B35a90db5-…%7D`; activating an already-active repo returns the existing repo without error (Review Focus 3); `upsertRepoSecret` PATCHes when the secret exists and POSTs otherwise; a 401 from Woodpecker throws `CiProviderError` whose message does not include the token; `updateRepoSettings` sends exactly the five fields above.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS, full suite green.
- [ ] **Step 5: Commit** `feat(ci): provider interface and Woodpecker client`

### Task 3: CI connections admin

**Files:**
- Create: `server/services/ci-connections.ts`, `server/routes/ci-connections.ts`, `web/api/ci-connections.ts`, `web/routes/$locale/_app/admin.ci.index.tsx`, `admin.ci.$id.tsx`
- Modify: `server/app.ts` (mount next to `jiraRouter`), admin nav (`adminItems` in `components/app-sidebar.tsx`), messages
- Test: `tests/ci-connections-api.test.ts`

**Interfaces:**
- Consumes: Task 1 columns, Task 2 `createWoodpeckerProvider`.
- Produces: `GET /api/ci-connections` (no credentials; booleans `hasApiToken`, `hasForgeToken`), `PATCH /api/ci-connections/:id` (`name`, `baseUrl`, `apiToken?`, `forgeUsername?`, `forgeToken?`; empty string clears, absent keeps), `POST /api/ci-connections/:id/refresh-key` (fetches and stores the public key), `getProviderForConnection(id: string): Promise<CiProvider>` in the service (decrypts the token; throws 409 "This CI connection has no API token" when missing). All require org `integration:manage`.

- [ ] **Step 1: Failing tests:** a non-admin gets 403 on all three routes; list never contains `apiToken`/`forgeToken` values; PATCH with `apiToken: ""` clears it, without the key keeps it; refresh-key stores the PEM returned by the provider.
- [ ] **Step 2–4:** FAIL → implement (UI: list + edit form with password-type token inputs showing "set"/"not set", a "Refresh Woodpecker key" button showing the fetched-at time) → PASS.
- [ ] **Step 5: Commit** `feat(ci): CI connections admin`

### Task 4: Build spec and pipeline generator

**Files:**
- Create: `lib/ci/build-spec.ts`, `lib/ci/pipeline.ts`
- Test: `tests/ci-pipeline.test.ts`, fixture `tests/fixtures/pipeline-two-images.yaml`

**Interfaces:**
- Produces:
  - `buildSpecSchema = z.object({ branches: z.array(z.string().min(1)).min(1), tagShaLength: z.number().int().min(7).max(40).default(7), images: z.array(z.object({ name: z.string(), dockerfile: z.string(), context: z.string() })).min(1), bundleFiles: z.array(z.object({ from: z.string(), to: z.string() })).min(1), checks: z.array(z.object({ name: z.string(), image: z.string(), dir: z.string(), commands: z.array(z.string()).min(1) })).default([]), timeoutMinutes: z.number().int().min(10).max(180).default(60) })`; `type BuildSpec`.
  - `generateWoodpeckerPipeline(componentKey: string, spec: BuildSpec): string` — YAML: `when: [{ event: [push, manual], branch: <branches> }]`; one step per `checks` entry (commands wrapped in `( cd <dir> && … )` as one block scalar); step `build` (tag, docker config, buildx remote, one `docker buildx build --push -f <dockerfile> -t "$${REGISTRY}/<name>:$${TAG}" <context>` per image, bundle: `mkdir -p .bundle/bundle`, `cp` each `from` to `.bundle/bundle/<to>` creating parent dirs, `printf 'FROM scratch\nCOPY bundle /bundle\n'`, push `<componentKey>-deploy:$${TAG}`), step `notify-panel` (body `{"app":"<componentKey>",…}` signed with `opsdeck_notify`).
  - Header comment: `# Generated by DSS Panel for <componentKey> — edit the build spec in the Panel, not this file.`

- [ ] **Step 1: Failing tests:** golden test — a spec with two images, `bundleFiles` `compose.yaml→compose.yaml` and `deploy/migrate/init_db.sql→migrate/init_db.sql`, one check, branches `["main"]`, `tagShaLength: 9` renders byte-equal to the fixture; the output parses with the existing `yaml` dependency (`parseDocument`, as in `lib/tunnels/ingress.ts`) and every `commands` item is a string; generate the YAML with that library too, not string concatenation; no line contains `cd ` outside `( … )`; every `$` before `{` is doubled; a `bundleFiles.to` containing `..` is rejected by the schema.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(ci): build spec and generated Woodpecker pipeline`

### Task 5: Configuration extension endpoint

**Files:**
- Create: `lib/ci/http-signature.ts`, `server/routes/ci-config.ts`
- Modify: `server/app.ts` (mount `/api/ci/config` next to `/api/deploy-hooks`, line ~114, outside session auth)
- Test: `tests/ci-http-signature.test.ts`, `tests/ci-config-route.test.ts`

**Interfaces:**
- Consumes: Task 1 columns (`extensionPublicKey`, `pipelineMode`, `buildSpec`), Task 4 generator.
- Produces:
  - `verifyWoodpeckerSignature(req: { method: string; url: string; headers: Headers; body: Uint8Array }, publicKeyPem: string): { ok: true } | { ok: false; reason: string }` — RFC 9421: parse `Signature-Input` for label `woodpecker-ci-extensions` with components `("@request-target" "content-digest")`, rebuild the signature base (`"@request-target": <path+query>`, `"content-digest": <header value>`, `"@signature-params": <params>`), verify ed25519 over it, and check `Content-Digest` (`sha-256=:<base64>:`) equals the body's sha-256; reject when `created` is more than 300 s from now.
  - `POST /api/ci/config/:connectionId`: invalid/missing signature → 401; unknown connection → 401 (same body); connection without stored key → 503; repo (matched by `app_components.ci_repo_id = String(body.repo.id)` and `ci_connection_id = :connectionId`) unknown or component `custom` → 204; `generated` → 200 `{ configs: [{ name: ".woodpecker.yaml", data: generateWoodpeckerPipeline(componentKey, buildSpec) }] }`.

- [ ] **Step 1: Failing tests:** signature tests generate an ed25519 key pair with node:crypto and sign a request the way RFC 9421 specifies (base string built in the test independently, not via the code under test) — valid → ok; body changed after signing → `ok: false` (Review Focus 1); wrong key → false; `created` 10 minutes old → false. Route tests: unknown repo → 204 (Review Focus 2); custom component → 204; generated → 200 with the generator output; bad signature → 401.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(ci): configuration extension endpoint for Woodpecker`

### Task 6: Fallback file commit (Bitbucket)

**Files:**
- Create: `lib/ci/forges/bitbucket.ts`
- Test: `tests/ci-bitbucket.test.ts`

**Interfaces:**
- Produces: `commitFile(auth: { username: string; token: string }, repoFullName: string, branch: string, path: string, content: string, message: string, fetchImpl?: typeof fetch): Promise<{ sha: string }>` — `POST https://api.bitbucket.org/2.0/repositories/<repoFullName>/src` multipart form (`<path>=<content>`, `message`, `branch`), HTTP Basic with username/token; the new commit sha is read from the `Location` header (`…/commit/<sha>`); errors throw `CiProviderError` with Bitbucket's `error.message` and the status, never the token. `getDefaultBranch(auth, repoFullName): Promise<string>` via `GET /2.0/repositories/<repo>` → `mainbranch.name`.

- [ ] **Step 1: Failing tests** (mocked fetch): multipart body carries the three fields; Basic header; 403 → error mentioning the status and Bitbucket's message, not the token; sha parsed from `Location`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(ci): commit the fallback pipeline file to Bitbucket`

### Task 7: App registration and app pages

**Files:**
- Create: `server/services/apps.ts`, `server/routes/apps.ts`, `web/api/apps.ts`, `web/routes/$locale/_app/apps.index.tsx`, `apps.new.tsx`, `apps.$appKey.tsx`
- Modify: `lib/permissions.ts` (add `canRegisterApp`), main nav (`Apps` item), `lib/apps.ts` (reuse `listApps`, public columns only), messages
- Test: `tests/apps-api.test.ts`, `tests/permissions.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6 (`getProviderForConnection`, `generateWoodpeckerPipeline`, `buildSpecSchema`, `commitFile`, `getDefaultBranch`), plan 1's `apps`/`appComponents`.
- Produces:
  - `canRegisterApp(orgRole: string | null | undefined, projectRoles: ProjectRole[]): boolean` — true for org `integration:manage`, or when any effective project role is `maintainer` (org infra counts via `implicitProjectRole`).
  - `GET /api/apps` (any signed-in user; components without secrets, plus `pipelineMode`, `fallbackCommittedSha`, `fallbackCommitError`), `GET /api/ci-connections/:id/repos` (registrants; `CiRepo[]`, marks repos already linked to a component).
  - `POST /api/apps` body `{ appKey, name, components: [{ componentKey, ciConnectionId, forgeRemoteId, bundleImage, pipelineMode, buildSpec? }] }` (`buildSpec` required iff `generated`). Order: validate → for each component: `activateRepo` (reuse if active) → `updateRepoSettings({ timeoutMinutes: buildSpec?.timeoutMinutes ?? 60, cancelPreviousOnPush: true, configExtensionEndpoint: "https://panel.dssconsulting.id/api/ci/config/<connectionId>" })` → generate notify secret (32 random bytes hex) → `upsertRepoSecret(id, "opsdeck_notify", secret, ["push","manual"])` → insert app + components in one transaction (secret encrypted). Then, outside the transaction, for `generated` components with a forge token: `commitFile` to the default branch, store `fallbackCommittedSha` or `fallbackCommitError` (Review Focus 4). A provider failure before the insert → 502 naming the step; nothing inserted.
  - `POST /api/apps/:appKey/components/:componentKey/rotate-secret` (registrants): new secret → Woodpecker first, then Panel; on Woodpecker failure 502 "Woodpecker secret not updated; Panel secret unchanged"; on Panel failure after Woodpecker succeeded 500 "Woodpecker has the new secret but the Panel does not — rotate again" (Review Focus 5).
  - `POST /api/apps/:appKey/components/:componentKey/commit-fallback` (registrants): retries the commit.
  - Pages: Apps list (app, components, repo, mode, fallback status); "Register app" form (connection → repo search → component key/bundle image prefilled from the repo name → mode → build spec editor for `generated` with the fields of `buildSpecSchema`, YAML preview from the generator); app detail with rotate-secret and commit-fallback buttons. Registrants only see the buttons.

- [ ] **Step 1: Failing tests:** `canRegisterApp` matrix (admin yes; member with one maintainer project yes; member with only contributor no; infra yes); registration happy path calls provider in the order above and stores an encrypted secret; already-active repo reused (Review Focus 3); provider failure → 502 and no rows; commit failure → 201 with `fallbackCommitError` set (Review Focus 4); rotate-secret failure messages (Review Focus 5); `GET /api/apps` never returns `notifySecret`.
- [ ] **Step 2–4:** FAIL → implement → PASS (plus manual check in `bun run dev` if a local DB is available; otherwise say so).
- [ ] **Step 5: Commit** `feat(apps): register apps from the Panel`

### Task 8: Go live (controller, after Romi's go-ahead)

- [ ] **Step 1:** Backup + dry-run + apply `20261105010000_ci_connection_credentials` (additive, so applying before the deploy is safe); merge and push `main`; Romi runs Jenkins `DSS/dss-panel`; health 200.
- [ ] **Step 2:** Cloudflare Access: add a bypass app for `panel.dssconsulting.id/api/ci/config` (pattern of `dss-panel-deploy-hooks`, token `~/.config/secrets/dss/cloudflare-access-token`); verify `curl -s -o /dev/null -w '%{http_code}' -X POST https://panel.dssconsulting.id/api/ci/config/<id>` → 401 from the origin, not a 302 to Access.
- [ ] **Step 3:** Romi enters the Woodpecker token in Admin → CI connections and clicks "Refresh Woodpecker key"; the controller confirms the stored PEM matches `GET http://127.0.0.1:8000/api/signature/public-key` on .113.
- [ ] **Step 4:** Link the 7 existing components to their Woodpecker repos' settings: set `config_extension_endpoint` on repo 2 (cms, custom) only; re-run its latest pipeline; Panel log shows a verified signature and a 204; the pipeline runs the repo file as before. Then set it on the other six.
- [ ] **Step 5:** Forge token: Romi creates an Atlassian API token with Bitbucket repository write scope for his account and enters username + token in the connection (optional now — until then generated components show "not committed: no forge token").
- [ ] **Step 6:** Memory: opsdeck `panel-deploy-feature.md`, DSS `woodpecker-113.md` (extension endpoint, allowed hosts unchanged because the URL is public), `cloudflare.md` (new bypass app).

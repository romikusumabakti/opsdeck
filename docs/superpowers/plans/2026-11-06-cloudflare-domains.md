# Cloudflare domains: tunnel route, Access app, DNS record (plan 3b-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An environment gets `https://<label>.<zone>` with no operator: provisioning adds the route to the server's remotely-managed tunnel, creates the Access app first, then publishes the DNS record.

**Architecture:**
- One account-level Cloudflare credential record, encrypted with `SECRETS_KEY`.
- A registry of remotely-managed tunnels per server.
- One domain binding per environment.
- Three new idempotent provisioning step kinds run by the existing provisioning job (plan 3b-1).
- A small hand-written REST client in `lib/cloudflare/` (same style as `lib/tunnels/cloudflare.ts`, no SDK).
- Locally-managed tunnels (`tunnels` table, `config.yml`) are untouched.

**Tech Stack:** Bun, Hono, React 19 + TanStack, Drizzle (hand-written SQL migration), Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-04-app-environment-wizard-design.md`, sections "Domain binding", "Review and provisioning", "Integrations → Cloudflare". Plan 3b-1 (`2026-11-05-provisioning.md`) provides the provisioning run. Plan 5 does removal on environment delete.

## Global Constraints

- **Token:** one Cloudflare API token, stored encrypted in `cloudflare_accounts.api_token` and never sent to the client. Romi creates it with exactly these permissions:
  - Account → Cloudflare Tunnel: Edit;
  - Account → Access: Apps and Policies: Edit;
  - Account → Access: Organizations, Identity Providers, and Groups: Read;
  - Zone → DNS: Edit for zone `dssconsulting.id`.
- **Zones:** the zone must be registered in `cloudflare_zones`. Its `zoneId` is used, while the zone row's own token stays for the existing tunnel feature.
- **Hostname:** exactly one label under the zone, `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`. Universal SSL on the Free plan covers only one level, e.g. `hris-staging.dssconsulting.id`. The label is refused when it equals an existing DNS record name that the Panel did not create for this environment.
- **Step order** for a tunnel domain: `tunnel_route` → `access_app` → `dns_record` → `deploy`, so a hostname is never resolvable before Access protects it *(controller's call; the spec lists DNS before Access)*. A binding with no Access policy skips `access_app`.
- **Who decides Access:** a binding without an Access policy (public) needs org `server:manage`. Project maintainers must pick a reusable Access policy *(controller's call: the spec makes Access optional and is silent on who may go public)*.
- **Origin:** `http://<tunnel.originHost>:<environments.entry_port>`. `originHost` defaults to `localhost`, which is right for systemd `cloudflared` on the host, as on .113.
- **Ingress edits:** read-modify-write of the remote tunnel config (`GET`/`PUT /accounts/{acc}/cfd_tunnel/{id}/configurations`).
  - Unknown fields of `config` and of other rules are preserved.
  - The new rule goes just before the catch-all (the last rule, which has no `hostname`).
  - Concurrent edits to one tunnel are serialized with `pg_advisory_xact_lock(hashtextextended('cf-tunnel:' || tunnelId, 0))` held across the GET and the PUT.
- **Idempotency:** each step succeeds without a write when its object already exists exactly as wanted. It fails with a clear message, without changing anything, when an object with the same hostname exists in another shape. Those shapes are an ingress rule to another service, a DNS record of another type or content, and an Access app on that domain the Panel did not create.
- **Panel tag:**
  - Access apps the Panel creates are named `opsdeck:<environmentId>`.
  - DNS records it creates carry comment `opsdeck:<environmentId>`.
  - Ownership checks use these markers.
- **Logs:** never log the token. Cloudflare errors pass through `describeCloudflareErrors` (no headers).
- **Process:**
  - The migration is additive and applied before the build. `ADD VALUE` for the new step kinds goes before `BEGIN` (strip those lines for the ROLLBACK dry run).
  - English for code; UI strings in all five `messages/*.json`.
  - `bun run typecheck`, `bun run lint` and `bun run test` must be green before each commit.

## Review Focus

1. **Two environments provisioned at once on the same tunnel.** Both routes must end up in the config, with no lost update (Task 3: advisory lock test with interleaved GET/PUT mocks).
2. **A label that already exists** (e.g. `hris`, `panel`, a cPanel `mail`): the step fails before any write and names the clash. In particular, an existing Access app or DNS record is never taken over or overwritten (Task 3).
3. **A maintainer chooses a public binding without an Access policy:** 403. An admin may do it (Task 2).
4. **A retry after `access_app` succeeded but `dns_record` failed** reuses the Panel-tagged Access app and creates no second one (Task 3).
5. **The config PUT** keeps every existing rule and its `originRequest` byte-for-byte, including the catch-all `http_status:404` (Task 1 client test with the `dss-srv-113` shape).

---

### Task 1: Schema, Cloudflare account record, REST client, admin UI

**Files:**
- Create: `drizzle/20261106000000_cloudflare_domains/migration.sql`, `lib/cloudflare/api.ts`, `server/services/cloudflare-account.ts`, `server/routes/cloudflare-account.ts`, admin page `web/routes/$locale/_app/admin.cloudflare.tsx` (+ nav link next to Tunnels)
- Modify: `lib/db/schema.ts`, `server/router.ts`, `messages/*.json`
- Test: `tests/cloudflare-domains-migration.test.ts`, `tests/cloudflare-api.test.ts`, `tests/cloudflare-account-api.test.ts`

**Interfaces:**
- Produces (schema):
  - **`cloudflare_accounts`:** `id uuid pk uuidv7()`; `account_id text not null unique`; `name text not null`; `api_token text not null` (encrypted); `access_idp_id text null`, the IdP Access apps allow (Entra, `1bc8806d-34a1-477f-9989-63cf4b59f201`), picked in the UI from the IdP list; timestamps.
  - **`remote_tunnels`:** `id uuid pk`; `account_id uuid → cloudflare_accounts restrict`; `server_id uuid → servers restrict`; `tunnel_id text not null`; `name text not null`; `origin_host text not null default 'localhost'`; timestamps. Unique `(account_id, tunnel_id)` and unique `(server_id)`: one remote tunnel per server.
  - **Enum `domain_kind`:** `tunnel | external`. No row means "none".
  - **`environment_domains`:**
    - `environment_id uuid pk → environments cascade` (one domain per environment);
    - `kind domain_kind not null`;
    - `hostname text not null unique`;
    - `zone_id uuid null → cloudflare_zones restrict` and `remote_tunnel_id uuid null → remote_tunnels restrict` (tunnel only);
    - `access_policy_id text null`;
    - `access_app_id text null`, `dns_record_id text null` (written by the steps);
    - timestamps.
    - Check: `kind <> 'tunnel' OR (zone_id IS NOT NULL AND remote_tunnel_id IS NOT NULL)`.
  - **`provisioning_step_kind`** gains `tunnel_route`, `access_app`, `dns_record`.
- Produces (`lib/cloudflare/api.ts`; all calls take `{ accountId, apiToken }` as `creds`):
  - `verifyAccount(creds): Promise<{ tunnels: number }>`. It lists tunnels (`GET /accounts/{acc}/cfd_tunnel?is_deleted=false&per_page=1`, reading `result_info.total_count`) and reads `GET /accounts/{acc}/access/policies?per_page=1`.
  - `listTunnels(creds): Promise<{ id: string; name: string; status: string; remoteConfig: boolean }[]>`.
  - `getTunnelConfig(creds, tunnelId): Promise<TunnelConfig>` and `putTunnelConfig(creds, tunnelId, config: TunnelConfig): Promise<void>`. `TunnelConfig = { ingress: IngressRule[]; [k: string]: unknown }` and `IngressRule = { hostname?: string; service: string; [k: string]: unknown }`.
  - `withIngressRoute(config, hostname, service): { config: TunnelConfig; changed: boolean }`. Pure. It throws `CloudflareConflictError` when the hostname routes elsewhere.
  - `findDnsRecord(creds, zoneId, name)`, `createProxiedCname(creds, zoneId, name, tunnelId, comment)`.
  - `listAccessPolicies(creds): Promise<{ id: string; name: string }[]>` (reusable policies), `listIdentityProviders(creds)`.
  - `findAccessAppByDomain(creds, domain)`, `createAccessApp(creds, { name, domain, policyId, idpId })`. The app is `type: "self_hosted"`, `allowed_idps: [idpId]`, `auto_redirect_to_identity: true`, `policies: [{ id: policyId, precedence: 1 }]`.
  - Errors: `CloudflareApiError` (reuse the one in `lib/tunnels/cloudflare.ts`, moved or re-exported) and `CloudflareConflictError`.
- Service and routes (org `server:manage`):
  - `GET /api/cloudflare-account` returns the row without the token, plus a `hasToken` flag;
  - `PUT /api/cloudflare-account` upserts (the token is write-only; blank keeps the old one);
  - `POST /api/cloudflare-account/verify`;
  - `GET /api/cloudflare-account/tunnels`, `/access-policies` and `/identity-providers`.
  - Activity `cloudflare_account.update` records field names only.

- [ ] **Step 1: Failing tests.**
  - **Migration test:** `ADD VALUE IF NOT EXISTS` ×3 before `BEGIN`, `SET lock_timeout = '5s'`, the three tables, the check, no `DROP`/`RENAME`.
  - **Client tests** (fetch mocked):
    - the URLs and bodies of each call;
    - `withIngressRoute` on the real `dss-srv-113` shape (`panel`, `ci` → `http://localhost:8000`, `hris` → `http://localhost:8091`, and catch-all `http_status:404` with `originRequest` fields) inserts before the catch-all and keeps everything else deep-equal (Review Focus 5);
    - the same hostname with the same service gives `changed: false`, and with another service throws a conflict;
    - a config without a catch-all gets the rule appended plus a catch-all `http_status:404`;
    - the token never appears in thrown messages.
  - **API tests:** 403 without `server:manage`; GET never returns the token; a blank token on PUT keeps the stored one.
- [ ] **Step 2: Run** `bunx vitest run tests/cloudflare-domains-migration.test.ts tests/cloudflare-api.test.ts tests/cloudflare-account-api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces. The admin page holds the account id, the name, the token (write-only input), and an IdP select loaded after save. The Verify button shows the tunnel count. The page also lists the account's tunnels; registering them is Task 2.
- [ ] **Step 4: Run** the tests and the full check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cloudflare): account credential record and REST client`

### Task 2: Remote tunnels per server and the environment domain binding

**Files:**
- Create: `server/services/remote-tunnels.ts`, `server/services/environment-domains.ts`, routes for both, `lib/domains/validation.ts`
- Modify:
  - `web/routes/$locale/_app/admin.cloudflare.tsx` (register a listed tunnel to a server, set its origin host, delete);
  - the environment settings page: a new "Domain" section with kind none/tunnel/external, a zone select, a label input showing `<label>.<zone>`, a local port input (`entryPort`), an Access policy select (with "Public (no Access)" only for `server:manage`), and for external a hostname plus a static checklist (DNS, reverse proxy, certificate);
  - `messages/*.json`.
- Test: `tests/remote-tunnels-api.test.ts`, `tests/environment-domains-api.test.ts`, `tests/domain-validation.test.ts`

**Interfaces:**
- Consumes: the Task 1 schema and client; `environments.entryPort`. The environment's deploy server = the server of its deploy targets; it must be the same for all of them, otherwise the binding is refused with `domainMultiServer`.
- Produces:
  - `domainLabelSchema` (regex in Global Constraints) and `hostnameFor(label, zoneName): string`.
  - `GET/PUT/DELETE /api/environments/:id/domain` (project permission `{ deploy: ["configure"] }`):
    - **PUT tunnel** `{ kind: "tunnel", zoneId, label, accessPolicyId: string | null, entryPort: number }`. It resolves `remoteTunnelId` from the deploy server and refuses with 422 `domainNoTunnel` when that server has none. It stores `entryPort` (1–65535) on `environments.entry_port`, the port the environment's entry service publishes on the host. The form prefills it from the current value.
    - **PUT external** `{ kind: "external", hostname }`. Any FQDN; record only.
    - A public binding (`accessPolicyId: null`) without org `server:manage` gets 403 (Review Focus 3).
    - A hostname used by another environment gets 409.
    - Changing an already provisioned tunnel binding (`access_app_id` or `dns_record_id` set) is refused with 409 `domainProvisioned` until plan 5 adds removal.
    - Activity `environment.domain.update`.
  - Remote tunnels (org `server:manage`): `GET /api/remote-tunnels`, `POST { serverId, tunnelId, originHost }` (name taken from `listTunnels`, which must contain the id), `DELETE` (409 while bound).

- [ ] **Step 1: Failing tests:**
  - label regex accepts `hris-staging` and rejects `a.b`, `-x`, `x-`, uppercase and a 64-character label;
  - a maintainer PUTs a tunnel binding with a policy → 200, and with `accessPolicyId: null` → 403; an admin with null → 200;
  - no remote tunnel on the deploy server → 422;
  - targets on two servers → 422;
  - duplicate hostname → 409;
  - changing a provisioned binding → 409;
  - registering a tunnel id the account doesn't list → 422.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the tests and the full check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(domains): remote tunnels and environment domain bindings`

### Task 3: Provisioning steps `tunnel_route`, `access_app`, `dns_record`

**Files:**
- Create: `lib/jobs/provision-cloudflare.ts`
- Modify: `lib/provisioning/plan.ts` (`ProvisioningStepSpec` gains the three kinds; `planProvisioning` input gains `domain`), `lib/jobs/provision.ts` (dispatch), `server/services/provisioning.ts` (planning input, `showPanel` also true for a tunnel binding not yet provisioned), `web/routes/$locale/_app/-components/env/provisioning-panel.tsx` (sentences), `messages/*.json`
- Test: `tests/provisioning-plan.test.ts`, `tests/provisioning-cloudflare.test.ts`, `tests/provisioning-panel.test.tsx`

**Interfaces:**
- Consumes: the Task 1 client, the Task 2 binding, and the 3b-1 job.
- Produces:
  - Step specs:
    - `{ kind: "tunnel_route"; params: { remoteTunnelId: string; hostname: string; service: string } }`, with `service = http://<originHost>:<entryPort>`;
    - `{ kind: "access_app"; params: { hostname: string; policyId: string } }`;
    - `{ kind: "dns_record"; params: { zoneId: string; hostname: string; remoteTunnelId: string } }`.
  - Plan order: `prepare_deploy_dir`, `create_database`, `tunnel_route`, `access_app` (only when a policy is set), `dns_record`, `deploy`.
  - `planProvisioning` throws `ProvisioningPlanError("missing_entry_port")` for a tunnel binding when `entryPort` is null.
  - Execution rules:
    - **`tunnel_route`:** in one DB transaction, take the advisory lock, then GET → `withIngressRoute` → PUT only if changed. A conflict fails the step with "`<hostname>` already routes to `<service>`".
    - **`access_app`:** `findAccessAppByDomain`. When it finds a Panel-tagged app (name `opsdeck:<envId>`), reuse it. When it finds any other app, fail "Access app `<name>` already covers `<hostname>`". When it finds none, create one. Store `access_app_id` either way.
    - **`dns_record`:** `findDnsRecord`. A CNAME to `<tunnelId>.cfargotunnel.com`, proxied, with comment `opsdeck:<envId>` is reused. Any other record fails "DNS record `<type> <content>` already exists for `<hostname>`". When there is none, create it. Store `dns_record_id`.
  - Panel sentences:
    - "Add tunnel route `<hostname>` → `<service>` on `<tunnel name>`";
    - "Create Access app for `<hostname>` (`<policy name>`)";
    - "Publish DNS record `<hostname>`".

- [ ] **Step 1: Failing tests:**
  - **Plan:**
    - a tunnel binding with a policy gives `[prepare_deploy_dir, tunnel_route, access_app, dns_record, deploy]`;
    - without a policy there is no `access_app`;
    - an external binding adds no Cloudflare steps;
    - a missing entry port → `missing_entry_port`.
  - **Steps** (client mocked):
    - two `tunnel_route` executions for different hostnames, interleaved so that both GETs happen before either PUT unless serialized, must both end in the final config. Assert the lock helper is called with the same key and that the second GET sees the first PUT (Review Focus 1);
    - an existing foreign DNS record, Access app or ingress route fails with no write call (Review Focus 2);
    - a retry after `access_app` done reuses the tagged app (Review Focus 4);
    - the stored `access_app_id` and `dns_record_id` are set;
    - the token never appears in run output or step errors.
  - **Panel:** the sentences render, in this order.
- [ ] **Step 2: Run** the test files. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the tests and the full check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(provisioning): tunnel route, Access app and DNS record steps`

### Task 4: Go live (controller)

- [ ] Romi creates the token (permissions in Global Constraints) and saves it in Admin → Cloudflare. Verify shows the tunnel count, and the IdP is set to Entra.
- [ ] Take a backup, dry-run the migration (without the `ADD VALUE` lines), and apply it. Merge and push. Romi runs Jenkins `DSS/dss-panel`; health must return 200.
- [ ] Register `dss-srv-113` (`5643047e-e734-4546-95fe-e7bfa0fc2683`) to server .113 with origin host `localhost`. Back up its current config to `/root/dss-srv-113-config-backup-<date>.json` first.
- [ ] Canary PCAN/Canary:
  - set `entry_port` to the port the canary's compose publishes (read it from `/deployments/panel-canary/compose.yaml`);
  - set the domain to tunnel `panel-canary.dssconsulting.id` with policy DSS Internal;
  - press Provision.

  Expected:
  - the config holds the new rule before the catch-all, and the `panel`/`ci`/`hris` rules are unchanged (diff against the backup);
  - the Access app `opsdeck:<envId>` exists;
  - the CNAME is proxied with the comment;
  - `curl -sI https://panel-canary.dssconsulting.id` gives 302 to `dssconsulting.cloudflareaccess.com`. A 1043 can last about 10 minutes; test with `--resolve` against an edge IP.
- [ ] Report as not tested: a public (no Access) binding live, and two simultaneous provisioning runs live.

# Access control rework — design

Date: 2026-10-03
Status: approved (brainstorming), pending spec review

## Goal

Replace the single role ladder with an access model that:

- **Least privilege:** splits org-level powers so infrastructure work no longer requires full admin. Full admin includes user management.
- **Project isolation:** hides a project entirely from anyone who is not a member of it, unless their org role grants a bypass.
- **Roles that match job functions:** roles reflect real functions (developer, DevOps, QA/BA, PM, executive) instead of a rank.
- **Audit and offboarding:** makes it easy to see who can access what, and to remove a leaver's access in one step.

## Problems with the current model

- `admin` covers everything. 87 `requireAdmin()` call sites put servers, the root terminal, the file explorer, storage, tunnels, Jira, users and project CRUD behind one role, so every developer who needs a terminal is also a user administrator.
- No isolation. A global `viewer` can read every project, so membership only ever raises access and never limits it.
- The ladder does not fit. 44 of the 45 live memberships are `maintainer`, because QA needs mock time and restore. As a side effect they can also drop databases.
- Drift. 13 hand-written `isAdmin()` checks sit outside the capability map.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Model | Two layers: org role (`users.role`) + project role (`project_members.role`) |
| Role definitions | In code, typed and reviewed in PRs. Admins only assign roles |
| Permission primitive | better-auth `createAccessControl` statements (`resource: [actions]`) |
| Non-members | Project is invisible (404), not read-only |
| QA/BA (`contributor`) ops | Mock time, DB backup, DB restore, Mailpit. No service control, no create/drop/rename DB |
| Rejected | better-auth `organization` plugin (multi-tenant model, needs new tables, DSS is one org); external authz engine such as OpenFGA, SpiceDB or Cerbos (an extra service to run and keep in sync); Postgres RLS (single shared DB connection, would need a per-request `SET ROLE`/GUC) |

## Roles

### Org roles (`users.role`, exactly one per user)

| Role | Intended for | Grants |
|---|---|---|
| `admin` | Platform owners (keep ≥ 2) | Everything, including user management, integrations, project create/delete, all projects |
| `infra` | DevOps | Servers (detail, terminal, files), storage, tunnels, and maintainer-level access to **all** projects. No user management |
| `observer` | Executives, auditors | Read-only on all projects, knowledge base, audit log |
| `member` | Everyone else. Default for self-provisioned (Microsoft) users | Knowledge base, plus only the projects they are a member of |

The old org roles `viewer` and `maintainer` are removed.

### Project roles (`project_members.role`)

| Role | Grants |
|---|---|
| `viewer` | See the project, its environments, dashboards, runs, service status and logs |
| `contributor` | viewer + write issues/comments/labels/milestones/test runs/attachments, Mailpit, mock time, DB backup and restore |
| `maintainer` | contributor + delete issues, create/drop/rename DB, start/stop services, create/update/delete environments and their settings (Mailpit, Jira link), manage project members |

The old project role `admin` is removed, because maintainer covers project management.

### Effective project role

```
effective = max(membershipRole, implicitRole(orgRole))
implicitRole: admin → maintainer, infra → maintainer, observer → viewer, member → none
```

If the result is none, the project does not exist for that user. Org roles never *lower* a membership.

## Permission statements

All statements are defined once in `lib/permissions.ts` with `createAccessControl` from `better-auth/plugins/access`. That module is client-safe and pure. There are two access-control instances, one per scope, so a project permission can never be checked against an org role by mistake.

### Org scope (checked against `users.role`)

| Statement | admin | infra | observer | member |
|---|---|---|---|---|
| `user: list` | ✓ | – | ✓ | – |
| `user: invite, set-role, offboard` | ✓ | – | – | – |
| `project: create, delete` | ✓ | – | – | – |
| `server: read` | ✓ | ✓ | ✓ | – |
| `server: manage, terminal, files` | ✓ | ✓ | – | – |
| `storage: read` (incl. S3 connections) | ✓ | ✓ | ✓ | – |
| `storage: manage, files` | ✓ | ✓ | – | – |
| `tunnel: read` (incl. Cloudflare zones) | ✓ | ✓ | ✓ | – |
| `tunnel: manage` | ✓ | ✓ | – | – |
| `integration: manage` (Jira connections) | ✓ | – | – | – |
| `knowledge: read` | ✓ | ✓ | ✓ | ✓ |
| `knowledge: write` | ✓ | ✓ | – | ✓ |
| `audit: read` (activity log, access matrix) | ✓ | ✓ | ✓ | – |

### Project scope (checked against the effective project role)

| Statement | viewer | contributor | maintainer |
|---|---|---|---|
| `project: read` | ✓ | ✓ | ✓ |
| `service: logs` | ✓ | ✓ | ✓ |
| `issue: write` | – | ✓ | ✓ |
| `issue: delete` (incl. bulk) | – | – | ✓ |
| `mail: read, delete` | – | ✓ | ✓ |
| `clock: control` | – | ✓ | ✓ |
| `database: backup, restore` | – | ✓ | ✓ |
| `database: create, drop, rename` | – | – | ✓ |
| `service: control` | – | – | ✓ |
| `environment: create, update, delete` | – | – | ✓ |
| `member: manage` | – | – | ✓ |

The following stay open to any signed-in user, because they act only on the caller's own data: their own notifications, their own saved views, and their own account and passkeys.

## Enforcement API (`lib/authz.ts`)

`lib/authz.ts` replaces the authorization half of `lib/auth-session.ts` and the capability half of `lib/roles.ts`. `getServerSession`/`requireSession` stay where they are.

```ts
requireOrgPermission(perms)                      // → session; else notFound()
requireProjectPermission(scope, perms)           // scope: { projectId } | { environmentId }
                                                 // → { session, role }; else notFound()
getProjectRole(scope)                            // → ProjectRole | null, for gating UI
accessibleProjectIds()                           // → "all" | string[], memoized per request
projectScope(column)                             // → drizzle SQL predicate from accessibleProjectIds()
canOrg(role, perms) / canProject(role, perms)    // pure, client-safe, for hiding buttons
```

Rules:

- **Invisible project, or a project page/route the user lacks permission for:** call `notFound()`. Pages, route handlers and SSE streams behave the same way, so the response never reveals that a project exists.
- **Server action without permission:** throw `ForbiddenError` (a typed error). The client turns it into a toast. Server actions never redirect on denial.
- **Cross-project queries must apply `projectScope`.** These are: project and environment lists, global issue list, issue counts, assigned-to-me, notifications, activity log and search. A grep-based test fails CI if one of these actions queries `issues`/`environments`/`projects` without it.
- **Assignee pickers** list only users who have access to the project (`listAssignableUsers(projectId)`).
- **Terminal and explorer:** the WebSocket ticket requires `server: terminal`, and the explorer actions and routes require `server: files`. The check runs both when the ticket is issued and when it is redeemed.
- **Jira webhook:** unchanged, authenticated by its token.
- **Removed:** `requireAdmin`, `isAdmin`, `requireCapability`, `getEffectiveRole`, `CAPABILITIES`, `ROLE_RANK`. A test fails if any of them reappears.

### better-auth wiring

```ts
admin({
  ac: orgAc,
  roles: { admin, infra, observer, member },
  adminRoles: ["admin"],
  defaultRole: "member",
})
```

`defaultRole: "member"` is safe with isolation, because a fresh SSO user sees the knowledge base and zero projects. better-auth's own admin endpoints (`setRole`, `banUser`, `listUsers`, …) then follow the same statements.

## Data model

- `users.role` (text, owned by better-auth): values become `admin | infra | observer | member`.
- `project_role` enum: recreated as `viewer | contributor | maintainer`.
- `invitations.role`: the org role to assign on acceptance (same four values).
- No new tables. Audit uses the existing `activity_log`.

## Migration

`drizzle/20261003000000_access_control/migration.sql`, hand-authored, in one transaction, applied over SSH before the app deploy. Take a backup first, following the usual procedure.

1. Map org roles: `admin → admin`; `maintainer`, `member`, `viewer`, and anything unknown → `member`. Do the same for pending `invitations.role`.
2. Recreate the enum: create `project_role_v2`, alter `project_members.role` with `USING CASE` (`admin`/`maintainer → maintainer`, `member → contributor`, `viewer → viewer`), drop the old type, then rename the new one.
3. Change the default of `users.role` and `invitations.role` to `member`.

Per-person assignments (who becomes `infra`/`observer`, which memberships drop to `contributor`, who gets offboarded) are a separate rollout step. That step is a reviewed SQL script that runs after the migration and is **not committed**, because it contains staff names. Write it from the current roster and show it to the owner before running it.

Deploy order: back up → migrate → deploy the app → run the per-person script. During the gap between migrate and deploy, the old app sees roles it does not know. It floors them to viewer (safe-deny), so access goes down, never up. Keep the gap short.

## Audit and offboarding

- **`/admin/access`** (`audit: read`, editable with `user: set-role` / `member: manage`): a user × project matrix that shows the org role, each project role and the last session. It can filter to users inactive for more than 60 days and to banned users.
- **Offboard action** (`user: offboard`): in one transaction, ban the user, delete all `project_members` rows and revoke pending invitations to their email. Banning also revokes the user's sessions, through better-auth `banUser`. Then write `activity_log` with `action = "user.offboarded"`.
- **Every change to an org role, membership add/remove/change and invitation** writes an `activity_log` row with actor, target and before → after role (`entityType: "access"`).

## Testing

- **Unit (`tests/permissions.test.ts`):** a full matrix of role × statement for both scopes, asserted against the tables above. Also covers `effectiveProjectRole` for every combination of org and membership role.
- **Integration (`tests/authz.test.ts`):**
  - A `member` with no memberships gets `[]` from `accessibleProjectIds`, and `projectScope` filters every list to empty.
  - An `observer` can read, but `requireProjectPermission(..., { issue: ["write"] })` throws.
  - `infra` gets `"all"` with maintainer, but `user: invite` is denied.
- **Regression (grep test):** none of the removed helpers remain, and no cross-project action skips `projectScope`.
- **Manual:** sign in as each org role on staging and check navigation, project list, 404 on a foreign project URL, terminal access and offboarding.

## Out of scope

- Roles that can be edited in the UI.
- Per-environment roles (roles stay per project).
- Multi-organization or multi-tenant support.
- Time-boxed or just-in-time access grants.
- Access requests ("request to join project").
- SCIM or Entra group → role sync.

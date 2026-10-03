# Access Control Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single viewer→admin ladder with two layers of roles. Org roles (`admin | infra | observer | member`) and project roles (`viewer | contributor | maintainer`) are checked through typed better-auth access-control statements. Projects are isolated per membership, and there is an access matrix and a one-step offboarding action.

**Architecture:**
- `lib/permissions.ts` is the single source of truth. It is pure and client-safe, and holds two `createAccessControl` instances (org and project), the roles, and the rule for the effective project role.
- `lib/authz.ts` is the server-only boundary. It resolves the caller's org role and their per-project roles once per request (`react` `cache`). It exposes `require*` guards that call `notFound()` on pages and throw `ForbiddenError` from actions, and query filters that every cross-project list must apply.
- The old `lib/roles.ts` capability ladder and the authorization helpers in `lib/auth-session.ts` are deleted at the end.

**Tech Stack:** Next.js 16.3 (App Router, server actions), better-auth 1.6 (`admin` plugin + `better-auth/plugins/access`), drizzle-orm 1.0.0-rc.4 (SQL builder + RQB v2), Postgres 18, Bun test, next-intl (5 locales: ar/en/es/id/zh).

**Spec:** `docs/superpowers/specs/2026-10-03-access-control-design.md`

## Global Constraints

- **Org roles:** exactly `admin`, `infra`, `observer`, `member`. Default for new users is `member`. `adminRoles: ["admin"]`.
- **Project roles:** exactly `viewer`, `contributor`, `maintainer`, stored in the `project_role` Postgres enum.
- **Effective project role:** `max(membershipRole, implicit(orgRole))`, where implicit is `admin`/`infra` → maintainer, `observer` → viewer, `member` → none. None means the project is invisible (404).
- **Unknown or legacy role strings are safe-deny.** An unknown org role is treated as `member`, which only sees projects it holds memberships in. An unknown project role is treated as no membership. This is never an error, and never more access.
- **Permissions must match the spec matrices exactly.** Additions decided while planning are amended into the spec in Task 1:
  - `knowledge: manage` (admin only): see others' drafts, create/update/delete/move collections, delete documents, drag in the tree.
  - The terminal is checked when its ticket is minted only, because the ticket TTL is 30 s.
- **Denial behaviour:**
  - Pages and layouts call `notFound()`.
  - Route handlers return 404 when the project is invisible, and 403 when the org/project permission is missing on something visible.
  - Server actions throw `ForbiddenError` from `requireOrgPermission`/`requireProjectPermission`.
- **i18n:** every new UI string goes into all 5 files `messages/{ar,en,es,id,zh}.json`.
- **No new runtime dependencies.**
- **Commit messages** use Conventional Commits and carry **no** `Co-Authored-By: Claude` trailer (project rule).
- **Migrations** are hand-authored in `drizzle/<timestamp>_<name>/migration.sql`, with their own `BEGIN`/`COMMIT`, applied manually over SSH. `drizzle-kit migrate` is not used.
- **Commands:** `bun test`, `bun run typecheck`, `bun run lint`.

## Review Focus

1. **A member with zero memberships** (every fresh Microsoft sign-in) must see an empty project list, an empty issue list, zero counts and runs, and a 404 on any project URL. No page should crash on the empty list. Pinned in Task 3 (`resolveProjectAccess` and `projectIdsWhere` with no projects) and Task 4 (grep guard).
2. **Bulk actions spanning several projects** (`bulkDeleteIssues`, `bulkSetStatus`) where the caller is a maintainer on only one of those projects. The whole call must be refused, not partially applied. Pinned in Task 3 (`requireProjectPermissionForAll` test) and used in Task 5.
3. **A stale role value in the DB during the migrate→deploy gap, or a hand-edited row** (`"Admin"`, `"maintainer"` as an org role, `"admin"` as a project role). These must never grant more than `member` or no membership. Pinned in Task 1 (`JUNK_ROLES` tests).
4. **An admin demoting or offboarding themselves, or removing the last admin.** That must be refused, or nobody can manage users. Pinned in Task 9 (`assertNotLastAdmin` test).
5. **A maintainer editing members of a project they maintain.** They must not be able to grant a role above `maintainer`, or touch a different project's members by passing another `projectId`. Pinned in Task 5 (`project-members` guard uses the `projectId` from input for both the check and the write; `normalizeProjectRole` rejects `admin`).

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/permissions.ts` (new) | Statements, roles, `OrgRole`/`ProjectRole`, normalizers, `effectiveProjectRole`, `canOrg`, `canProject`. Pure, client-safe |
| `lib/authz.ts` (new) | Server-only. `ForbiddenError`, `getOrgRole`, `getProjectAccess`, `resolveProjectAccess` (pure), `projectScope`, `projectIdsWhere`, `getProjectRole`, `requireOrgPermission`, `requireProjectPermission`, `requireProjectPermissionForAll`, `routeProjectGuard` |
| `lib/auth.ts` | Wire the admin plugin to `orgAc` + org roles |
| `lib/auth-session.ts` | Keep `getServerSession`/`requireSession`; delete everything else (Task 8) |
| `lib/roles.ts`, `tests/roles.test.ts` | Deleted (Task 8) |
| `components/project-role.tsx` (new) | `ProjectRoleProvider` + `useProjectCan()`, replacing `components/ops-capability.tsx` |
| `actions/access.ts` (new) | Access matrix query, `offboardUser`, `setOrgRole` |
| `lib/access.ts` (new) | Pure helpers for the access page (`assertNotLastAdmin`, `isInactive`) |
| `app/[locale]/admin/access/page.tsx`, `access-client.tsx` (new) | Matrix UI |
| `drizzle/20261003000000_access_control/migration.sql` (new) | Role data + enum migration |
| `tests/permissions.test.ts`, `tests/authz.test.ts`, `tests/access.test.ts`, `tests/authz-guards.test.ts` (new) | Matrix, resolution, access helpers, grep regression |

---

### Task 1: Permission model (`lib/permissions.ts`)

**Files:**
- Create: `lib/permissions.ts`
- Create: `tests/permissions.test.ts`
- Modify: `docs/superpowers/specs/2026-10-03-access-control-design.md` (record `knowledge: manage` and the terminal mint-only check)

**Interfaces:**
- Produces:
  - `ORG_ROLES: readonly ["admin","infra","observer","member"]`; `type OrgRole`
  - `PROJECT_ROLES: readonly ["viewer","contributor","maintainer"]`; `type ProjectRole`
  - `orgAc`, `orgRoles: Record<OrgRole, Role>`; `projectAc`, `projectRoles: Record<ProjectRole, Role>`
  - `type OrgPermissions`, `type ProjectPermissions` (the request shapes, e.g. `{ server: ["terminal"] }`)
  - `normalizeOrgRole(role: string | null | undefined): OrgRole`
  - `normalizeProjectRole(role: string | null | undefined): ProjectRole | null`
  - `implicitProjectRole(org: OrgRole): ProjectRole | null`
  - `effectiveProjectRole(orgRole: string | null | undefined, membershipRole: string | null | undefined): ProjectRole | null`
  - `canOrg(role: string | null | undefined, perms: OrgPermissions): boolean`
  - `canProject(role: ProjectRole | null, perms: ProjectPermissions): boolean`
  - `isOrgRole(v: string): v is OrgRole`, `isProjectRole(v: string): v is ProjectRole`

- [ ] **Step 1: Write the failing test**

Create `tests/permissions.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  canOrg,
  canProject,
  effectiveProjectRole,
  implicitProjectRole,
  normalizeOrgRole,
  normalizeProjectRole,
  ORG_ROLES,
  type OrgRole,
  PROJECT_ROLES,
  type ProjectRole,
} from "@/lib/permissions";

// Values that can reach the helpers from a legacy row, a hand-edited DB or a
// forged payload. None may ever grant more than the floor.
const JUNK_ROLES = [
  null,
  undefined,
  "",
  "owner",
  "superadmin",
  "Admin",
  "ADMIN",
  "admin ",
  "root",
  "__proto__",
  "constructor",
  "toString",
  "viewer", // old org role
  "maintainer", // old org role
];

describe("normalizeOrgRole", () => {
  it("keeps every real org role", () => {
    for (const r of ORG_ROLES) expect(normalizeOrgRole(r)).toBe(r);
  });
  it("floors junk and legacy values to member", () => {
    for (const r of JUNK_ROLES) expect(normalizeOrgRole(r)).toBe("member");
  });
});

describe("normalizeProjectRole", () => {
  it("keeps every real project role", () => {
    for (const r of PROJECT_ROLES) expect(normalizeProjectRole(r)).toBe(r);
  });
  it("treats junk and the removed `admin`/`member` values as no membership", () => {
    for (const r of [...JUNK_ROLES, "admin", "member"]) {
      if (r === "viewer" || r === "maintainer") continue;
      expect(normalizeProjectRole(r)).toBeNull();
    }
  });
});

describe("implicitProjectRole", () => {
  it("maps org roles to their implicit project role", () => {
    expect(implicitProjectRole("admin")).toBe("maintainer");
    expect(implicitProjectRole("infra")).toBe("maintainer");
    expect(implicitProjectRole("observer")).toBe("viewer");
    expect(implicitProjectRole("member")).toBeNull();
  });
});

describe("effectiveProjectRole", () => {
  const cases: [OrgRole, ProjectRole | null, ProjectRole | null][] = [
    ["member", null, null],
    ["member", "viewer", "viewer"],
    ["member", "contributor", "contributor"],
    ["member", "maintainer", "maintainer"],
    ["observer", null, "viewer"],
    ["observer", "contributor", "contributor"],
    ["infra", null, "maintainer"],
    ["infra", "viewer", "maintainer"],
    ["admin", null, "maintainer"],
    ["admin", "contributor", "maintainer"],
  ];
  for (const [org, membership, expected] of cases) {
    it(`${org} + ${membership ?? "none"} → ${expected ?? "none"}`, () => {
      expect(effectiveProjectRole(org, membership)).toBe(expected);
    });
  }
  it("never lets a junk org role see a project without membership", () => {
    for (const r of JUNK_ROLES) expect(effectiveProjectRole(r, null)).toBeNull();
  });
});

// The spec's org matrix, verbatim. One row per statement, one column per role.
const ORG_MATRIX: [string, string, Record<OrgRole, boolean>][] = [
  ["user", "list", { admin: true, infra: false, observer: true, member: false }],
  ["user", "invite", { admin: true, infra: false, observer: false, member: false }],
  ["user", "set-role", { admin: true, infra: false, observer: false, member: false }],
  ["user", "offboard", { admin: true, infra: false, observer: false, member: false }],
  ["project", "create", { admin: true, infra: false, observer: false, member: false }],
  ["project", "delete", { admin: true, infra: false, observer: false, member: false }],
  ["server", "read", { admin: true, infra: true, observer: true, member: false }],
  ["server", "manage", { admin: true, infra: true, observer: false, member: false }],
  ["server", "terminal", { admin: true, infra: true, observer: false, member: false }],
  ["server", "files", { admin: true, infra: true, observer: false, member: false }],
  ["storage", "read", { admin: true, infra: true, observer: true, member: false }],
  ["storage", "manage", { admin: true, infra: true, observer: false, member: false }],
  ["storage", "files", { admin: true, infra: true, observer: false, member: false }],
  ["tunnel", "read", { admin: true, infra: true, observer: true, member: false }],
  ["tunnel", "manage", { admin: true, infra: true, observer: false, member: false }],
  ["integration", "manage", { admin: true, infra: false, observer: false, member: false }],
  ["knowledge", "read", { admin: true, infra: true, observer: true, member: true }],
  ["knowledge", "write", { admin: true, infra: true, observer: false, member: true }],
  ["knowledge", "manage", { admin: true, infra: false, observer: false, member: false }],
  ["audit", "read", { admin: true, infra: true, observer: true, member: false }],
];

describe("canOrg matrix", () => {
  for (const [resource, action, expected] of ORG_MATRIX) {
    for (const role of ORG_ROLES) {
      it(`${role} ${expected[role] ? "can" : "cannot"} ${resource}:${action}`, () => {
        expect(canOrg(role, { [resource]: [action] } as never)).toBe(expected[role]);
      });
    }
  }
  it("denies every statement to junk roles except what member has", () => {
    for (const r of JUNK_ROLES) {
      expect(canOrg(r, { user: ["invite"] })).toBe(false);
      expect(canOrg(r, { server: ["terminal"] })).toBe(false);
      expect(canOrg(r, { knowledge: ["read"] })).toBe(true);
    }
  });
});

const PROJECT_MATRIX: [string, string, Record<ProjectRole, boolean>][] = [
  ["project", "read", { viewer: true, contributor: true, maintainer: true }],
  ["service", "logs", { viewer: true, contributor: true, maintainer: true }],
  ["issue", "write", { viewer: false, contributor: true, maintainer: true }],
  ["issue", "delete", { viewer: false, contributor: false, maintainer: true }],
  ["mail", "read", { viewer: false, contributor: true, maintainer: true }],
  ["mail", "delete", { viewer: false, contributor: true, maintainer: true }],
  ["clock", "control", { viewer: false, contributor: true, maintainer: true }],
  ["database", "backup", { viewer: false, contributor: true, maintainer: true }],
  ["database", "restore", { viewer: false, contributor: true, maintainer: true }],
  ["database", "create", { viewer: false, contributor: false, maintainer: true }],
  ["database", "drop", { viewer: false, contributor: false, maintainer: true }],
  ["database", "rename", { viewer: false, contributor: false, maintainer: true }],
  ["service", "control", { viewer: false, contributor: false, maintainer: true }],
  ["environment", "create", { viewer: false, contributor: false, maintainer: true }],
  ["environment", "update", { viewer: false, contributor: false, maintainer: true }],
  ["environment", "delete", { viewer: false, contributor: false, maintainer: true }],
  ["member", "manage", { viewer: false, contributor: false, maintainer: true }],
];

describe("canProject matrix", () => {
  for (const [resource, action, expected] of PROJECT_MATRIX) {
    for (const role of PROJECT_ROLES) {
      it(`${role} ${expected[role] ? "can" : "cannot"} ${resource}:${action}`, () => {
        expect(canProject(role, { [resource]: [action] } as never)).toBe(expected[role]);
      });
    }
  }
  it("denies everything to no role", () => {
    expect(canProject(null, { project: ["read"] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/permissions.test.ts`
Expected: FAIL with `Cannot find module '@/lib/permissions'`.

- [ ] **Step 3: Implement `lib/permissions.ts`**

```ts
// The access model in one place: what each org role and each project role may
// do, as better-auth access-control statements. Pure and client-safe, so the
// server guards (lib/authz) and the button-hiding UI read the same table.
// Roles are defined in code on purpose; admins only assign them.
// See docs/superpowers/specs/2026-10-03-access-control-design.md.

import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";

export const ORG_ROLES = ["admin", "infra", "observer", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PROJECT_ROLES = ["viewer", "contributor", "maintainer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

// Org-scoped statements. `user`/`session` extend better-auth's admin-plugin
// defaults so its own endpoints (setRole, banUser, …) resolve against the
// same roles.
const orgStatements = {
  ...defaultStatements,
  user: [...defaultStatements.user, "invite", "offboard"],
  project: ["create", "delete"],
  server: ["read", "manage", "terminal", "files"],
  storage: ["read", "manage", "files"],
  tunnel: ["read", "manage"],
  integration: ["manage"],
  knowledge: ["read", "write", "manage"],
  audit: ["read"],
} as const;

export const orgAc = createAccessControl(orgStatements);

const infraOps = {
  server: ["read", "manage", "terminal", "files"],
  storage: ["read", "manage", "files"],
  tunnel: ["read", "manage"],
} as const;

export const orgRoles = {
  admin: orgAc.newRole({
    user: [...defaultStatements.user, "invite", "offboard"],
    session: [...defaultStatements.session],
    project: ["create", "delete"],
    ...infraOps,
    integration: ["manage"],
    knowledge: ["read", "write", "manage"],
    audit: ["read"],
  }),
  infra: orgAc.newRole({
    ...infraOps,
    knowledge: ["read", "write"],
    audit: ["read"],
  }),
  observer: orgAc.newRole({
    user: ["list"],
    server: ["read"],
    storage: ["read"],
    tunnel: ["read"],
    knowledge: ["read"],
    audit: ["read"],
  }),
  member: orgAc.newRole({
    knowledge: ["read", "write"],
  }),
} satisfies Record<OrgRole, unknown>;

// Project-scoped statements, checked against the effective project role.
const projectStatements = {
  project: ["read"],
  issue: ["write", "delete"],
  mail: ["read", "delete"],
  clock: ["control"],
  database: ["backup", "restore", "create", "drop", "rename"],
  service: ["logs", "control"],
  environment: ["create", "update", "delete"],
  member: ["manage"],
} as const;

export const projectAc = createAccessControl(projectStatements);

const viewerStatements = {
  project: ["read"],
  service: ["logs"],
} as const;

const contributorStatements = {
  ...viewerStatements,
  issue: ["write"],
  mail: ["read", "delete"],
  clock: ["control"],
  database: ["backup", "restore"],
} as const;

export const projectRoles = {
  viewer: projectAc.newRole(viewerStatements),
  contributor: projectAc.newRole(contributorStatements),
  maintainer: projectAc.newRole({
    project: ["read"],
    issue: ["write", "delete"],
    mail: ["read", "delete"],
    clock: ["control"],
    database: ["backup", "restore", "create", "drop", "rename"],
    service: ["logs", "control"],
    environment: ["create", "update", "delete"],
    member: ["manage"],
  }),
} satisfies Record<ProjectRole, unknown>;

type Request<S extends Record<string, readonly string[]>> = {
  [K in keyof S]?: readonly S[K][number][];
};
export type OrgPermissions = Request<typeof orgStatements>;
export type ProjectPermissions = Request<typeof projectStatements>;

// `includes` on a readonly tuple, not `in` on an object: a role string such as
// "toString" must not match an inherited Object.prototype key.
export function isOrgRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value);
}

export function isProjectRole(value: string): value is ProjectRole {
  return (PROJECT_ROLES as readonly string[]).includes(value);
}

// Unknown org roles — legacy `viewer`/`maintainer`, typos, forged values —
// floor to `member`, which sees only projects it holds memberships in.
export function normalizeOrgRole(role: string | null | undefined): OrgRole {
  return role && isOrgRole(role) ? role : "member";
}

// Unknown project roles count as no membership at all.
export function normalizeProjectRole(
  role: string | null | undefined
): ProjectRole | null {
  return role && isProjectRole(role) ? role : null;
}

const PROJECT_RANK: Record<ProjectRole, number> = {
  viewer: 0,
  contributor: 1,
  maintainer: 2,
};

export function implicitProjectRole(org: OrgRole): ProjectRole | null {
  if (org === "admin" || org === "infra") return "maintainer";
  if (org === "observer") return "viewer";
  return null;
}

// The role that applies to one user on one project: their membership, raised
// (never lowered) by the role their org role implies. Null = no access, and the
// project must look like it does not exist.
export function effectiveProjectRole(
  orgRole: string | null | undefined,
  membershipRole: string | null | undefined
): ProjectRole | null {
  const implicit = implicitProjectRole(normalizeOrgRole(orgRole));
  const membership = normalizeProjectRole(membershipRole);
  if (!implicit) return membership;
  if (!membership) return implicit;
  return PROJECT_RANK[membership] >= PROJECT_RANK[implicit]
    ? membership
    : implicit;
}

export function canOrg(
  role: string | null | undefined,
  perms: OrgPermissions
): boolean {
  return orgRoles[normalizeOrgRole(role)].authorize(perms as never).success;
}

export function canProject(
  role: ProjectRole | null,
  perms: ProjectPermissions
): boolean {
  if (!role) return false;
  return projectRoles[role].authorize(perms as never).success;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/permissions.test.ts`
Expected: PASS, all matrix cases.

Run: `bun run typecheck`
Expected: no new errors.

- [ ] **Step 5: Amend the spec**

In `docs/superpowers/specs/2026-10-03-access-control-design.md`, make three edits.

First, add this row to the org-scope table, right after `knowledge: write`:

```
| `knowledge: manage` (others' drafts, collections, delete docs) | ✓ | – | – | – |
```

Second, in "Enforcement API" → Rules, replace the terminal bullet with:

```
- Terminal and explorer: the WebSocket ticket route requires `server: terminal`
  when minting (tickets live 30 s, so no redeem-time check); explorer actions
  and routes require `server: files`.
```

Third, in Testing, replace the "Integration" bullet with:

```
- Resolution (`tests/authz.test.ts`): the pure `resolveProjectAccess` — member
  with no memberships → no projects; observer → all as viewer; infra → all as
  maintainer; bulk checks refuse a mixed-project set. (The repo has no DB-backed
  test harness, so the DB lookups stay thin wrappers around these pure helpers.)
```

- [ ] **Step 6: Commit**

```bash
git add lib/permissions.ts tests/permissions.test.ts docs/superpowers/specs/2026-10-03-access-control-design.md
git commit -m "feat(authz): define org and project permission statements"
```

---

### Task 2: Database migration

**Files:**
- Create: `drizzle/20261003000000_access_control/migration.sql`

**Interfaces:**
- Produces: DB state where `users.role ∈ {admin,infra,observer,member}`, `invitations.role` likewise, and `project_members.role` of enum `project_role` with values `viewer|contributor|maintainer`.

- [ ] **Step 1: Write the migration**

```sql
-- Access control rework (docs/superpowers/specs/2026-10-03-access-control-design.md).
-- Org roles: admin | infra | observer | member. Project roles: viewer |
-- contributor | maintainer. Per-person assignments (infra/observer, demoting
-- memberships to contributor, offboarding) are a separate, uncommitted rollout
-- script — this file only maps old values to their safe new equivalents.
BEGIN;

UPDATE users
   SET role = CASE WHEN role = 'admin' THEN 'admin' ELSE 'member' END
 WHERE role IS DISTINCT FROM CASE WHEN role = 'admin' THEN 'admin' ELSE 'member' END;

UPDATE invitations
   SET role = CASE WHEN role = 'admin' THEN 'admin' ELSE 'member' END
 WHERE role IS DISTINCT FROM CASE WHEN role = 'admin' THEN 'admin' ELSE 'member' END;

ALTER TABLE users ALTER COLUMN role SET DEFAULT 'member';
ALTER TABLE invitations ALTER COLUMN role SET DEFAULT 'member';

CREATE TYPE project_role_v2 AS ENUM ('viewer', 'contributor', 'maintainer');

ALTER TABLE project_members
  ALTER COLUMN role TYPE project_role_v2
  USING (CASE role::text
           WHEN 'admin' THEN 'maintainer'
           WHEN 'maintainer' THEN 'maintainer'
           WHEN 'member' THEN 'contributor'
           ELSE 'viewer'
         END)::project_role_v2;

DROP TYPE project_role;
ALTER TYPE project_role_v2 RENAME TO project_role;

COMMIT;
```

- [ ] **Step 2: Dry-run it against a throwaway copy of prod data**

Work on a scratch DB inside the prod container, so the real DB is untouched (VPN required):

```bash
ssh root@192.168.56.113 'docker exec opsdeck-postgres sh -c "dropdb -U postgres --if-exists dss_panel_acl_dryrun && createdb -U postgres -T dss_panel dss_panel_acl_dryrun"'
ssh root@192.168.56.113 'docker exec -i opsdeck-postgres psql -U postgres -d dss_panel_acl_dryrun -v ON_ERROR_STOP=1' < drizzle/20261003000000_access_control/migration.sql
ssh root@192.168.56.113 'docker exec -i opsdeck-postgres psql -U postgres -d dss_panel_acl_dryrun -c "select role, count(*) from users group by 1" -c "select role, count(*) from project_members group by 1"'
ssh root@192.168.56.113 'docker exec opsdeck-postgres dropdb -U postgres dss_panel_acl_dryrun'
```

Expected:
- users: `admin` 5, `member` 8.
- project_members: `maintainer` 45 (the one old `admin` membership folds into maintainer).

`createdb -T` fails if anyone is connected to `dss_panel`. If it does, use `pg_dump dss_panel | psql dss_panel_acl_dryrun` instead.

- [ ] **Step 3: Commit**

```bash
git add drizzle/20261003000000_access_control/migration.sql
git commit -m "feat(db): migrate roles to org/project access model"
```

---

### Task 3: Authorization boundary (`lib/authz.ts`) and better-auth wiring

**Files:**
- Create: `lib/authz.ts`
- Create: `tests/authz.test.ts`
- Modify: `lib/auth.ts` (admin plugin options, role imports)
- Modify: `lib/db/schema.ts:333-338` (`projectRoleEnum` values), `:635` and `:758` (defaults stay `"member"`, now explicit)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces (server-only):
  - `class ForbiddenError extends Error`
  - `type ProjectAccess = { all: boolean; roles: Record<string, ProjectRole> }`
  - `resolveProjectAccess(orgRole: string | null | undefined, allProjectIds: string[], memberships: { projectId: string; role: string }[]): ProjectAccess` (pure)
  - `getOrgRole(): Promise<OrgRole>`
  - `getProjectAccess(): Promise<ProjectAccess>` (memoized per request)
  - `accessibleProjectIds(): Promise<"all" | string[]>`
  - `projectScope(column: AnyColumn): Promise<SQL | undefined>` (SQL-builder filter)
  - `projectIdsWhere(): Promise<{ in: string[] } | undefined>` (RQB v2 filter value)
  - `getProjectRole(scope: ProjectScope): Promise<ProjectRole | null>`
  - `type ProjectScope = { projectId: string } | { environmentId: string } | { issueId: string }`
  - `requireOrgPermission(perms: OrgPermissions): Promise<Session>` (throws `ForbiddenError`)
  - `requireOrgPage(perms: OrgPermissions): Promise<Session>` (calls `notFound()`)
  - `requireProjectPermission(scope: ProjectScope, perms: ProjectPermissions): Promise<{ session: Session; role: ProjectRole; projectId: string }>` (throws `ForbiddenError`)
  - `requireProjectPage(scope: ProjectScope, perms?: ProjectPermissions): Promise<{ session: Session; role: ProjectRole; projectId: string }>` (calls `notFound()`)
  - `requireProjectPermissionForAll(projectIds: string[], perms: ProjectPermissions): Promise<Session>` (throws if any project fails)
  - `checkProjectAccess(access: ProjectAccess, projectIds: string[], perms: ProjectPermissions): boolean` (pure, used by the line above)
  - `routeProjectGuard(scope: ProjectScope, perms: ProjectPermissions): Promise<{ ok: true; session: Session; role: ProjectRole } | { ok: false; response: Response }>`
  - `routeOrgGuard(perms: OrgPermissions): Promise<{ ok: true; session: Session } | { ok: false; response: Response }>`

- [ ] **Step 1: Write the failing test**

Create `tests/authz.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { checkProjectAccess, resolveProjectAccess } from "@/lib/authz";

const ALL = ["p1", "p2", "p3"];

describe("resolveProjectAccess", () => {
  it("gives a member with no memberships nothing", () => {
    expect(resolveProjectAccess("member", ALL, [])).toEqual({ all: false, roles: {} });
  });

  it("gives a member exactly their memberships", () => {
    expect(
      resolveProjectAccess("member", ALL, [
        { projectId: "p1", role: "contributor" },
        { projectId: "p3", role: "viewer" },
      ])
    ).toEqual({ all: false, roles: { p1: "contributor", p3: "viewer" } });
  });

  it("drops memberships carrying an unknown role", () => {
    expect(
      resolveProjectAccess("member", ALL, [{ projectId: "p1", role: "admin" }])
    ).toEqual({ all: false, roles: {} });
  });

  it("gives observer every project as viewer, raised by membership", () => {
    expect(
      resolveProjectAccess("observer", ALL, [{ projectId: "p2", role: "maintainer" }])
    ).toEqual({ all: true, roles: { p1: "viewer", p2: "maintainer", p3: "viewer" } });
  });

  it("gives infra and admin every project as maintainer", () => {
    for (const org of ["infra", "admin"]) {
      expect(resolveProjectAccess(org, ALL, [])).toEqual({
        all: true,
        roles: { p1: "maintainer", p2: "maintainer", p3: "maintainer" },
      });
    }
  });

  it("treats a legacy/unknown org role as member", () => {
    expect(resolveProjectAccess("maintainer", ALL, [])).toEqual({ all: false, roles: {} });
  });
});

describe("checkProjectAccess", () => {
  const access = resolveProjectAccess("member", ALL, [
    { projectId: "p1", role: "maintainer" },
    { projectId: "p2", role: "contributor" },
  ]);

  it("passes when every project grants the permission", () => {
    expect(checkProjectAccess(access, ["p1", "p2"], { issue: ["write"] })).toBe(true);
  });

  it("refuses the whole set when one project lacks it", () => {
    expect(checkProjectAccess(access, ["p1", "p2"], { issue: ["delete"] })).toBe(false);
  });

  it("refuses a set containing an invisible project", () => {
    expect(checkProjectAccess(access, ["p1", "p3"], { issue: ["write"] })).toBe(false);
  });

  it("passes an empty set (nothing to authorize)", () => {
    expect(checkProjectAccess(access, [], { issue: ["delete"] })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/authz.test.ts`
Expected: FAIL with `Cannot find module '@/lib/authz'`.

- [ ] **Step 3: Implement `lib/authz.ts`**

```ts
import "server-only";

import { type AnyColumn, eq, inArray, type SQL, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getServerSession, requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { environments, issues, projectMembers, projects } from "@/lib/db/schema";
import {
  canOrg,
  canProject,
  effectiveProjectRole,
  normalizeOrgRole,
  type OrgPermissions,
  type OrgRole,
  type ProjectPermissions,
  type ProjectRole,
} from "@/lib/permissions";

// The server-side authorization boundary. lib/permissions says what each role
// may do; this module works out which roles the caller holds and enforces them.
//
// Denials: pages call notFound() (a project you can't see doesn't exist);
// server actions throw ForbiddenError (the UI already hides what you can't do,
// so reaching one is a bug or a forged call); route handlers answer 404/403.

type Session = NonNullable<Awaited<ReturnType<typeof getServerSession>>>;

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export type ProjectAccess = { all: boolean; roles: Record<string, ProjectRole> };

export type ProjectScope =
  | { projectId: string }
  | { environmentId: string }
  | { issueId: string };

// Pure: combine the org role and memberships into per-project roles. `all` is
// true when the org role reaches every project, so list queries can skip the
// filter.
export function resolveProjectAccess(
  orgRole: string | null | undefined,
  allProjectIds: string[],
  memberships: { projectId: string; role: string }[]
): ProjectAccess {
  const org = normalizeOrgRole(orgRole);
  const byProject = new Map(memberships.map((m) => [m.projectId, m.role]));
  const all = effectiveProjectRole(org, null) !== null;
  const roles: Record<string, ProjectRole> = {};
  const candidates = all ? allProjectIds : [...byProject.keys()];
  for (const projectId of candidates) {
    const role = effectiveProjectRole(org, byProject.get(projectId));
    if (role) roles[projectId] = role;
  }
  return { all, roles };
}

// Pure: does every project in the set grant `perms`? An invisible project fails.
export function checkProjectAccess(
  access: ProjectAccess,
  projectIds: string[],
  perms: ProjectPermissions
): boolean {
  return projectIds.every((id) => canProject(access.roles[id] ?? null, perms));
}

export async function getOrgRole(): Promise<OrgRole> {
  const session = await requireSession();
  return normalizeOrgRole(session.user.role);
}

export const getProjectAccess = cache(async (): Promise<ProjectAccess> => {
  const session = await requireSession();
  const [allProjects, memberships] = await Promise.all([
    db.select({ id: projects.id }).from(projects),
    db
      .select({ projectId: projectMembers.projectId, role: projectMembers.role })
      .from(projectMembers)
      .where(eq(projectMembers.userId, session.user.id)),
  ]);
  return resolveProjectAccess(
    session.user.role,
    allProjects.map((p) => p.id),
    memberships
  );
});

export async function accessibleProjectIds(): Promise<"all" | string[]> {
  const access = await getProjectAccess();
  return access.all ? "all" : Object.keys(access.roles);
}

// SQL-builder filter for any column holding a project id. Undefined = no filter
// (drizzle's and() drops it); an empty set becomes `false`, never `IN ()`.
export async function projectScope(column: AnyColumn): Promise<SQL | undefined> {
  const ids = await accessibleProjectIds();
  if (ids === "all") return undefined;
  if (ids.length === 0) return sql`false`;
  return inArray(column, ids);
}

// The same filter for drizzle's relational query API (RQB v2):
// `where: { projectId: await projectIdsWhere() }`. `{ in: [] }` matches nothing.
export async function projectIdsWhere(): Promise<{ in: string[] } | undefined> {
  const ids = await accessibleProjectIds();
  return ids === "all" ? undefined : { in: ids };
}

const projectIdOfEnvironment = cache(async (environmentId: string) => {
  const [row] = await db
    .select({ projectId: environments.projectId })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  return row?.projectId ?? null;
});

const projectIdOfIssue = cache(async (issueId: string) => {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row?.projectId ?? null;
});

async function projectIdOf(scope: ProjectScope): Promise<string | null> {
  if ("projectId" in scope) return scope.projectId;
  if ("environmentId" in scope) return projectIdOfEnvironment(scope.environmentId);
  return projectIdOfIssue(scope.issueId);
}

export async function getProjectRole(scope: ProjectScope): Promise<ProjectRole | null> {
  const projectId = await projectIdOf(scope);
  if (!projectId) return null;
  const access = await getProjectAccess();
  return access.roles[projectId] ?? null;
}

export async function requireOrgPermission(perms: OrgPermissions): Promise<Session> {
  const session = await requireSession();
  if (!canOrg(session.user.role, perms)) throw new ForbiddenError();
  return session;
}

export async function requireOrgPage(perms: OrgPermissions): Promise<Session> {
  const session = await requireSession();
  if (!canOrg(session.user.role, perms)) notFound();
  return session;
}

async function resolveScoped(scope: ProjectScope) {
  const session = await requireSession();
  const projectId = await projectIdOf(scope);
  const access = await getProjectAccess();
  const role = projectId ? (access.roles[projectId] ?? null) : null;
  return { session, projectId, role };
}

export async function requireProjectPermission(
  scope: ProjectScope,
  perms: ProjectPermissions
): Promise<{ session: Session; role: ProjectRole; projectId: string }> {
  const { session, projectId, role } = await resolveScoped(scope);
  if (!projectId || !role || !canProject(role, perms)) throw new ForbiddenError();
  return { session, role, projectId };
}

export async function requireProjectPage(
  scope: ProjectScope,
  perms: ProjectPermissions = { project: ["read"] }
): Promise<{ session: Session; role: ProjectRole; projectId: string }> {
  const { session, projectId, role } = await resolveScoped(scope);
  if (!projectId || !role || !canProject(role, perms)) notFound();
  return { session, role, projectId };
}

export async function requireProjectPermissionForAll(
  projectIds: string[],
  perms: ProjectPermissions
): Promise<Session> {
  const session = await requireSession();
  const access = await getProjectAccess();
  if (!checkProjectAccess(access, [...new Set(projectIds)], perms)) {
    throw new ForbiddenError();
  }
  return session;
}

// Route-handler variants: answer with a status instead of redirecting.
// 404 when the project is invisible, 403 when it is visible but the action is not
// permitted, 401 with no session.
export async function routeProjectGuard(
  scope: ProjectScope,
  perms: ProjectPermissions
): Promise<
  | { ok: true; session: Session; role: ProjectRole }
  | { ok: false; response: Response }
> {
  const session = await getServerSession();
  if (!session) return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  const role = await getProjectRole(scope);
  if (!role) return { ok: false, response: new Response("Not found", { status: 404 }) };
  if (!canProject(role, perms)) {
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }
  return { ok: true, session, role };
}

export async function routeOrgGuard(
  perms: OrgPermissions
): Promise<{ ok: true; session: Session } | { ok: false; response: Response }> {
  const session = await getServerSession();
  if (!session) return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  if (!canOrg(session.user.role, perms)) {
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }
  return { ok: true, session };
}
```

- [ ] **Step 4: Wire better-auth to the org roles**

In `lib/auth.ts`:
- Replace `import { ROLE_ADMIN, ROLE_VIEWER } from "./roles";` with `import { orgAc, orgRoles } from "./permissions";`.
- Replace the re-export line `export { ROLE_ADMIN, ROLE_MEMBER, type UserRole } from "./roles";` with `export type { OrgRole } from "./permissions";`.
- Change the `admin({...})` call to:

```ts
    admin({
      // Roles and their statements live in lib/permissions. A user nobody
      // assigned a role to — in practice a fresh Microsoft sign-in — lands on
      // `member`: with project isolation that is the knowledge base and zero
      // projects until an admin adds memberships.
      ac: orgAc,
      roles: orgRoles,
      defaultRole: "member",
      adminRoles: ["admin"],
    }),
```

Also update the Microsoft comment that says `new users land on defaultRole (viewer — read-only)` so it reads `new users land on defaultRole (member — no projects until added)`.

- [ ] **Step 5: Update the schema enum**

In `lib/db/schema.ts`:
- Replace `projectRoleEnum`'s values with `["viewer", "contributor", "maintainer"]`.
- Rewrite the comment above it to:

```ts
// Project role, per lib/permissions PROJECT_ROLES. Effective role on a project =
// max(this membership, the role the user's org role implies); no row and no
// implicit role = the project is invisible to them.
```

This will produce type errors in `actions/project-members.ts`, which Task 5 fixes. To keep this task green, apply only the enum change to `actions/project-members.ts` now: change `isValidRole` to

```ts
import { isProjectRole, type ProjectRole } from "@/lib/permissions";
function isValidRole(role: string): role is ProjectRole {
  return isProjectRole(role);
}
```

and change `ProjectMemberRow.role` to `ProjectRole`. Leave its guards to Task 5.

- [ ] **Step 6: Run the tests and typecheck**

Run: `bun test tests/authz.test.ts tests/permissions.test.ts && bun run typecheck`
Expected: PASS, and typecheck clean. If `project-members-client.tsx` fails on the old role list, change its option list to `PROJECT_ROLES` from `@/lib/permissions` now; Task 7 restyles it.

- [ ] **Step 7: Commit**

```bash
git add lib/authz.ts tests/authz.test.ts lib/auth.ts lib/db/schema.ts actions/project-members.ts app/[locale]/[projectKey]/project-members-client.tsx
git commit -m "feat(authz): add project-aware authorization boundary"
```

---

### Task 4: Project isolation on every read path

**Files:**
- Modify: `actions/project-catalog.ts`, `actions/environments.ts`, `lib/env-url.ts`, `actions/issues.ts` (read functions), `actions/runs.ts`, `actions/milestones.ts` (`listMilestones`), `actions/labels.ts` (`listLabels` stays global), `actions/users.ts` (`listAssignableUsers`), `actions/activity.ts`, `actions/saved-views.ts` (`listSavedViews`), `app/[locale]/[projectKey]/page.tsx` (null project → `notFound()`)
- Create: `tests/authz-guards.test.ts`

**Interfaces:**
- Consumes: `projectScope`, `projectIdsWhere`, `requireProjectPage`, `getProjectRole`, `requireOrgPermission` (Task 3).
- Produces: `listAssignableUsers(projectId: string): Promise<{ id: string; name: string }[]>` (**signature change**; callers pass the issue's project id).

- [ ] **Step 1: Write the failing grep guard**

Create `tests/authz-guards.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// Cross-project reads must filter to the caller's projects. The DB lookups are
// thin, so the cheapest durable check is structural: each listed function must
// mention one of the scope helpers. Add a function here when you add a
// cross-project read.
const SCOPED_READS: Record<string, string[]> = {
  "actions/project-catalog.ts": [
    "listProjects",
    "listProjectsWithEnvironments",
    "getProject",
    "getProjectWithEnvironments",
    "getProjectByKeyWithEnvironments",
  ],
  "actions/environments.ts": ["listEnvironments", "getEnvironmentsLastOpened", "getEnvironmentById"],
  "actions/issues.ts": [
    "getOpenIssueCounts",
    "getAssignedIssueCounts",
    "listAssignedIssues",
    "getIssueDetail",
    "listAllIssues",
    "listIssues",
  ],
  "actions/runs.ts": [
    "getEnvironmentsLastActivity",
    "getActiveRuns",
    "getEnvironmentRuns",
    "getRunSnapshot",
    "getEnvironmentKpis",
    "getRecentFailedRuns",
  ],
  // notifications are deliberately absent: they're per-user rows with no
  // project column, written only to their recipient; a link into a project the
  // user has since lost resolves to the 404 page.
  "actions/milestones.ts": ["listMilestones"],
};

const SCOPE_HELPERS = /projectScope|projectIdsWhere|requireProjectPage|requireProjectPermission|getProjectRole/;

function body(source: string, name: string): string {
  const start = source.search(new RegExp(`export (async )?function ${name}\\b`));
  if (start < 0) throw new Error(`${name} not found`);
  const next = source.slice(start + 1).search(/\nexport /);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

describe("cross-project reads are scoped", () => {
  for (const [file, fns] of Object.entries(SCOPED_READS)) {
    const source = readFileSync(file, "utf8");
    for (const fn of fns) {
      it(`${file} ${fn}`, () => {
        expect(body(source, fn)).toMatch(SCOPE_HELPERS);
      });
    }
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/authz-guards.test.ts`
Expected: FAIL for every listed function.

- [ ] **Step 3: Apply the scope to each read**

Use these exact replacements. "SQL" means the SQL-builder query style, and "RQB" means `db.query.*.findMany/findFirst`.

| Function | Change |
|---|---|
| `listProjects` | `.from(projects).where(await projectScope(projects.id)).orderBy(...)` |
| `listProjectsWithEnvironments` | RQB: add `where: { id: await projectIdsWhere() }` |
| `getProject(id)` / `getProjectWithEnvironments(id)` | After `requireSession()`, `if (!(await getProjectRole({ projectId: id }))) return null;` |
| `getProjectByKeyWithEnvironments(key)` | After the lookup, `if (!row \|\| !(await getProjectRole({ projectId: row.id }))) return null;` |
| `listEnvironments` | add `await projectScope(environments.projectId)` into its `where(and(...))` |
| `getEnvironmentsLastOpened` | same as `listEnvironments` |
| `getEnvironmentById(id)` | `if (!(await getProjectRole({ environmentId: id }))) return null;` before the query |
| `lib/env-url.ts resolveEnvIdByKeySlug` | after resolving `project`, `if (!(await getProjectRole({ projectId: project.id }))) notFound();` (import from `@/lib/authz`) |
| `getOpenIssueCounts` | `.where(and(inArray(issues.status, [...OPEN_STATUSES]), await projectScope(issues.projectId)))` |
| `getAssignedIssueCounts` | add `await projectScope(issues.projectId)` to its `where` |
| `listAssignedIssues` | RQB: `where: { assigneeId: userId, projectId: await projectIdsWhere() }` |
| `getIssueDetail(key, n)` | after the project lookup: `if (!(await getProjectRole({ projectId: project.id }))) return null;` |
| `listAllIssues` | push `await projectScope(issues.projectId)` into `conditions` when defined |
| `listIssues(projectId)` | replace `requireSession()` with `await requireProjectPage({ projectId })` |
| `getEnvironmentsLastActivity`, `getActiveRuns`, `getRecentFailedRuns` | join or filter `runs.environmentId` via `inArray(runs.environmentId, db.select({ id: environments.id }).from(environments).where(await projectScope(environments.projectId)))` |
| `getEnvironmentRuns(envId)`, `getEnvironmentKpis(envId)` | replace `requireSession()` with `await requireProjectPage({ environmentId: envId })` |
| `getRunSnapshot(runId)` | load the run's `environmentId` first; `if (!run \|\| !(await getProjectRole({ environmentId: run.environmentId }))) return null;` |
| `listMilestones(projectId)` | `await requireProjectPage({ projectId })` |
| `listAssignableUsers(projectId)` | return non-banned users where `role in ('admin','infra')` **or** they have a `project_members` row on `projectId`. Guard: `await requireProjectPermission({ projectId }, { project: ["read"] })`. Update every caller (search `listAssignableUsers(`) to pass the issue/project id |
| `listActivity` | replace `requireAdmin()` with `requireOrgPermission({ audit: ["read"] })` |

Use `projectScope`/`projectIdsWhere` for lists. Return `null` (which the existing callers already treat as not found) for single-entity reads.

`app/[locale]/[projectKey]/page.tsx` already calls `notFound()` on a null project. Confirm that, and add the call if it is missing.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: `authz-guards` PASS, and the whole suite green.

- [ ] **Step 5: Manual smoke check**

Run `bun run dev`, sign in as a user whose role you set to `member` with one membership (local DB), and check:
- The sidebar lists one project.
- `/` shows only that project's counts.
- Opening another project's URL renders the 404 page.

- [ ] **Step 6: Commit**

```bash
git add actions lib/env-url.ts app/[locale]/[projectKey]/page.tsx tests/authz-guards.test.ts
git commit -m "feat(authz): isolate projects on every read path"
```

---

### Task 5: Project-scoped mutations and routes

**Files:**
- Modify: `actions/issues.ts` (writes), `actions/issue-attachments.ts`, `actions/labels.ts` (`setIssueLabels`), `actions/milestones.ts` (writes), `actions/test-runs.ts`, `actions/services.ts`, `actions/backups.ts`, `actions/databases.ts`, `actions/mock-time.ts`, `actions/mail.ts`, `lib/mailpit/route.ts`, `actions/mailpit-settings.ts`, `actions/environments.ts` (writes), `actions/jira.ts` (`getJiraLink`, `saveJiraLink`, `unlinkJiraProject`, `syncJiraProjectNow`), `actions/project-members.ts`
- Modify routes: `app/api/environments/[environmentId]/services/[role]/logs/stream/route.ts`, `app/api/runs/[id]/stream/route.ts`, `app/api/runs/running/stream/route.ts`, `app/api/issues/[id]/attachments/route.ts`, `app/api/issues/attachments/[id]/route.ts`
- Modify: `tests/authz-guards.test.ts` (add the mutation table)

**Interfaces:**
- Consumes: `requireProjectPermission`, `requireProjectPermissionForAll`, `routeProjectGuard`, `ForbiddenError` (Task 3).

- [ ] **Step 1: Extend the grep guard (failing)**

Append to `tests/authz-guards.test.ts`:

```ts
// Every project-scoped mutation must state the permission it needs.
const SCOPED_WRITES: Record<string, Record<string, RegExp>> = {
  "actions/issues.ts": {
    addComment: /issue: \["write"\]/,
    createIssue: /issue: \["write"\]/,
    updateIssue: /issue: \["write"\]/,
    setIssueStatus: /issue: \["write"\]/,
    bulkSetStatus: /requireProjectPermissionForAll\([\s\S]*issue: \["write"\]/,
    bulkDeleteIssues: /requireProjectPermissionForAll\([\s\S]*issue: \["delete"\]/,
    deleteIssue: /issue: \["delete"\]/,
  },
  "actions/issue-attachments.ts": {
    listIssueAttachments: /project: \["read"\]/,
    deleteIssueAttachment: /issue: \["write"\]/,
  },
  "actions/labels.ts": { setIssueLabels: /issue: \["write"\]/ },
  "actions/milestones.ts": {
    createMilestone: /issue: \["write"\]/,
    updateMilestone: /issue: \["write"\]/,
    setMilestoneClosed: /issue: \["write"\]/,
    deleteMilestone: /issue: \["delete"\]/,
  },
  "actions/test-runs.ts": {
    listIssueTestRuns: /project: \["read"\]/,
    recordTestRun: /issue: \["write"\]/,
  },
  "actions/services.ts": {
    getAllServiceStatuses: /project: \["read"\]/,
    controlService: /service: \["control"\]/,
  },
  "actions/backups.ts": {
    getBackupList: /database: \["backup"\]|database: \["restore"\]/,
    createDatabaseBackup: /database: \["backup"\]/,
    restoreDatabaseBackup: /database: \["restore"\]/,
  },
  "actions/databases.ts": {
    getDatabaseList: /project: \["read"\]/,
    createDatabase: /database: \["create"\]/,
    dropDatabase: /database: \["drop"\]/,
    renameDatabase: /database: \["rename"\]/,
  },
  "actions/mailpit-settings.ts": {
    getMailpitSettings: /environment: \["update"\]/,
    saveMailpitSettings: /environment: \["update"\]/,
    testMailpitConnection: /environment: \["update"\]/,
  },
  "actions/environments.ts": {
    createEnvironment: /environment: \["create"\]/,
    updateEnvironment: /environment: \["update"\]/,
    deleteEnvironment: /environment: \["delete"\]/,
  },
  "actions/project-members.ts": {
    listProjectMembers: /member: \["manage"\]/,
    addProjectMember: /member: \["manage"\]/,
    updateProjectMemberRole: /member: \["manage"\]/,
    removeProjectMember: /member: \["manage"\]/,
  },
  "actions/jira.ts": {
    getJiraLink: /project: \["read"\]/,
    saveJiraLink: /environment: \["update"\]/,
    unlinkJiraProject: /environment: \["update"\]/,
    syncJiraProjectNow: /environment: \["update"\]/,
  },
};

describe("project-scoped writes state their permission", () => {
  for (const [file, fns] of Object.entries(SCOPED_WRITES)) {
    const source = readFileSync(file, "utf8");
    for (const [fn, pattern] of Object.entries(fns)) {
      it(`${file} ${fn}`, () => {
        expect(body(source, fn)).toMatch(pattern);
      });
    }
  }
});
```

Run: `bun test tests/authz-guards.test.ts`
Expected: FAIL for these entries.

- [ ] **Step 2: Issues, comments, labels, milestones, test runs, attachments**

Patterns to apply. Replace the `requireSession()` line with the guard shown, and keep the returned `session` variable name.

```ts
// createIssue — after parsing `input` (it carries projectId):
const { session } = await requireProjectPermission(
  { projectId: input.projectId },
  { issue: ["write"] }
);

// updateIssue(id) / setIssueStatus(id) / addComment(issueId) / setIssueLabels(issueId):
const { session } = await requireProjectPermission({ issueId: id }, { issue: ["write"] });

// deleteIssue(id):
await requireProjectPermission({ issueId: id }, { issue: ["delete"] });

// bulkSetStatus(ids) / bulkDeleteIssues(ids):
const owners = await db
  .select({ projectId: issues.projectId })
  .from(issues)
  .where(inArray(issues.id, ids));
await requireProjectPermissionForAll(
  owners.map((o) => o.projectId),
  { issue: ["delete"] } // { issue: ["write"] } for bulkSetStatus
);

// milestones: create(input.projectId) → { projectId }; update/close(id) → load
// milestone.projectId first, then requireProjectPermission({ projectId }, …).

// test runs + attachments: resolve via the issue id:
await requireProjectPermission({ issueId }, { issue: ["write"] });
```

Server actions here return `ActionResponse` and catch inside `try`. Make sure the guard sits **outside** the `try`, so `ForbiddenError` propagates and is not swallowed into a generic "Failed to …".

- [ ] **Step 3: Environment operations**

| Action | Guard (replace the existing `requireSession`/`requireCapability`) |
|---|---|
| `getAllServiceStatuses(envId)` | `requireProjectPermission({ environmentId }, { project: ["read"] })` |
| `controlService` | `requireProjectPermission({ environmentId }, { service: ["control"] })` (**closes the hole where any session could restart services**) |
| `getBackupList`, `revalidateBackupList` | `requireProjectPermission({ environmentId }, { database: ["backup"] })` |
| `createDatabaseBackup` | `… { database: ["backup"] }` |
| `restoreDatabaseBackup` | `… { database: ["restore"] }` |
| `getDatabaseList` | `… { project: ["read"] }` |
| `createDatabase` / `dropDatabase` / `renameDatabase` | `… { database: ["create"] }` / `["drop"]` / `["rename"]` |
| `actions/mock-time.ts requireEnvironment` | change its parameter from `Capability \| null` to `ProjectPermissions \| null`. Read path: `requireProjectPermission({ environmentId }, { project: ["read"] })`. All mutating callers pass `{ clock: ["control"] }` instead of `"ops.destructive"` |
| `actions/mail.ts requireMail(envId, action)` | `requireProjectPermission({ environmentId }, { mail: ["read"] })`; `deleteMail` uses `{ mail: ["delete"] }` |
| `lib/mailpit/route.ts authorizeMailRoute` | replace the session/role block with `const guard = await routeProjectGuard({ environmentId }, { mail: ["read"] }); if (!guard.ok) return guard;` |
| `actions/mailpit-settings.ts` (3 fns) | `requireProjectPermission({ environmentId }, { environment: ["update"] })` |
| `createEnvironment(input)` | `requireProjectPermission({ projectId: input.projectId }, { environment: ["create"] })` |
| `updateEnvironment(id)` / `deleteEnvironment(id)` | `requireProjectPermission({ environmentId: id }, { environment: ["update"] })` / `["delete"]` |
| `getJiraLink(projectId)` | `requireProjectPermission({ projectId }, { project: ["read"] })` |
| `saveJiraLink` / `unlinkJiraProject` / `syncJiraProjectNow` | `requireProjectPermission({ projectId }, { environment: ["update"] })` |

- [ ] **Step 4: Project members**

In `actions/project-members.ts`:
- Replace every `requireCapability("admin", { projectId })` with `requireProjectPermission({ projectId }, { member: ["manage"] })`. Use `input.projectId` both for the check and in the subsequent `where`, as today.
- Reject any role failing `isProjectRole` with `t("errorInvalidRole")`.
- Delete the old comment block about "admin-only (global admin, or a per-project admin)". Replace it with: `// Managing membership needs member:manage on the project (maintainer, or an admin/infra org role).`
- `updateProjectMemberRole` and `removeProjectMember` must also `recordActivity` with `action: "member.roleChanged"` (`data: { user, project, from, to }`) and `"member.removed"`. Keep the existing `memberAdded`/`memberRemoved` naming if those are the current action strings. Check `grep -n "action:" actions/project-members.ts` and reuse them.

- [ ] **Step 5: Route handlers**

Each route handler starts with a guard:

```ts
const guard = await routeProjectGuard({ environmentId }, { service: ["logs"] });
if (!guard.ok) return guard.response;
```

| Route | Scope | Permission |
|---|---|---|
| `api/environments/[environmentId]/services/[role]/logs/stream` | `{ environmentId }` | `{ service: ["logs"] }` |
| `api/runs/[id]/stream` | load the run → `{ environmentId: run.environmentId }` | `{ project: ["read"] }` |
| `api/runs/running/stream` | none (list) | filter the streamed runs by `projectScope` the same way `getActiveRuns` does in Task 4 |
| `api/issues/[id]/attachments` (GET/POST) | `{ issueId: id }` | GET `{ project: ["read"] }`, POST `{ issue: ["write"] }` |
| `api/issues/attachments/[id]` | load the attachment → `{ issueId: att.issueId }` | `{ project: ["read"] }` |

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add actions lib/mailpit/route.ts app/api tests/authz-guards.test.ts
git commit -m "feat(authz): enforce project permissions on mutations and routes"
```

---

### Task 6: Org-scoped actions, pages and routes

**Files:**
- Modify: `actions/servers.ts`, `actions/s3-connections.ts`, `actions/explorer.ts`, `actions/tunnels.ts`, `actions/jira.ts` (connection CRUD), `actions/project-catalog.ts` (`addProject`, `editProject`, `removeProject`), `actions/knowledge.ts`, `lib/knowledge.ts`, `actions/users.ts`
- Modify pages: `app/[locale]/servers/**/page.tsx`, `app/[locale]/storage/**/page.tsx`, `app/[locale]/admin/layout.tsx`, `app/[locale]/admin/users/page.tsx`, `app/[locale]/admin/jira/**/page.tsx`, `app/[locale]/admin/tunnels/**/page.tsx`, `app/[locale]/admin/activity/page.tsx`, `app/[locale]/projects/page.tsx`, `app/[locale]/[projectKey]/settings/page.tsx`, `app/[locale]/[projectKey]/environments/new/page.tsx`, `app/[locale]/[projectKey]/[envSlug]/settings/page.tsx`, `app/[locale]/knowledge/**`
- Modify routes: `app/api/terminal/ticket/route.ts`, `app/api/explorer/{upload,download,archive}/route.ts`, `app/api/knowledge/asset/**`
- Modify: `tests/authz-guards.test.ts`

**Interfaces:**
- Consumes: `requireOrgPermission`, `requireOrgPage`, `routeOrgGuard`, `requireProjectPage` (Task 3).

- [ ] **Step 1: Extend the grep guard (failing)**

Append:

```ts
describe("no legacy authorization helpers outside lib/auth-session", () => {
  const LEGACY = /\b(requireAdmin|isAdmin|requireCapability|getEffectiveRole|roleHasCapability)\(/;
  const files = new Bun.Glob("{actions,app,lib,components}/**/*.{ts,tsx}");
  for (const file of files.scanSync(".")) {
    if (file === "lib/auth-session.ts") continue;
    it(file, () => {
      expect(readFileSync(file, "utf8")).not.toMatch(LEGACY);
    });
  }
});
```

Run: `bun test tests/authz-guards.test.ts`
Expected: FAIL across about 49 files. Tasks 6 and 7 turn these green.

- [ ] **Step 2: Replace org guards in actions**

| File / functions | New guard |
|---|---|
| `servers.ts` `getServerUsage`, `getServers`, `getServerById` | `requireOrgPermission({ server: ["read"] })` |
| `servers.ts` create/update/test/delete/bulkDelete | `requireOrgPermission({ server: ["manage"] })` |
| `explorer.ts` (all 11) | `requireOrgPermission({ server: ["files"] })` when the target is a server; `{ storage: ["files"] }` when the target is an S3 connection. Branch on the existing target-kind argument |
| `s3-connections.ts` get* | `{ storage: ["read"] }`; create/update/delete/test → `{ storage: ["manage"] }` |
| `tunnels.ts` `getCloudflareZones`, `getTunnels`, `getTunnel`, `getTunnelRoutes`, `getOriginCandidates` | `{ tunnel: ["read"] }`; every other function → `{ tunnel: ["manage"] }` |
| `jira.ts` `getJiraConnections`, `getJiraConnection`, `getJiraWebhookUrl`, create/update/delete/test connection | `{ integration: ["manage"] }` |
| `project-catalog.ts` `addProject` | `{ project: ["create"] }` |
| `project-catalog.ts` `editProject(id)` | `requireProjectPermission({ projectId: id }, { environment: ["update"] })` (a maintainer edits name/description); `removeProject` → `requireOrgPermission({ project: ["delete"] })` |
| `knowledge.ts` collection fns, `deleteDocument` | `{ knowledge: ["manage"] }` |
| `knowledge.ts` `createDocument`, `updateDocument`, `moveDocument`, `restoreRevision` | `{ knowledge: ["write"] }` |
| `knowledge.ts` `searchKnowledge`, `getBacklinks` | `{ knowledge: ["read"] }` |
| `lib/knowledge.ts` `KnowledgeViewer` | rename field `isAdmin` → `canManage`, set from `canOrg(session.user.role, { knowledge: ["manage"] })`; update its 4 internal uses |
| `users.ts` `listUsers` | `{ user: ["list"] }` |
| `users.ts` `listPendingInvitations`, `inviteUser`, `revokeInvitation`, `resendInvitation`, `bulkRevokeInvitations` | `{ user: ["invite"] }` |
| `users.ts` `updateUserName`, `deleteUser`, `bulkDeleteUsers` | `{ user: ["update"] }` / `{ user: ["delete"] }` |
| `users.ts` `updateUserRole` | `{ user: ["set-role"] }`; validate with `isOrgRole`, and use `type OrgRole` instead of `UserRole` |
| `users.ts` `inviteUser` role | `const role: OrgRole = isOrgRole(input.role) ? input.role : "member";` |
| `users.ts` `acceptInvitation` | `const role: OrgRole = normalizeOrgRole(inv.role);` |
| `users.ts` `createInitialUser` | keep `role: "admin"` (first user bootstraps the org) |

- [ ] **Step 3: Pages**

Each page that today calls `requireAdmin()` now calls `requireOrgPage(...)` with the matching read statement:
- servers → `{ server: ["read"] }`; servers/new → `{ server: ["manage"] }`; servers/[id]/terminal → `{ server: ["terminal"] }`; servers/[id]/files → `{ server: ["files"] }`
- storage → `{ storage: ["read"] }`; storage/new → `{ storage: ["manage"] }`; storage/[id]/files → `{ storage: ["files"] }`
- `admin/layout.tsx` → `{ audit: ["read"] }`. Each child page adds its own: users `{ user: ["list"] }`, jira `{ integration: ["manage"] }`, tunnels `{ tunnel: ["read"] }`.
- `projects/page.tsx` (project CRUD list) → `{ project: ["create"] }`
- `[projectKey]/settings/page.tsx` → `requireProjectPage({ projectId }, { environment: ["update"] })`; `[projectKey]/environments/new` → `{ environment: ["create"] }`; `[envSlug]/settings` → `requireProjectPage({ environmentId }, { environment: ["update"] })`
- knowledge edit/new/history → `requireOrgPage({ knowledge: ["write"] })`; knowledge read pages → `{ knowledge: ["read"] }`

Change `admin/page.tsx` to redirect to `/admin/access` (Task 9 adds that page). Until Task 9 lands, keep `/admin/activity`.

- [ ] **Step 4: Routes**

```ts
// app/api/terminal/ticket/route.ts — replace the session/isAdmin block:
const guard = await routeOrgGuard({ server: ["terminal"] });
if (!guard.ok) return guard.response;
const { session } = guard;
```

- Explorer routes: `routeOrgGuard({ server: ["files"] })`, or `{ storage: ["files"] }` for S3 targets, using the same branching as the explorer actions.
- Knowledge asset routes: `routeOrgGuard({ knowledge: ["read"] })` for GET and `{ knowledge: ["write"] }` for upload.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: typecheck green. The legacy grep test will still fail only in UI files (layouts/components), which Task 7 handles.

- [ ] **Step 6: Commit**

```bash
git add actions lib/knowledge.ts app tests/authz-guards.test.ts
git commit -m "feat(authz): enforce org permissions on infra, integrations, users and knowledge"
```

---

### Task 7: UI gating, role pickers and i18n

**Files:**
- Create: `components/project-role.tsx`
- Delete: `components/ops-capability.tsx`
- Modify: `app/[locale]/layout.tsx`, `components/app-sidebar.tsx`, `components/header-breadcrumb.tsx`, `components/command-palette.tsx`, `components/user-menu.tsx`, `components/knowledge-tree.tsx`, `app/[locale]/knowledge/layout.tsx`, `app/[locale]/knowledge/[slug]/page.tsx`, `app/[locale]/(home)/page.tsx`, `app/[locale]/[projectKey]/page.tsx`, `app/[locale]/[projectKey]/[envSlug]/layout.tsx`, `app/[locale]/[projectKey]/[envSlug]/mail/page.tsx`, `app/[locale]/[projectKey]/[envSlug]/{backup-database,restore-database,databases,mock-time}/*.tsx`, `app/[locale]/admin/users/users-client.tsx`, `app/[locale]/[projectKey]/project-members-client.tsx`, `messages/{ar,en,es,id,zh}.json`

**Interfaces:**
- Consumes: `canOrg`, `canProject`, `OrgRole`, `ProjectRole`, `ORG_ROLES`, `PROJECT_ROLES` (Task 1); `getOrgRole`, `getProjectAccess`, `requireProjectPage` (Task 3).
- Produces:
  - `ProjectRoleProvider({ role: ProjectRole, children })`
  - `useProjectRole(): ProjectRole | null`
  - `useProjectCan(perms: ProjectPermissions): boolean`
  - Navigation components take `orgRole: OrgRole` (replacing `isAdmin: boolean`) and, where they show env-level items, `projectRoles: Record<string, ProjectRole>`.

- [ ] **Step 1: Create `components/project-role.tsx`**

```tsx
"use client";

import { createContext, useContext } from "react";
import { canProject, type ProjectPermissions, type ProjectRole } from "@/lib/permissions";

// The caller's effective role on the project in scope, computed once in the
// environment layout. Buttons read it to disable what the role can't do; the
// server actions enforce the same statements regardless.
const ProjectRoleContext = createContext<ProjectRole | null>(null);

export function ProjectRoleProvider({
  role,
  children,
}: {
  role: ProjectRole;
  children: React.ReactNode;
}) {
  return <ProjectRoleContext.Provider value={role}>{children}</ProjectRoleContext.Provider>;
}

export function useProjectRole(): ProjectRole | null {
  return useContext(ProjectRoleContext);
}

export function useProjectCan(perms: ProjectPermissions): boolean {
  return canProject(useContext(ProjectRoleContext), perms);
}
```

- [ ] **Step 2: Environment layout and ops buttons**

In `app/[locale]/[projectKey]/[envSlug]/layout.tsx`, replace the `getEffectiveRole`/`roleHasCapability`/`OpsCapabilityProvider` block with:

```tsx
const { role } = await requireProjectPage({ environmentId });
return <ProjectRoleProvider role={role}>{children}</ProjectRoleProvider>;
```

Replace each `useCanRunOps()` consumer:
- `backup-database.tsx`: `const canRunOps = useProjectCan({ database: ["backup"] });`
- `restore-database.tsx`: `useProjectCan({ database: ["restore"] })`
- `manage-databases.tsx`: create button `useProjectCan({ database: ["create"] })`, drop `["drop"]`, rename `["rename"]` (three booleans)
- `mock-time-api.tsx`, `mock-time-legacy.tsx`: `useProjectCan({ clock: ["control"] })`

Then delete `components/ops-capability.tsx`.

Also find the service start/stop/restart buttons (`grep -rn "controlService(" app components`) and disable them with `useProjectCan({ service: ["control"] })`. They are not gated today.

- [ ] **Step 3: Root layout and navigation**

In `app/[locale]/layout.tsx`:
- Replace `const admin = session ? isAdmin(session) : false;` with:

```tsx
const orgRole = session ? normalizeOrgRole(session.user.role) : "member";
const projectRoles = session ? (await getProjectAccess()).roles : {};
```

- Pass `orgRole={orgRole}` and `projectRoles={projectRoles}` instead of `isAdmin={admin}` to `AppSidebar`, `HeaderBreadcrumb` and `CommandPalette`.

In each component, change the prop type `isAdmin: boolean` to `orgRole: OrgRole` (plus `projectRoles: Record<string, ProjectRole>` where env items are rendered), and gate as follows:

| Item | Condition |
|---|---|
| Sidebar Servers | `canOrg(orgRole, { server: ["read"] })` |
| Sidebar Storage | `canOrg(orgRole, { storage: ["read"] })` |
| Sidebar Admin section, `/admin` active state, user-menu admin link | `canOrg(orgRole, { audit: ["read"] })` |
| Admin sub-items: Users / Access | `{ user: ["list"] }` |
| Admin sub-item: Jira | `{ integration: ["manage"] }` |
| Admin sub-item: Tunnels | `{ tunnel: ["read"] }` |
| Admin sub-item: Activity | `{ audit: ["read"] }` |
| Env nav item `settings` (`adminOnly: true` → rename the field to `perm`) | `canProject(projectRoles[activeEnv.projectId] ?? null, { environment: ["update"] })` |
| Env nav item `mail` | `{ mail: ["read"] }` |
| Env nav items `mockTime` | `{ clock: ["control"] }` |
| Palette "Create environment" | `canProject(projectRoles[activeEnv.projectId] ?? null, { environment: ["create"] })` |
| Palette "Create project", `/projects` | `canOrg(orgRole, { project: ["create"] })` |
| Breadcrumb admin-only links | same mapping as the sidebar |

Replace the sidebar item shape `{ key, url, icon, adminOnly: boolean }` with `{ key, url, icon, perm?: ProjectPermissions }`, and filter with `.filter((item) => !item.perm || canProject(role, item.perm))`.

- [ ] **Step 4: Other pages**

- `(home)/page.tsx`: replace `roleRank(session.user.role) >= ROLE_RANK[ROLE_MAINTAINER]` with `canOrg(session.user.role, { server: ["read"] })`. That is the "ops-oriented home" for infra/admin/observer.
- `[projectKey]/page.tsx`: replace the `isAdmin`/`getEffectiveRole` block with `const { role } = await requireProjectPage({ projectId: project.id });`. Then:
  - Members panel visible when `canProject(role, { member: ["manage"] })`.
  - Settings link visible when `canProject(role, { environment: ["update"] })`.
  - Delete-project card visible when `canOrg(session.user.role, { project: ["delete"] })`.
- `[envSlug]/mail/page.tsx`: use `requireProjectPage({ environmentId }, { mail: ["read"] })`. The "configure Mailpit" link shows when `canProject(role, { environment: ["update"] })`.
- `knowledge/layout.tsx`, `knowledge/[slug]/page.tsx`, `knowledge-tree.tsx`: rename `isAdmin` to `canManage = canOrg(role, { knowledge: ["manage"] })`.

- [ ] **Step 5: Role pickers**

- `users-client.tsx`: drop the `@/lib/roles` imports. Use `ORG_ROLES` for the change-role menu and for the invite form `ROLE_OPTIONS` (all four, default `"member"`). Use `z.enum(ORG_ROLES)` in the form schema.
- `project-members-client.tsx`: use `PROJECT_ROLES` for the role select, default `"contributor"` when adding.

- [ ] **Step 6: i18n (all 5 locales)**

In each `messages/*.json`:
- `users.role`: remove `viewer` and `maintainer`; add `infra` and `observer`. Keep `admin` and `member`.
- `projectMembers.role`: remove `member` and `admin`; add `contributor`. Keep `viewer` and `maintainer`.
- `projectMembers.emptyDescription`: new meaning.

| Key | en | id | es | zh | ar |
|---|---|---|---|---|---|
| `users.role.infra` | Infra | Infra | Infraestructura | 基础设施 | البنية التحتية |
| `users.role.observer` | Observer | Pengamat | Observador | 观察者 | مراقب |
| `projectMembers.role.contributor` | Contributor | Kontributor | Colaborador | 贡献者 | مساهم |
| `projectMembers.emptyDescription` | Only members (and admins, infra and observers) can see this project. | Hanya anggota (serta admin, infra, dan pengamat) yang bisa melihat project ini. | Solo los miembros (y administradores, infraestructura y observadores) pueden ver este proyecto. | 只有成员（以及管理员、基础设施和观察者）可以查看此项目。 | يمكن للأعضاء فقط (والمسؤولين وفريق البنية التحتية والمراقبين) رؤية هذا المشروع. |

- [ ] **Step 7: Run tests, typecheck and lint**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all green. The legacy-helper grep test now passes everywhere except `lib/auth-session.ts` itself (excluded).

- [ ] **Step 8: Manual check**

With `bun run dev`, cycle one local user through `admin`, `infra`, `observer` and `member` (+ contributor on one project) via SQL. Check:
- **Sidebar sections:** Servers/Storage show for admin, infra and observer; Admin shows for admin, infra and observer, each with its own sub-items.
- **Ops buttons:** buttons a role cannot use are disabled. A contributor can back up, restore and use mock time, but cannot create/drop a DB or restart services.
- **Role pickers:** they show the new labels.

- [ ] **Step 9: Commit**

```bash
git add components app messages
git rm components/ops-capability.tsx
git commit -m "feat(authz): gate navigation and controls by org and project permissions"
```

---

### Task 8: Remove the old ladder

**Files:**
- Delete: `lib/roles.ts`, `tests/roles.test.ts`
- Modify: `lib/auth-session.ts` (keep only `getServerSession`, `requireSession`)
- Modify: `tests/authz-guards.test.ts`

- [ ] **Step 1: Extend the guard (failing)**

Append:

```ts
// add `existsSync` to the node:fs import at the top of the file
describe("old role module is gone", () => {
  it("lib/roles.ts no longer exists", () => {
    expect(existsSync("lib/roles.ts")).toBe(false);
  });
  it("nothing imports @/lib/roles", () => {
    for (const file of new Bun.Glob("{actions,app,lib,components,tests}/**/*.{ts,tsx}").scanSync(".")) {
      expect(readFileSync(file, "utf8")).not.toContain('@/lib/roles"');
    }
  });
});
```

Run: `bun test tests/authz-guards.test.ts`
Expected: FAIL.

- [ ] **Step 2: Delete and trim**

```bash
git rm lib/roles.ts tests/roles.test.ts
```

In `lib/auth-session.ts`, delete:
- `isAdmin`
- `SessionUser`, `CapabilityScope`, `projectIdOfEnvironment`, `membershipRoleOf`
- `resolveEffectiveRole`, `requireCapability`, `getEffectiveRole`, `requireAdmin`
- the imports they used (`and`, `eq`, `db`, `environments`, `projectMembers`, everything from `./roles`)

Keep `getServerSession` and `requireSession` with their comments.

- [ ] **Step 3: Run tests and typecheck**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -A lib/auth-session.ts tests/authz-guards.test.ts
git commit -m "refactor(authz): remove the role-ladder capability model"
```

---

### Task 9: Access matrix, offboarding and audit trail

**Files:**
- Create: `lib/access.ts`, `tests/access.test.ts`, `actions/access.ts`, `app/[locale]/admin/access/page.tsx`, `app/[locale]/admin/access/access-client.tsx`
- Modify: `actions/users.ts` (`updateUserRole` records activity and uses `assertNotLastAdmin`), `app/[locale]/admin/page.tsx` (redirect to `/admin/access`), `components/app-sidebar.tsx` (Admin → Access item), `app/[locale]/admin/activity/page.tsx` (render the new actions), `messages/{ar,en,es,id,zh}.json`

**Interfaces:**
- Consumes: `requireOrgPermission`, `requireOrgPage` (Task 3); `ORG_ROLES`, `PROJECT_ROLES`, `canOrg` (Task 1); `recordActivity` (`lib/activity.ts`).
- Produces:
  - `lib/access.ts`:
    - `assertNotLastAdmin(adminIds: string[], targetId: string, nextRole: string | null): boolean` (true = allowed)
    - `isInactive(lastSeen: Date | null, now: Date, days = 60): boolean`
  - `actions/access.ts`:
    - `getAccessMatrix(): Promise<AccessMatrix>`
    - `offboardUser(userId: string): Promise<ActionResponse>`
    - `type AccessMatrix = { projects: { id: string; key: string; name: string }[]; users: { id: string; name: string; email: string; role: OrgRole; banned: boolean; lastSeen: string | null; memberships: Record<string, ProjectRole> }[] }`

- [ ] **Step 1: Write the failing test**

Create `tests/access.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { assertNotLastAdmin, isInactive } from "@/lib/access";

describe("assertNotLastAdmin", () => {
  it("allows demoting an admin when another admin remains", () => {
    expect(assertNotLastAdmin(["a", "b"], "a", "member")).toBe(true);
  });
  it("refuses demoting the last admin", () => {
    expect(assertNotLastAdmin(["a"], "a", "member")).toBe(false);
  });
  it("refuses offboarding (null role) the last admin", () => {
    expect(assertNotLastAdmin(["a"], "a", null)).toBe(false);
  });
  it("allows any change to a non-admin", () => {
    expect(assertNotLastAdmin(["a"], "z", null)).toBe(true);
  });
  it("allows keeping the last admin as admin", () => {
    expect(assertNotLastAdmin(["a"], "a", "admin")).toBe(true);
  });
});

describe("isInactive", () => {
  const now = new Date("2026-10-03T00:00:00Z");
  it("treats never-seen users as inactive", () => {
    expect(isInactive(null, now)).toBe(true);
  });
  it("flags users idle for more than 60 days", () => {
    expect(isInactive(new Date("2026-08-01T00:00:00Z"), now)).toBe(true);
  });
  it("keeps recent users active", () => {
    expect(isInactive(new Date("2026-09-20T00:00:00Z"), now)).toBe(false);
  });
});
```

Run: `bun test tests/access.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 2: Implement `lib/access.ts`**

```ts
// Pure rules behind the access page, kept apart so they're testable without a DB.

const DAY_MS = 24 * 60 * 60 * 1000;

// True when changing `targetId` to `nextRole` (null = offboard) still leaves at
// least one admin. Without an admin nobody can manage users or roles.
export function assertNotLastAdmin(
  adminIds: string[],
  targetId: string,
  nextRole: string | null
): boolean {
  if (!adminIds.includes(targetId)) return true;
  if (nextRole === "admin") return true;
  return adminIds.some((id) => id !== targetId);
}

export function isInactive(lastSeen: Date | null, now: Date, days = 60): boolean {
  if (!lastSeen) return true;
  return now.getTime() - lastSeen.getTime() > days * DAY_MS;
}
```

Run: `bun test tests/access.test.ts`
Expected: PASS.

- [ ] **Step 3: Implement `actions/access.ts`**

```ts
"use server";

import { and, eq, isNull, max, sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { recordActivity } from "@/lib/activity";
import { assertNotLastAdmin } from "@/lib/access";
import { requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import {
  invitations,
  projectMembers,
  projects,
  sessions,
  users,
} from "@/lib/db/schema";
import {
  normalizeOrgRole,
  normalizeProjectRole,
  type OrgRole,
  type ProjectRole,
} from "@/lib/permissions";
import type { ActionResponse } from "@/lib/types";
import { uuidSchema } from "@/lib/validation";

export type AccessMatrix = {
  projects: { id: string; key: string; name: string }[];
  users: {
    id: string;
    name: string;
    email: string;
    role: OrgRole;
    banned: boolean;
    lastSeen: string | null;
    memberships: Record<string, ProjectRole>;
  }[];
};

export async function getAccessMatrix(): Promise<AccessMatrix> {
  await requireOrgPermission({ audit: ["read"] });
  const [projectRows, userRows, memberRows, lastSeenRows] = await Promise.all([
    db
      .select({ id: projects.id, key: projects.key, name: projects.name })
      .from(projects)
      .orderBy(projects.key),
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        banned: users.banned,
      })
      .from(users)
      .orderBy(users.name),
    db
      .select({
        userId: projectMembers.userId,
        projectId: projectMembers.projectId,
        role: projectMembers.role,
      })
      .from(projectMembers),
    db
      .select({ userId: sessions.userId, lastSeen: max(sessions.updatedAt) })
      .from(sessions)
      .groupBy(sessions.userId),
  ]);
  const lastSeen = new Map(lastSeenRows.map((r) => [r.userId, r.lastSeen]));
  return {
    projects: projectRows,
    users: userRows.map((u) => {
      const memberships: Record<string, ProjectRole> = {};
      for (const m of memberRows) {
        const role = m.userId === u.id ? normalizeProjectRole(m.role) : null;
        if (role) memberships[m.projectId] = role;
      }
      return {
        ...u,
        banned: u.banned ?? false,
        role: normalizeOrgRole(u.role),
        lastSeen: lastSeen.get(u.id)?.toISOString() ?? null,
        memberships,
      };
    }),
  };
}

async function adminIds(): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.banned, false)));
  return rows.map((r) => r.id);
}

// Remove a leaver's access in one step: ban (blocks every sign-in path, via the
// admin plugin's session hook), drop their sessions, memberships and pending
// invitations. The user row stays so issues and history keep their author.
export async function offboardUser(userId: string): Promise<ActionResponse> {
  const session = await requireOrgPermission({ user: ["offboard"] });
  const t = await getTranslations("access");
  if (!uuidSchema.safeParse(userId).success) {
    return { success: false, message: t("errorInvalidUser") };
  }
  if (userId === session.user.id) {
    return { success: false, message: t("errorSelf") };
  }
  if (!assertNotLastAdmin(await adminIds(), userId, null)) {
    return { success: false, message: t("errorLastAdmin") };
  }
  const [target] = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target) return { success: false, message: t("errorInvalidUser") };

  const removed = await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ banned: true, banReason: "offboarded", updatedAt: new Date() })
      .where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    const memberships = await tx
      .delete(projectMembers)
      .where(eq(projectMembers.userId, userId))
      .returning({ projectId: projectMembers.projectId });
    await tx
      .delete(invitations)
      .where(
        and(
          eq(sql`lower(${invitations.email})`, target.email.toLowerCase()),
          isNull(invitations.acceptedAt)
        )
      );
    return memberships.length;
  });

  await recordActivity({
    actorId: session.user.id,
    action: "user.offboarded",
    entityType: "access",
    entityId: userId,
    data: { user: target.name, memberships: removed },
  });
  revalidatePath("/admin/access");
  return { success: true, message: t("offboarded") };
}
```
- [ ] **Step 4: Last-admin guard and audit on role change**

In `actions/users.ts` `updateUserRole`, after the self-check and the `isOrgRole` validation:

```ts
if (!assertNotLastAdmin(await adminIdsOf(db), input.userId, input.role)) {
  return { success: false, message: t("cannotRemoveLastAdmin") };
}
const [before] = await db
  .select({ role: userTable.role, name: userTable.name })
  .from(userTable)
  .where(eq(userTable.id, input.userId))
  .limit(1);
```

After the update:

```ts
await recordActivity({
  actorId: session.user.id,
  action: "user.roleChanged",
  entityType: "access",
  entityId: input.userId,
  data: { user: before?.name ?? "?", from: before?.role ?? "?", to: role },
});
```

Define `adminIdsOf` locally with the same query as `adminIds()` in `actions/access.ts`. Better: export `adminIds` from `actions/access.ts`, which must then be `async` and server-only (it is), and import it.

`inviteUser` records `action: "user.invited"` with `{ email, role }`.

- [ ] **Step 5: The page**

`app/[locale]/admin/access/page.tsx`:

```tsx
import { setRequestLocale } from "next-intl/server";
import { getAccessMatrix } from "@/actions/access";
import { requireOrgPage } from "@/lib/authz";
import { canOrg } from "@/lib/permissions";
import { AccessClient } from "./access-client";

export default async function AccessPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireOrgPage({ audit: ["read"] });
  const matrix = await getAccessMatrix();
  return (
    <AccessClient
      matrix={matrix}
      now={new Date().toISOString()}
      selfId={session.user.id}
      canEdit={canOrg(session.user.role, { user: ["set-role"] })}
      canOffboard={canOrg(session.user.role, { user: ["offboard"] })}
    />
  );
}
```

`access-client.tsx` must follow `users-client.tsx` conventions: the `@tanstack/react-table` table, the `useDialog` confirm, `toast`, `useOptimistic`. Copy the structure of its users table, but with these columns:
- **Name/email:** banned users show a "Banned" badge, and the row is greyed out.
- **Org role:** a dropdown when `canEdit` and the row is not `selfId`, which calls `updateUserRole`. Otherwise a badge.
- **Last seen:** relative time. An "Inactive" badge appears when `isInactive(lastSeen, now)`.
- **One column per project key:** the cell shows the project role badge or "–".
- **Actions:** an "Offboard" button when `canOffboard`, the row is not banned and it is not self. It goes through a confirm dialog (`t("offboardConfirm", { name })`), then `offboardUser`.

Add filter toggles above the table: "Inactive > 60 days" and "Show banned" (hidden by default).

Cells are **read-only** in v1, and membership edits stay on each project's Members panel. This keeps one write path per relation.

- [ ] **Step 6: Navigation and activity rendering**

- `app/[locale]/admin/page.tsx` redirects to `/admin/access`.
- The sidebar admin group gains an "Access" item (`/admin/access`, icon `ShieldCheck` from lucide-react), gated by `canOrg(orgRole, { audit: ["read"] })`.
- `admin/activity/page.tsx`: add renderers for `user.offboarded`, `user.roleChanged`, `user.invited` and `member.roleChanged`. Follow the existing `memberAdded` pattern: look up `activity.<camelCase>` keys.

- [ ] **Step 7: i18n (all 5 locales)**

Add a new `access` namespace and the activity/users keys:

| Key | en | id | es | zh | ar |
|---|---|---|---|---|---|
| `nav.access` | Access | Akses | Acceso | 访问权限 | الوصول |
| `access.title` | Access | Akses | Acceso | 访问权限 | الوصول |
| `access.subtitle` | Who can reach what, across every project. | Siapa bisa mengakses apa, di semua project. | Quién puede acceder a qué, en todos los proyectos. | 谁可以访问哪些内容（所有项目）。 | من يمكنه الوصول إلى ماذا عبر جميع المشاريع. |
| `access.colUser` | User | Pengguna | Usuario | 用户 | المستخدم |
| `access.colOrgRole` | Org role | Role org | Rol de organización | 组织角色 | دور المؤسسة |
| `access.colLastSeen` | Last seen | Terakhir aktif | Última actividad | 最近活动 | آخر ظهور |
| `access.inactive` | Inactive | Tidak aktif | Inactivo | 不活跃 | غير نشط |
| `access.banned` | Banned | Diblokir | Bloqueado | 已封禁 | محظور |
| `access.filterInactive` | Inactive > 60 days | Tidak aktif > 60 hari | Inactivos > 60 días | 超过 60 天未活动 | غير نشط > 60 يومًا |
| `access.filterBanned` | Show banned | Tampilkan yang diblokir | Mostrar bloqueados | 显示已封禁 | إظهار المحظورين |
| `access.never` | Never | Belum pernah | Nunca | 从未 | أبدًا |
| `access.offboard` | Offboard | Offboard | Dar de baja | 移除访问 | إلغاء الوصول |
| `access.offboardTitle` | Offboard user | Offboard pengguna | Dar de baja al usuario | 移除用户访问 | إلغاء وصول المستخدم |
| `access.offboardConfirm` | Ban {name}, end their sessions and remove all project memberships and pending invitations? | Blokir {name}, akhiri sesinya, dan hapus semua keanggotaan project serta undangan yang tertunda? | ¿Bloquear a {name}, cerrar sus sesiones y quitar todas sus membresías e invitaciones pendientes? | 封禁 {name}，结束其会话并移除所有项目成员资格和待处理邀请？ | حظر {name} وإنهاء جلساته وإزالة جميع عضويات المشاريع والدعوات المعلقة؟ |
| `access.offboarded` | User offboarded | Pengguna di-offboard | Usuario dado de baja | 已移除用户访问 | تم إلغاء وصول المستخدم |
| `access.errorInvalidUser` | Unknown user | Pengguna tidak dikenal | Usuario desconocido | 未知用户 | مستخدم غير معروف |
| `access.errorSelf` | You can't offboard yourself | Kamu tidak bisa meng-offboard diri sendiri | No puedes darte de baja a ti mismo | 不能移除自己的访问权限 | لا يمكنك إلغاء وصولك بنفسك |
| `access.errorLastAdmin` | The last admin can't be removed | Admin terakhir tidak bisa dihapus | No se puede quitar al último administrador | 不能移除最后一位管理员 | لا يمكن إزالة آخر مسؤول |
| `actionErrors.cannotRemoveLastAdmin` | The last admin can't be demoted | Admin terakhir tidak bisa diturunkan | No se puede degradar al último administrador | 不能降级最后一位管理员 | لا يمكن تخفيض آخر مسؤول |
| `activity.userOffboarded` | {actor} offboarded {user} | {actor} meng-offboard {user} | {actor} dio de baja a {user} | {actor} 移除了 {user} 的访问权限 | {actor} ألغى وصول {user} |
| `activity.userRoleChanged` | {actor} changed {user}'s role from {from} to {to} | {actor} mengubah role {user} dari {from} ke {to} | {actor} cambió el rol de {user} de {from} a {to} | {actor} 将 {user} 的角色从 {from} 改为 {to} | {actor} غيّر دور {user} من {from} إلى {to} |
| `activity.userInvited` | {actor} invited {email} as {role} | {actor} mengundang {email} sebagai {role} | {actor} invitó a {email} como {role} | {actor} 邀请 {email} 为 {role} | {actor} دعا {email} بصفة {role} |
| `activity.memberRoleChanged` | {actor} changed {user}'s role on {project} from {from} to {to} | {actor} mengubah role {user} di {project} dari {from} ke {to} | {actor} cambió el rol de {user} en {project} de {from} a {to} | {actor} 将 {user} 在 {project} 的角色从 {from} 改为 {to} | {actor} غيّر دور {user} في {project} من {from} إلى {to} |

- [ ] **Step 8: Run tests, typecheck and lint**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all green.

- [ ] **Step 9: Manual check**

In dev:
1. As admin, open `/admin/access` and check that the matrix renders.
2. Offboard a test user. The row shows Banned, their memberships are gone, and signing in as them fails.
3. Try to demote yourself (blocked) and the last admin (blocked).
4. Check that the activity page shows the entries.

- [ ] **Step 10: Commit**

```bash
git add lib/access.ts tests/access.test.ts actions/access.ts actions/users.ts app components messages
git commit -m "feat(admin): add access matrix, offboarding and access audit trail"
```

---

### Task 10: Rollout to prod (manual, with owner approval at each gate)

**Files:** none committed. The per-person script lives outside the repo, in `~/backups/opsdeck/`.

- [ ] **Step 1: Write the per-person script for review**

Write `~/backups/opsdeck/acl_rollout_20261003.sql` from the roster memory (`dss-team-roster`) and the live `project_members` table:
- `UPDATE users SET role='infra'` for the DevOps engineer.
- `role='member'` for developers who are not platform owners.
- Contributor demotions for QA/BA memberships.
- Offboarding for staff who have left, and for the shared `masterdev@` account if it is unused. Offboarding means ban + delete sessions/memberships, the same statements as `offboardUser`.

**Show the script to the owner and wait for explicit approval.** It changes real people's access.

- [ ] **Step 2: Back up**

```bash
ssh root@192.168.56.113 'mkdir -p /root/backups; docker exec opsdeck-postgres pg_dump -U postgres -Fc -d dss_panel > /root/backups/dss_panel_pre_access_control_$(date +%Y%m%d_%H%M%S).dump'
```

Verify with `docker exec -i opsdeck-postgres pg_restore -l < <file>`, then `scp` the dump to `~/backups/opsdeck/` and compare md5 sums.

- [ ] **Step 3: Migrate, then deploy right away**

```bash
ssh root@192.168.56.113 'docker exec -i opsdeck-postgres psql -U postgres -d dss_panel -v ON_ERROR_STOP=1' < drizzle/20261003000000_access_control/migration.sql
```

Then trigger the Jenkins deploy of the merged branch. During the short gap, the old app floors unknown project roles to viewer, so access only drops.

- [ ] **Step 4: Apply the approved per-person script**

```bash
ssh root@192.168.56.113 'docker exec -i opsdeck-postgres psql -U postgres -d dss_panel -v ON_ERROR_STOP=1' < ~/backups/opsdeck/acl_rollout_20261003.sql
```

- [ ] **Step 5: Verify on prod**

- `curl -s -o /dev/null -w '%{http_code}' http://localhost:80/` on the host returns `200`.
- `/admin/access` matches the intended roster.
- Spot-check that one member sees only their projects.
- Update the memory file `rework-migrations-applied` with the migration name and date.

---

## Self-Review Notes

- **Spec coverage:**
  - Roles and matrices: Task 1. Migration: Task 2. Enforcement API and better-auth wiring: Task 3.
  - Isolation: Task 4. Project writes and routes: Task 5. Org scope and terminal: Task 6.
  - UI: Task 7. Removal of the legacy helpers: Task 8. Access page, offboarding and audit: Task 9. Rollout: Task 10.
  - Spec amendments (`knowledge: manage`, mint-only terminal check, test approach) are recorded in Task 1 Step 5.
- **Security holes closed along the way:**
  - Issue create/update/delete, milestones, labels and test runs had **no** role check: any session could write, including a viewer. Fixed in Task 5.
  - `controlService` had none either, so any session could restart services. Fixed in Task 5.
- **Type names used consistently across tasks:** `OrgRole`, `ProjectRole`, `OrgPermissions`, `ProjectPermissions`, `ProjectScope`, `ProjectAccess`, `requireProjectPermission`, `requireProjectPage`, `requireOrgPermission`, `requireOrgPage`, `routeProjectGuard`, `routeOrgGuard`, `projectScope`, `projectIdsWhere`, `getProjectAccess`, `useProjectCan`.

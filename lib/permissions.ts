// The access model in one place: what each org role and each project role may
// do, as better-auth access-control statements. Pure and client-safe, so the
// server guards (lib/authz) and the button-hiding UI read the same table.
// Roles are defined in code on purpose; admins only assign them.
// See docs/superpowers/specs/2026-10-03-access-control-design.md.

import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";

export const ORG_ROLES = ["admin", "infra", "observer", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PROJECT_ROLES = ["viewer", "qa", "engineer"] as const;
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
  // The Panel instance itself: its backups and updates (Admin → Instance).
  instance: ["manage"],
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
    instance: ["manage"],
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

// What holding engineer on any project adds at org level: the Servers and
// Storage pages, the server terminal and the file explorers, fleet-wide.
// Managing servers, storage connections and tunnels stays with admin/infra.
const engineerOrgGrant = orgAc.newRole({
  server: ["read", "terminal", "files"],
  storage: ["read", "files"],
});

// Project-scoped statements, checked against the effective project role.
const projectStatements = {
  project: ["read"],
  issue: ["write", "delete"],
  mail: ["read", "delete"],
  clock: ["control"],
  database: ["backup", "restore", "create", "drop", "rename"],
  // `restart` alone is the QA subset; `control` adds start and stop.
  service: ["logs", "restart", "control"],
  environment: ["create", "update", "delete"],
  member: ["manage"],
  // Acknowledge a failed run so it leaves Home's "Needs attention" for everyone.
  run: ["acknowledge"],
  // Panel deploys: anyone can see history; only engineers trigger, roll back
  // or edit deploy targets.
  deploy: ["view", "run", "rollback", "configure"],
  // Environment variables (the managed .env): reading includes secret values.
  variable: ["read", "write"],
  // Client releases of legacy artifacts: engineers only; listing needs
  // `deploy: view`, deleting is the org-level `server:manage`.
  release: ["create", "download"],
} as const;

export const projectAc = createAccessControl(projectStatements);

const viewerStatements = {
  project: ["read"],
  service: ["logs"],
  deploy: ["view"],
} as const;

const qaStatements = {
  ...viewerStatements,
  issue: ["write"],
  mail: ["read", "delete"],
  clock: ["control"],
  database: ["backup", "restore"],
  // QA restarts services to retest; start and stop stay with engineers.
  service: ["logs", "restart"],
  run: ["acknowledge"],
} as const;

export const projectRoles = {
  viewer: projectAc.newRole(viewerStatements),
  qa: projectAc.newRole(qaStatements),
  engineer: projectAc.newRole({
    project: ["read"],
    issue: ["write", "delete"],
    mail: ["read", "delete"],
    clock: ["control"],
    database: ["backup", "restore", "create", "drop", "rename"],
    service: ["logs", "restart", "control"],
    environment: ["create", "update", "delete"],
    member: ["manage"],
    run: ["acknowledge"],
    deploy: ["view", "run", "rollback", "configure"],
    variable: ["read", "write"],
    release: ["create", "download"],
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
  qa: 1,
  engineer: 2,
};

export function implicitProjectRole(org: OrgRole): ProjectRole | null {
  if (org === "admin" || org === "infra") return "engineer";
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

// canOrg, plus the engineer grant above for callers who are engineer on at
// least one project. The server guards (lib/authz) and the UI both use it.
export function canOrgAccess(
  orgRole: string | null | undefined,
  projectRoles: readonly ProjectRole[],
  perms: OrgPermissions
): boolean {
  if (canOrg(orgRole, perms)) return true;
  return (
    holdsEngineerAnywhere(orgRole, projectRoles) &&
    engineerOrgGrant.authorize(perms as never).success
  );
}

// Restricted targets (infra-only servers, the instance backup bucket) are
// decided by the org role alone: the engineer grant does not reach them.
export function canOrgAccessTarget(
  orgRole: string | null | undefined,
  projectRoles: readonly ProjectRole[],
  perms: OrgPermissions,
  restricted: boolean
): boolean {
  return restricted
    ? canOrg(orgRole, perms)
    : canOrgAccess(orgRole, projectRoles, perms);
}

export function canProject(
  role: ProjectRole | null,
  perms: ProjectPermissions
): boolean {
  if (!role) return false;
  return projectRoles[role].authorize(perms as never).success;
}

// True when the role holds at least one of the alternatives (each alternative
// is a full request, checked like canProject).
export function canAnyProject(
  role: ProjectRole | null,
  alternatives: ProjectPermissions[]
): boolean {
  return alternatives.some((perms) => canProject(role, perms));
}

// Creating an environment binds it to servers (and their stored credentials),
// so it needs org-level server:manage on top of environment:create on the
// project. Changing an existing environment's bindings needs the same.
export function canCreateEnvironment(
  orgRole: string | null | undefined,
  projectRole: ProjectRole | null
): boolean {
  return (
    canProject(projectRole, { environment: ["create"] }) &&
    canOrg(orgRole, { server: ["manage"] })
  );
}

// What setting up a new environment asks of the caller's project role: the
// environment, its deploy targets and its variables (the setup service and
// the New environment page's guard).
export const SETUP_PERMISSIONS = {
  environment: ["create"],
  deploy: ["configure", "run"],
  variable: ["write"],
} as const satisfies ProjectPermissions;

// Who may put a new environment on a server, by the server's placement policy.
// `restricted` is the rule above, plus one exception: the project's own default
// server admits its engineers without org server:manage. `open` admits project
// engineers (environment:create) without org server:manage, so QA never
// creates environments. Existing environments are never re-checked: placement
// only gates new bindings.
export function canPlaceEnvironment(
  orgRole: string | null | undefined,
  projectRole: ProjectRole | null,
  placement: "restricted" | "open",
  isProjectDefault: boolean
): boolean {
  if (placement === "open" || isProjectDefault) {
    return canProject(projectRole, { environment: ["create"] });
  }
  return canCreateEnvironment(orgRole, projectRole);
}

// Creating a project is for admins (project:create) and for engineers: an org
// role that implies engineer everywhere (infra) counts, as does an explicit
// engineer membership on any project. The creator becomes engineer of the new
// project (see addProject).
export function canCreateProject(
  orgRole: string | null | undefined,
  projectRoles: readonly ProjectRole[]
): boolean {
  if (canOrg(orgRole, { project: ["create"] })) return true;
  return holdsEngineerAnywhere(orgRole, projectRoles);
}

export function holdsEngineerAnywhere(
  orgRole: string | null | undefined,
  projectRoles: readonly ProjectRole[]
): boolean {
  if (effectiveProjectRole(orgRole, null) === "engineer") return true;
  return projectRoles.some(
    (role) => effectiveProjectRole(orgRole, role) === "engineer"
  );
}

// Registering an app activates a repository in the CI server and sets its
// notify secret, so it is for admins (integration:manage) and for engineers
// of any project. A generated pipeline commits its build spec with the
// Panel's forge token, so choosing one needs integration:manage (the New
// environment page registers detection's spec for engineers). Org roles that
// imply engineer on every project (infra) count, as does an explicit engineer
// membership. Retrying a pipeline file commit and secret rotation stay with
// integration:manage.
export function canRegisterApp(
  orgRole: string | null | undefined,
  projectRoles: readonly ProjectRole[]
): boolean {
  if (canOrg(orgRole, { integration: ["manage"] })) return true;
  return holdsEngineerAnywhere(orgRole, projectRoles);
}

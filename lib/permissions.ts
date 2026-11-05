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
  // Acknowledge a failed run so it leaves Home's "Needs attention" for everyone.
  run: ["acknowledge"],
  // Panel deploys: anyone can see history; only maintainers trigger, roll back
  // or edit deploy targets.
  deploy: ["view", "run", "rollback", "configure"],
  // Environment variables (the managed .env): reading includes secret values.
  variable: ["read", "write"],
} as const;

export const projectAc = createAccessControl(projectStatements);

const viewerStatements = {
  project: ["read"],
  service: ["logs"],
  deploy: ["view"],
} as const;

const contributorStatements = {
  ...viewerStatements,
  issue: ["write"],
  mail: ["read", "delete"],
  clock: ["control"],
  database: ["backup", "restore"],
  run: ["acknowledge"],
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
    run: ["acknowledge"],
    deploy: ["view", "run", "rollback", "configure"],
    variable: ["read", "write"],
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

// Who may put a new environment on a server, by the server's placement policy.
// `restricted` is the rule above; `open` admits anyone who may create
// environments in the project or holds contributor and above there. Existing
// environments are never re-checked: placement only gates new bindings.
export function canPlaceEnvironment(
  orgRole: string | null | undefined,
  projectRole: ProjectRole | null,
  placement: "restricted" | "open"
): boolean {
  if (placement === "restricted") {
    return canCreateEnvironment(orgRole, projectRole);
  }
  return (
    canProject(projectRole, { environment: ["create"] }) ||
    projectRole === "contributor" ||
    projectRole === "maintainer"
  );
}

// What an environment's owner (environments.owner_id) may do on that one
// environment, whatever their project role. The owner still needs a project
// role (viewer at least); see canEnvironment.
export const OWNER_PERMISSIONS: ProjectPermissions = {
  deploy: ["view", "run", "rollback", "configure"],
  environment: ["update", "delete"],
  variable: ["read", "write"],
};

// True when every action of the request is among the owner rights. Own-key
// lookups only, so an inherited name such as "toString" never matches.
function ownerCovers(perms: ProjectPermissions): boolean {
  return Object.entries(perms).every(([resource, actions]) => {
    if (!Object.hasOwn(OWNER_PERMISSIONS, resource)) return false;
    const allowed: readonly string[] =
      OWNER_PERMISSIONS[resource as keyof ProjectPermissions] ?? [];
    return (actions ?? []).every((action: string) => allowed.includes(action));
  });
}

// A request on one environment: the project role decides, and the
// environment's owner additionally holds OWNER_PERMISSIONS, never more and
// never without a project role. `isOwner` must be about the environment the
// request targets.
export function canEnvironment(
  role: ProjectRole | null,
  isOwner: boolean,
  perms: ProjectPermissions
): boolean {
  if (!role) return false;
  return canProject(role, perms) || (isOwner && ownerCovers(perms));
}

// Registering an app activates a repository in the CI server and sets its
// notify secret, so it is for admins (integration:manage) and for maintainers
// of any project. Org roles that imply maintainer on every project (infra)
// count, as does an explicit maintainer membership. Generated pipelines,
// pipeline file commits and secret rotation stay with integration:manage.
export function canRegisterApp(
  orgRole: string | null | undefined,
  projectRoles: readonly ProjectRole[]
): boolean {
  if (canOrg(orgRole, { integration: ["manage"] })) return true;
  if (effectiveProjectRole(orgRole, null) === "maintainer") return true;
  return projectRoles.some(
    (role) => effectiveProjectRole(orgRole, role) === "maintainer"
  );
}

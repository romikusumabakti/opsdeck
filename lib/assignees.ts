import { and, eq, exists, inArray, or, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { projectMembers, users as userTable } from "@/lib/db/schema";
import { effectiveProjectRole, ORG_ROLES } from "@/lib/permissions";

// Org roles that reach every project, so they can be assigned anywhere.
export const ORG_WIDE_ASSIGNEE_ROLES = ["admin", "infra"];

// Org roles that can see every project (observers read everything but are not
// assignees, since the viewer set can't work on an issue).
export const ORG_WIDE_VISIBLE_ROLES = ["admin", "infra", "observer"];

// Org roles a membership makes a project visible to (effectiveProjectRole):
// every role but staff. A staff user keeps no project through a leftover
// membership row, and neither does a junk or legacy role string, which floors
// to staff.
export const MEMBERSHIP_VISIBLE_ROLES: string[] = ORG_ROLES.filter(
  (role) => effectiveProjectRole(role, true) !== null
);

// Non-banned users whose org role is one of `orgRoles`, or who hold a
// project_members row matching `projectCond` under a role a membership opens
// projects to. Exact role match on purpose: a junk or legacy role string
// matches neither branch, the same floor normalizeOrgRole applies.
function usersWithProjectWhere(
  orgRoles: string[],
  projectCond: SQL | undefined
) {
  return and(
    eq(userTable.banned, false),
    or(
      inArray(userTable.role, orgRoles),
      and(
        inArray(userTable.role, MEMBERSHIP_VISIBLE_ROLES),
        exists(
          db
            .select({ one: projectMembers.userId })
            .from(projectMembers)
            .where(and(eq(projectMembers.userId, userTable.id), projectCond))
        )
      )
    )
  );
}

// Non-banned users who are org admin/infra (reach every project) or hold a
// project_members row matching `projectCond`. Lives outside
// server/services, where every export is a candidate API endpoint.
export function assignableUsersWhere(projectCond: SQL | undefined) {
  return usersWithProjectWhere(ORG_WIDE_ASSIGNEE_ROLES, projectCond);
}

// Non-banned users who can see a project matching `projectCond`: org
// admin/infra/observer, or a member of it. Notification recipients (mentions)
// must pass this, or a notification would leak an issue's key and title to
// someone who can't open it.
export function projectVisibleUsersWhere(projectCond: SQL | undefined) {
  return usersWithProjectWhere(ORG_WIDE_VISIBLE_ROLES, projectCond);
}

import "server-only";

import { and, eq, exists, inArray, or, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { projectMembers, users as userTable } from "@/lib/db/schema";

// Org roles that reach every project, so they can be assigned anywhere.
export const ORG_WIDE_ASSIGNEE_ROLES = ["admin", "infra"];

// Org roles that can see every project (observers read everything but are not
// assignees, since an implicit viewer can't work on an issue).
export const ORG_WIDE_VISIBLE_ROLES = ["admin", "infra", "observer"];

// Non-banned users whose org role is one of `orgRoles`, or who hold a
// project_members row matching `projectCond`. Exact role match on purpose: a
// junk or legacy role string falls through to the membership branch, the same
// floor normalizeOrgRole applies.
function usersWithProjectWhere(
  orgRoles: string[],
  projectCond: SQL | undefined
) {
  return and(
    eq(userTable.banned, false),
    or(
      inArray(userTable.role, orgRoles),
      exists(
        db
          .select({ one: projectMembers.userId })
          .from(projectMembers)
          .where(and(eq(projectMembers.userId, userTable.id), projectCond))
      )
    )
  );
}

// Non-banned users who are org admin/infra (reach every project) or hold a
// project_members row matching `projectCond`. Lives outside the "use server"
// action files, where every export would be a public endpoint.
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

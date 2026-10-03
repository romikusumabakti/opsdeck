import "server-only";

import { and, eq, exists, inArray, or, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { projectMembers, users as userTable } from "@/lib/db/schema";

// Org roles that reach every project, so they can be assigned anywhere.
export const ORG_WIDE_ASSIGNEE_ROLES = ["admin", "infra"];

// Non-banned users who are org admin/infra (reach every project) or hold a
// project_members row matching `projectCond`. Lives outside the "use server"
// action files, where every export would be a public endpoint.
export function assignableUsersWhere(projectCond: SQL | undefined) {
  return and(
    eq(userTable.banned, false),
    or(
      inArray(userTable.role, ORG_WIDE_ASSIGNEE_ROLES),
      exists(
        db
          .select({ one: projectMembers.userId })
          .from(projectMembers)
          .where(and(eq(projectMembers.userId, userTable.id), projectCond))
      )
    )
  );
}

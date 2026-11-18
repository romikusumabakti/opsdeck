import { desc, eq } from "drizzle-orm";
import { type AccessScope, requireOrgPermissionIn } from "@/lib/access-scope";
import { requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { activityLog, users } from "@/lib/db/schema";

export type ActivityRow = {
  id: string;
  action: string;
  data: Record<string, string | number>;
  actorId: string | null;
  actorName: string | null;
  actorImage: string | null;
  createdAt: Date;
};

/** The org-wide activity feed, newest first (the Activity page). */
export async function listActivity(limit = 100): Promise<ActivityRow[]> {
  await requireOrgPermission({ audit: ["read"] });
  return selectActivity(limit);
}

// The most one read returns: the route's cap on the page's `limit`.
export const ACTIVITY_MAX_LIMIT = 500;

/**
 * listActivity for an explicit scope (the assistant worker has no session).
 * `limit` is clamped to 1..ACTIVITY_MAX_LIMIT; a non-number takes the page's
 * 100.
 */
export async function listActivityFor(
  scope: AccessScope,
  limit: number
): Promise<ActivityRow[]> {
  requireOrgPermissionIn(scope, { audit: ["read"] });
  const rows = Number.isFinite(limit) ? Math.trunc(limit) : 100;
  return selectActivity(Math.min(Math.max(1, rows), ACTIVITY_MAX_LIMIT));
}

async function selectActivity(limit: number): Promise<ActivityRow[]> {
  try {
    const rows = await db
      .select({
        id: activityLog.id,
        action: activityLog.action,
        data: activityLog.data,
        actorId: activityLog.actorId,
        actorName: users.name,
        actorImage: users.image,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .leftJoin(users, eq(users.id, activityLog.actorId))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);
    return rows as ActivityRow[];
  } catch (error) {
    console.error("Failed to list activity:", error);
    return [];
  }
}

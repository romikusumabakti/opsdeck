import { count, desc, eq, gte } from "drizzle-orm";
import { type OrgScope, requireOrgPermissionIn } from "@/lib/access-scope";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { activityLog, users } from "@/lib/db/schema";
import { normalizeOrgRole } from "@/lib/permissions";

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
  const session = await requireSession();
  return listActivityFor(
    { orgRole: normalizeOrgRole(session.user.role) },
    limit
  );
}

// The most one read returns: the route's cap on the page's `limit`.
export const ACTIVITY_MAX_LIMIT = 500;

/**
 * The activity feed for an explicit scope (the page's session role, or the
 * assistant worker's scope): only the job role decides.
 * `limit` is clamped to 1..ACTIVITY_MAX_LIMIT; a non-number takes the page's
 * 100.
 */
export async function listActivityFor(
  scope: OrgScope,
  limit: number
): Promise<ActivityRow[]> {
  requireOrgPermissionIn(scope, { audit: ["read"] });
  const rows = Number.isFinite(limit) ? Math.trunc(limit) : 100;
  return selectActivity(Math.min(Math.max(1, rows), ACTIVITY_MAX_LIMIT));
}

/** How many activity entries were logged at or after `since`. */
export async function countActivitySinceFor(
  scope: OrgScope,
  since: Date
): Promise<number> {
  requireOrgPermissionIn(scope, { audit: ["read"] });
  const [row] = await db
    .select({ total: count() })
    .from(activityLog)
    .where(gte(activityLog.createdAt, since));
  return row?.total ?? 0;
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

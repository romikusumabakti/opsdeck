"use server";

import { desc, eq } from "drizzle-orm";
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

/** The org-wide activity feed, newest first. */
export async function listActivity(limit = 100): Promise<ActivityRow[]> {
  await requireOrgPermission({ audit: ["read"] });
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

import "server-only";

import { db } from "@/lib/db";
import { canOrg } from "@/lib/permissions";
import { effectiveTimeZone } from "@/lib/timezone";
import type { UserCardData } from "@/lib/types";
import { activeStatus } from "@/lib/user-display";

export function jiraProfileUrl(baseUrl: string, accountId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/jira/people/${encodeURIComponent(accountId)}`;
}

/**
 * Profile fields only: no project data, so the card is safe to show to any
 * signed-in user. Deactivated (banned) users are visible to user admins only.
 */
export async function getUserCard(
  id: string,
  viewer: { role?: string | null }
): Promise<UserCardData | null> {
  const user = await db.query.users.findFirst({
    where: { id },
    columns: {
      id: true,
      name: true,
      email: true,
      image: true,
      title: true,
      bio: true,
      role: true,
      timezone: true,
      workingHours: true,
      banned: true,
      statusEmoji: true,
      statusText: true,
      statusExpiresAt: true,
      jiraAccountId: true,
    },
  });
  if (!user) return null;
  if (user.banned && !canOrg(viewer.role, { user: ["list"] })) return null;

  let jiraUrl: string | null = null;
  if (user.jiraAccountId) {
    const conn = await db.query.jiraConnections.findFirst({
      where: { flavor: "cloud" },
      columns: { baseUrl: true },
    });
    if (conn) jiraUrl = jiraProfileUrl(conn.baseUrl, user.jiraAccountId);
  }

  const status = activeStatus(user);
  return {
    id: user.id,
    name: user.name,
    image: user.image,
    email: user.email,
    title: user.title,
    bio: user.bio,
    role: user.role,
    timeZone: effectiveTimeZone(user),
    workingHours: user.workingHours ?? null,
    status: status && { ...status, expiresAt: status.expiresAt?.toISOString() ?? null },
    jiraUrl,
    deactivated: user.banned,
  };
}

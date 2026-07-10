"use server";

import { and, count, desc, eq, isNull } from "drizzle-orm";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { type Notification, notifications } from "@/lib/db/schema";

/** The current user's most recent notifications, newest first. */
export async function listNotifications(): Promise<Notification[]> {
  const session = await requireSession();
  try {
    return await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, session.user.id))
      .orderBy(desc(notifications.createdAt))
      .limit(30);
  } catch (error) {
    console.error("Failed to list notifications:", error);
    return [];
  }
}

/** Count of the current user's unread notifications, for the bell badge. */
export async function getUnreadNotificationCount(): Promise<number> {
  const session = await requireSession();
  try {
    const [row] = await db
      .select({ c: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, session.user.id),
          isNull(notifications.readAt)
        )
      );
    return Number(row?.c ?? 0);
  } catch (error) {
    console.error("Failed to count notifications:", error);
    return 0;
  }
}

export async function markNotificationRead(
  id: string
): Promise<{ success: boolean }> {
  const session = await requireSession();
  try {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(eq(notifications.id, id), eq(notifications.userId, session.user.id))
      );
    return { success: true };
  } catch (error) {
    console.error(`Failed to mark notification ${id} read:`, error);
    return { success: false };
  }
}

export async function markAllNotificationsRead(): Promise<{
  success: boolean;
}> {
  const session = await requireSession();
  try {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, session.user.id),
          isNull(notifications.readAt)
        )
      );
    return { success: true };
  } catch (error) {
    console.error("Failed to mark all notifications read:", error);
    return { success: false };
  }
}

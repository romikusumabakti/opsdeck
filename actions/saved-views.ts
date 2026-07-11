"use server";

import { and, asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { type SavedView, savedViews } from "@/lib/db/schema";

/** The current user's saved issue views, oldest first. */
export async function listSavedViews(): Promise<SavedView[]> {
  const session = await requireSession();
  try {
    return await db
      .select()
      .from(savedViews)
      .where(eq(savedViews.userId, session.user.id))
      .orderBy(asc(savedViews.createdAt));
  } catch (error) {
    console.error("Failed to list saved views:", error);
    return [];
  }
}

export async function createSavedView(
  name: string,
  params: Record<string, string>
): Promise<{ success: boolean }> {
  const session = await requireSession();
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return { success: false };
  try {
    await db
      .insert(savedViews)
      .values({ userId: session.user.id, name: trimmed, params });
    revalidatePath("/issues");
    return { success: true };
  } catch (error) {
    console.error("Failed to create saved view:", error);
    return { success: false };
  }
}

export async function deleteSavedView(
  id: string
): Promise<{ success: boolean }> {
  const session = await requireSession();
  try {
    await db
      .delete(savedViews)
      .where(
        and(eq(savedViews.id, id), eq(savedViews.userId, session.user.id))
      );
    revalidatePath("/issues");
    return { success: true };
  } catch (error) {
    console.error("Failed to delete saved view:", error);
    return { success: false };
  }
}

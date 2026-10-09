"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { recordActivity } from "@/lib/activity";
import { requireSession } from "@/lib/auth-session";
import { requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { isUniqueViolation } from "@/lib/people/names";
import type { ActionResponse } from "@/lib/types";
import {
  PROFILE_LIMITS,
  profileInputSchema,
  statusInputSchema,
  uuidSchema,
} from "@/lib/validation";

// Self-service profile edits. Every action here edits only the caller,
// except adminUpdateProfile, which needs user:update.

export async function updateProfile(input: unknown): Promise<ActionResponse> {
  const session = await requireSession();
  const t = await getTranslations("actionErrors");
  const parsed = profileInputSchema.safeParse(input);
  if (!parsed.success) return { success: false, message: t("invalidInput") };

  try {
    await db
      .update(users)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(users.id, session.user.id));
  } catch (error) {
    if (isUniqueViolation(error)) return { success: false, message: t("nameTaken") };
    throw error;
  }

  await recordActivity({
    actorId: session.user.id,
    action: "profile.updated",
    entityType: "user",
    entityId: session.user.id,
    data: { user: parsed.data.name },
  });
  // Name, timezone and avatar appear in the shell on every page.
  revalidatePath("/", "layout");
  return { success: true, message: t("profileUpdated") };
}

export async function setStatus(input: unknown): Promise<ActionResponse> {
  const session = await requireSession();
  const t = await getTranslations("actionErrors");
  const parsed = statusInputSchema.safeParse(input);
  if (!parsed.success) return { success: false, message: t("invalidInput") };
  const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return { success: false, message: t("statusExpired") };
  }

  await db
    .update(users)
    .set({
      statusEmoji: parsed.data.emoji,
      statusText: parsed.data.text,
      statusExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(users.id, session.user.id));
  revalidatePath("/", "layout");
  return { success: true, message: t("statusUpdated") };
}

export async function clearStatus(): Promise<ActionResponse> {
  const session = await requireSession();
  const t = await getTranslations("actionErrors");
  await db
    .update(users)
    .set({ statusEmoji: null, statusText: null, statusExpiresAt: null, updatedAt: new Date() })
    .where(eq(users.id, session.user.id));
  revalidatePath("/", "layout");
  return { success: true, message: t("statusCleared") };
}

export async function adminUpdateProfile(input: {
  userId: string;
  name: string;
  title: string | null;
}): Promise<ActionResponse> {
  const session = await requireOrgPermission({ user: ["update"] });
  const t = await getTranslations("actionErrors");
  if (!uuidSchema.safeParse(input.userId).success) {
    return { success: false, message: t("invalidInput") };
  }
  const name = input.name.trim();
  const title = input.title?.trim() || null;
  if (!name) return { success: false, message: t("nameRequired") };
  if (name.length > PROFILE_LIMITS.name) return { success: false, message: t("nameTooLong") };
  if (title && title.length > PROFILE_LIMITS.title) return { success: false, message: t("invalidInput") };

  let result: { id: string }[];
  try {
    result = await db
      .update(users)
      .set({ name, title, updatedAt: new Date() })
      .where(eq(users.id, input.userId))
      .returning({ id: users.id });
  } catch (error) {
    if (isUniqueViolation(error)) return { success: false, message: t("nameTaken") };
    throw error;
  }
  if (result.length === 0) return { success: false, message: t("errorGeneric") };

  await recordActivity({
    actorId: session.user.id,
    action: "profile.updated",
    entityType: "user",
    entityId: input.userId,
    data: { user: name },
  });
  revalidatePath("/admin/users");
  revalidatePath(`/people/${input.userId}`);
  return { success: true, message: t("nameUpdated") };
}

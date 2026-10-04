"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recordActivity } from "@/lib/activity";
import { requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { environmentMailpit } from "@/lib/db/schema";
import { environmentName } from "@/lib/environments";
import { getMailpitInfo, MailpitError } from "@/lib/mailpit/client";
import {
  loadMailpitConfig,
  shouldReuseStoredPassword,
} from "@/lib/mailpit/config";
import { encryptSecret } from "@/lib/secrets";
import type { ActionResponse } from "@/lib/types";
import { mailpitSettingsSchema, uuidSchema } from "@/lib/validation";

// Credential-free projection for the settings form.
export type MailpitSettings = {
  url: string;
  username: string | null;
  hasPassword: boolean;
};

export type MailpitTestResult =
  | { success: true; data: { version: string; messages: number } }
  | { success: false; error: string };

export async function getMailpitSettings(
  environmentId: string
): Promise<MailpitSettings | null> {
  await requireProjectPermission(
    { environmentId },
    { environment: ["update"] }
  );
  if (!uuidSchema.safeParse(environmentId).success) return null;
  const cfg = await loadMailpitConfig(environmentId);
  return cfg
    ? {
        url: cfg.url,
        username: cfg.username,
        hasPassword: Boolean(cfg.password),
      }
    : null;
}

export async function saveMailpitSettings(
  environmentId: string,
  data: unknown
): Promise<ActionResponse> {
  const { session } = await requireProjectPermission(
    { environmentId },
    { environment: ["update"] }
  );
  if (!uuidSchema.safeParse(environmentId).success) {
    return { success: false, message: "Invalid environment id" };
  }
  const parsed = mailpitSettingsSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid Mailpit settings" };
  }
  const name = await environmentName(environmentId);
  if (!name) return { success: false, message: "Environment not found" };

  const { url, password } = parsed.data;
  const username = parsed.data.username?.trim() || null;
  try {
    if (!url) {
      const removed = await db
        .delete(environmentMailpit)
        .where(eq(environmentMailpit.environmentId, environmentId))
        .returning({ id: environmentMailpit.environmentId });
      if (removed.length > 0) {
        await recordActivity({
          actorId: session.user.id,
          action: "mailpit.removed",
          entityType: "environment",
          entityId: environmentId,
          data: { environment: name },
        });
      }
    } else {
      // Use the same security guard as testMailpitConnection: only reuse the stored
      // password if the URL equals the stored URL, a username is present, and no
      // new password was typed. This
      // prevents an admin from changing the URL to an attacker's host and retrieving
      // the stored password via Basic Auth.
      const stored = await loadMailpitConfig(environmentId);
      const shouldReuse = shouldReuseStoredPassword(
        { url, username, password },
        stored
      );

      const passwordPatch = !username
        ? { password: null }
        : password
          ? { password: encryptSecret(password) }
          : shouldReuse
            ? {} // Keep the stored password (omit from patch)
            : { password: null };
      await db
        .insert(environmentMailpit)
        .values({ environmentId, url, username, ...passwordPatch })
        .onConflictDoUpdate({
          target: environmentMailpit.environmentId,
          set: { url, username, ...passwordPatch, updatedAt: sql`now()` },
        });
      await recordActivity({
        actorId: session.user.id,
        action: "mailpit.configured",
        entityType: "environment",
        entityId: environmentId,
        data: { environment: name, url },
      });
    }
  } catch (error) {
    console.error(
      `Failed to save Mailpit settings for ${environmentId}:`,
      error
    );
    return { success: false, message: "Failed to save Mailpit settings" };
  }

  // The sidebar's Mail entry reads hasMailpit from the layout-level list.
  revalidatePath("/", "layout");
  return {
    success: true,
    message: url ? "Mailpit settings saved" : "Mailpit disconnected",
  };
}

export async function testMailpitConnection(
  environmentId: string,
  data: unknown
): Promise<MailpitTestResult> {
  await requireProjectPermission(
    { environmentId },
    { environment: ["update"] }
  );
  if (!uuidSchema.safeParse(environmentId).success) {
    return { success: false, error: "Invalid environment id" };
  }
  const parsed = mailpitSettingsSchema.safeParse(data);
  if (!parsed.success || !parsed.data.url) {
    return { success: false, error: "Enter a valid http(s) URL" };
  }
  const input = {
    url: parsed.data.url,
    username: parsed.data.username?.trim() || null,
    password: parsed.data.password,
  };
  const stored = await loadMailpitConfig(environmentId);
  const password = shouldReuseStoredPassword(input, stored)
    ? (stored?.password ?? null)
    : input.password || null;
  try {
    const info = await getMailpitInfo({
      url: input.url,
      username: input.username,
      password,
    });
    return {
      success: true,
      data: { version: info.Version, messages: info.Messages },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof MailpitError ? err.message : "Connection failed",
    };
  }
}

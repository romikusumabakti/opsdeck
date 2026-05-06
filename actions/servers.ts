"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { type NewServer, type Server, servers } from "@/lib/db/schema";
import { testSshConnection } from "@/lib/ssh";

type CreateResponse =
  | { success: true; data: Server; message?: string }
  | { success: false; message: string };

type SimpleResponse =
  | { success: true; message?: string }
  | { success: false; message: string };

export async function getServers(): Promise<Server[]> {
  await requireSession();
  return db.select().from(servers).orderBy(servers.name);
}

export async function getServerById(
  id: number
): Promise<Server | undefined> {
  await requireSession();
  const [row] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);
  return row;
}

export async function createServer(
  data: NewServer
): Promise<CreateResponse> {
  await requireSession();
  const t = await getTranslations("actionErrors");
  try {
    const [created] = await db.insert(servers).values(data).returning();
    revalidatePath("/servers");
    revalidatePath("/projects/new");
    return { success: true, data: created, message: t("serverCreated") };
  } catch (error) {
    console.error("Failed to create server:", error);
    return { success: false, message: t("serverCreateFailed") };
  }
}

export async function updateServer(
  id: number,
  data: Partial<NewServer>
): Promise<SimpleResponse> {
  await requireSession();
  const t = await getTranslations("actionErrors");
  try {
    const [updated] = await db
      .update(servers)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(servers.id, id))
      .returning();
    if (!updated) {
      return { success: false, message: t("serverNotFound") };
    }
    revalidatePath("/servers");
    revalidatePath(`/servers/${id}`);
    revalidatePath("/projects/new");
    return { success: true, message: t("serverUpdated") };
  } catch (error) {
    console.error(`Failed to update server ${id}:`, error);
    return { success: false, message: t("serverUpdateFailed") };
  }
}

/**
 * Probe an SSH connection without persisting anything. Used by the "Test
 * connection" button on server forms. In edit mode, the password may be
 * omitted — we then load the stored password by `serverId`.
 */
export async function testServerConnection(input: {
  host: string;
  username: string;
  password?: string;
  serverId?: number;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  await requireSession();
  const t = await getTranslations("actionErrors");

  const host = input.host.trim();
  const username = input.username.trim();

  if (!host || !username) {
    return { ok: false, message: t("hostAndUsernameRequired") };
  }

  let password = input.password;
  if (!password && input.serverId != null) {
    const [row] = await db
      .select({ password: servers.password })
      .from(servers)
      .where(eq(servers.id, input.serverId))
      .limit(1);
    if (!row) return { ok: false, message: t("serverNotFound") };
    password = row.password;
  }

  if (!password) {
    return { ok: false, message: t("passwordRequiredForTest") };
  }

  return testSshConnection({ host, username, password });
}

export async function deleteServer(id: number): Promise<SimpleResponse> {
  await requireSession();
  const t = await getTranslations("actionErrors");
  try {
    await db.delete(servers).where(eq(servers.id, id));
    revalidatePath("/servers");
    revalidatePath("/projects/new");
    return { success: true, message: t("serverDeleted") };
  } catch (error) {
    // FK violation: server is referenced by at least one project.
    const code = (error as { code?: string })?.code;
    if (code === "23503") {
      return { success: false, message: t("serverInUse") };
    }
    console.error(`Failed to delete server ${id}:`, error);
    return { success: false, message: t("serverDeleteFailed") };
  }
}

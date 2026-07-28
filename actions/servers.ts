"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAdmin, requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import {
  type Environment,
  environmentServices,
  environments,
  type NewServer,
  type Server,
  servers,
} from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { testSshConnection } from "@/lib/ssh";
import { serverInputSchema, serverUpdateSchema } from "@/lib/validation";

export type ServerUsage = {
  // The deployment that uses this server. Field kept named `project` for its UI
  // consumers; it is an `environments` row.
  project: Pick<Environment, "id" | "name">;
  roles: ("db" | "backend" | "frontend")[];
};

export async function getServerUsage(serverId: string): Promise<ServerUsage[]> {
  await requireSession();
  // The server↔environment relationship now lives on environmentServices (one
  // row per role), not a flat FK triple on environments — join through it and
  // fold the per-role rows back into one entry per environment.
  const rows = await db
    .select({
      id: environments.id,
      name: environments.name,
      role: environmentServices.role,
    })
    .from(environmentServices)
    .innerJoin(
      environments,
      eq(environmentServices.environmentId, environments.id)
    )
    .where(eq(environmentServices.serverId, serverId))
    .orderBy(environments.name);

  const usageByEnvironment = new Map<string, ServerUsage>();
  for (const row of rows) {
    let usage = usageByEnvironment.get(row.id);
    if (!usage) {
      usage = { project: { id: row.id, name: row.name }, roles: [] };
      usageByEnvironment.set(row.id, usage);
    }
    if (
      row.role === "db" ||
      row.role === "backend" ||
      row.role === "frontend"
    ) {
      usage.roles.push(row.role);
    }
  }
  return Array.from(usageByEnvironment.values());
}

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

export async function getServerById(id: string): Promise<Server | undefined> {
  await requireSession();
  const [row] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);
  return row;
}

export async function createServer(data: NewServer): Promise<CreateResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const parsed = serverInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: t("invalidInput") };
  }
  try {
    const [created] = await db
      .insert(servers)
      .values({ ...parsed.data, password: encryptSecret(parsed.data.password) })
      .returning();
    revalidatePath("/servers");
    revalidatePath("/projects/new");
    return { success: true, data: created, message: t("serverCreated") };
  } catch (error) {
    console.error("Failed to create server:", error);
    return { success: false, message: t("serverCreateFailed") };
  }
}

export async function updateServer(
  id: string,
  data: Partial<NewServer>
): Promise<SimpleResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const parsed = serverUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: t("invalidInput") };
  }
  // Encrypt the password only when the edit actually supplies one; an omitted
  // password means "keep the stored (already-encrypted) value".
  const patch = { ...parsed.data };
  if (patch.password) patch.password = encryptSecret(patch.password);
  try {
    const [updated] = await db
      .update(servers)
      .set({ ...patch, updatedAt: new Date() })
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
  serverId?: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  await requireAdmin();
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
    password = decryptSecret(row.password);
  }

  if (!password) {
    return { ok: false, message: t("passwordRequiredForTest") };
  }

  return testSshConnection({ host, username, password });
}

export type BulkDeleteServersResult =
  | {
      success: true;
      deleted: number;
      failed: { id: string; message: string }[];
    }
  | { success: false; message: string };

/**
 * Bulk-delete servers by ID. Servers referenced by any project (FK violation,
 * pg code 23503) are skipped and reported back so the caller can surface a
 * partial-success toast — the operation is intentionally not transactional
 * because one in-use server shouldn't block deleting the rest.
 */
export async function bulkDeleteServers(
  ids: string[]
): Promise<BulkDeleteServersResult> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  if (ids.length === 0) {
    return { success: true, deleted: 0, failed: [] };
  }
  let deleted = 0;
  const failed: { id: string; message: string }[] = [];
  for (const id of ids) {
    try {
      const result = await db
        .delete(servers)
        .where(eq(servers.id, id))
        .returning({ id: servers.id });
      if (result.length > 0) {
        deleted += 1;
      } else {
        failed.push({ id, message: t("serverNotFound") });
      }
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "23503") {
        failed.push({ id, message: t("serverInUse") });
        continue;
      }
      console.error(`Failed to delete server ${id}:`, error);
      failed.push({ id, message: t("serverDeleteFailed") });
    }
  }
  revalidatePath("/servers");
  revalidatePath("/projects/new");
  return { success: true, deleted, failed };
}

export async function deleteServer(id: string): Promise<SimpleResponse> {
  await requireAdmin();
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

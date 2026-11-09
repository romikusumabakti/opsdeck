import { eq } from "drizzle-orm";
import { requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import {
  type Environment,
  environmentServices,
  environments,
  type NewServer,
  projects,
  type Server,
  servers,
} from "@/lib/db/schema";
import { decryptNullable, encryptSecret } from "@/lib/secrets";
import { testSshConnection } from "@/lib/ssh";
import { HOST_KEY_CLEARED, type SshTarget } from "@/lib/ssh-connect";
import { ensureCurrentKey, isValidFrom, keyMarker } from "@/lib/ssh-keys";
import type { ActionResponse } from "@/lib/types";
import {
  type ServerInput,
  serverInputSchema,
  serverUpdateSchema,
} from "@/lib/validation";
import { getServerTranslator } from "@/server/i18n";

/**
 * A server as the browser sees it: no password, no host key blobs (only their
 * fingerprints), and what the access UI needs — whether a password is stored,
 * whether the server offered another host key, and the marker of the Panel's
 * authorized_keys line on it.
 */
export type ServerView = Omit<
  Server,
  | "password"
  | "hostKeyType"
  | "hostKey"
  | "hostKeyOfferedType"
  | "hostKeyOffered"
  | "hostKeyOfferedFingerprint"
> & {
  hasPassword: boolean;
  hostKeyMismatch: boolean;
  offeredFingerprint: string | null;
  keyMarker: string | null;
};

export function serverView({
  password,
  hostKeyType: _hostKeyType,
  hostKey: _hostKey,
  hostKeyOfferedType: _hostKeyOfferedType,
  hostKeyOffered: _hostKeyOffered,
  hostKeyOfferedFingerprint,
  ...rest
}: Server): ServerView {
  return {
    ...rest,
    hasPassword: password !== null,
    hostKeyMismatch: hostKeyOfferedFingerprint !== null,
    offeredFingerprint: hostKeyOfferedFingerprint,
    keyMarker:
      rest.auth === "key" && rest.sshKeyId ? keyMarker(rest.sshKeyId) : null,
  };
}

export type ServerUsage = {
  // The environment that uses this server, with the parts needed to link to its
  // readable URL (`/[projectKey]/[envSlug]`).
  environment: Pick<Environment, "id" | "name" | "slug"> & {
    projectKey: string;
    projectName: string;
  };
  roles: ("db" | "backend" | "frontend")[];
};

export async function getServerUsage(serverId: string): Promise<ServerUsage[]> {
  await requireOrgPermission({ server: ["read"] });
  // The server↔environment relationship now lives on environmentServices (one
  // row per role), not a flat FK triple on environments — join through it and
  // fold the per-role rows back into one entry per environment.
  const rows = await db
    .select({
      id: environments.id,
      name: environments.name,
      slug: environments.slug,
      projectKey: projects.key,
      projectName: projects.name,
      role: environmentServices.role,
    })
    .from(environmentServices)
    .innerJoin(
      environments,
      eq(environmentServices.environmentId, environments.id)
    )
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(eq(environmentServices.serverId, serverId))
    .orderBy(environments.name);

  const usageByEnvironment = new Map<string, ServerUsage>();
  for (const row of rows) {
    let usage = usageByEnvironment.get(row.id);
    if (!usage) {
      usage = {
        environment: {
          id: row.id,
          name: row.name,
          slug: row.slug,
          projectKey: row.projectKey,
          projectName: row.projectName,
        },
        roles: [],
      };
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

export async function getServers(): Promise<Server[]> {
  await requireOrgPermission({ server: ["read"] });
  return db.select().from(servers).orderBy(servers.name);
}

export async function getServerById(id: string): Promise<Server | undefined> {
  await requireOrgPermission({ server: ["read"] });
  const [row] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);
  return row;
}

export async function createServer(
  data: ServerInput
): Promise<ActionResponse<Server>> {
  await requireOrgPermission({ server: ["manage"] });
  const t = await getServerTranslator("actionErrors");
  const parsed = serverInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: t("invalidInput") };
  }
  const { auth = "password", password, sshFrom, ...fields } = parsed.data;
  let values: NewServer;
  if (auth === "key") {
    // Installed by hand: the server signs in with the current key, restricted
    // to the from= address its line was written with. No password at all.
    if (password !== undefined) {
      return { success: false, message: t("invalidInput") };
    }
    if (sshFrom === undefined || !isValidFrom(sshFrom)) {
      return { success: false, message: t("invalidFrom") };
    }
    const key = await ensureCurrentKey();
    values = {
      ...fields,
      auth: "key",
      password: null,
      sshKeyId: key.id,
      sshFrom,
    };
  } else {
    if (sshFrom !== undefined) {
      return { success: false, message: t("invalidInput") };
    }
    values = {
      ...fields,
      auth: "password",
      password: password === undefined ? null : encryptSecret(password),
    };
  }
  try {
    const created = one(
      await db.insert(servers).values(values).returning(),
      "server"
    );
    return { success: true, data: created, message: t("serverCreated") };
  } catch (error) {
    console.error("Failed to create server:", error);
    return { success: false, message: t("serverCreateFailed") };
  }
}

export async function updateServer(
  id: string,
  data: Partial<NewServer>
): Promise<ActionResponse> {
  await requireOrgPermission({ server: ["manage"] });
  const t = await getServerTranslator("actionErrors");
  const parsed = serverUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: t("invalidInput") };
  }
  // Encrypt the password only when the edit actually supplies one; an omitted
  // password means "keep the stored (already-encrypted) value".
  const patch = { ...parsed.data };
  if (patch.password) patch.password = encryptSecret(patch.password);
  try {
    const write = (
      tx: Pick<typeof db, "update">,
      reset: Partial<typeof HOST_KEY_CLEARED> = {}
    ) =>
      tx
        .update(servers)
        .set({ ...patch, ...reset, updatedAt: new Date() })
        .where(eq(servers.id, id))
        .returning();
    const newHost = patch.host;
    // A new address never inherits the old pin. The row is locked so a
    // connection pinning the old host's key cannot land in between.
    const [updated] =
      newHost === undefined
        ? await write(db)
        : await db.transaction(async (tx) => {
            const [current] = await tx
              .select({ host: servers.host })
              .from(servers)
              .where(eq(servers.id, id))
              .for("update");
            const moved = current !== undefined && current.host !== newHost;
            return write(tx, moved ? HOST_KEY_CLEARED : {});
          });
    if (!updated) {
      return { success: false, message: t("serverNotFound") };
    }
    return { success: true, message: t("serverUpdated") };
  } catch (error) {
    console.error(`Failed to update server ${id}:`, error);
    return { success: false, message: t("serverUpdateFailed") };
  }
}

/**
 * Probe an SSH connection; nothing is persisted except a first-use host key
 * pin for a saved server. Used by the "Test
 * connection" button on server forms. In edit mode, the password may be
 * omitted — the server is then tested with its stored password or its key,
 * and its host key is verified (or pinned) like any other connection.
 */
export async function testServerConnection(input: {
  host: string;
  username: string;
  password?: string;
  serverId?: string;
  // An unsaved server whose key line was installed by hand.
  auth?: "key";
}): Promise<
  | { ok: true }
  | {
      ok: false;
      message: string;
      code?: "passwordRequired" | "hostKeyMismatch";
    }
> {
  const session = await requireOrgPermission({ server: ["manage"] });
  const t = await getServerTranslator("actionErrors");

  const host = input.host.trim();
  const username = input.username.trim();

  if (!host || !username) {
    return { ok: false, message: t("hostAndUsernameRequired") };
  }

  // A typed password is tested as a password login. Otherwise an existing
  // server is tested the way it signs in (its stored password, or the key).
  const keyOnly = input.auth === "key" && !input.password;
  let target: SshTarget = {
    serverId: null,
    host,
    username,
    password: keyOnly ? null : input.password || null,
    auth: keyOnly ? "key" : "password",
  };
  if (input.serverId != null) {
    const [row] = await db
      .select({
        id: servers.id,
        host: servers.host,
        password: servers.password,
        auth: servers.auth,
      })
      .from(servers)
      .where(eq(servers.id, input.serverId))
      .limit(1);
    if (!row) return { ok: false, message: t("serverNotFound") };
    // A host typed over the stored one is another machine, checked against no
    // pin: the stored password must never be sent to it. The key is fine (it
    // only signs a challenge).
    const sameHost = row.host === host;
    if (!input.password && !sameHost && row.auth === "password") {
      return {
        ok: false,
        code: "passwordRequired",
        message: t("passwordRequired"),
      };
    }
    target = {
      serverId: sameHost ? row.id : null,
      host,
      username,
      password:
        input.password || (sameHost ? decryptNullable(row.password) : null),
      auth: input.password ? "password" : row.auth,
    };
  }

  if (target.auth === "password" && !target.password) {
    return { ok: false, message: t("passwordRequiredForTest") };
  }

  const result = await testSshConnection(target, { actor: session.user.id });
  if (!result.ok && result.code === "hostKeyMismatch") {
    return {
      ok: false,
      code: "hostKeyMismatch",
      message: t("hostKeyMismatch"),
    };
  }
  return result;
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
  await requireOrgPermission({ server: ["manage"] });
  const t = await getServerTranslator("actionErrors");
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
  return { success: true, deleted, failed };
}

export async function deleteServer(id: string): Promise<ActionResponse> {
  await requireOrgPermission({ server: ["manage"] });
  const t = await getServerTranslator("actionErrors");
  try {
    await db.delete(servers).where(eq(servers.id, id));
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

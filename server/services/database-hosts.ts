import { asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { ForbiddenError, requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import {
  type DatabaseHost,
  databaseHosts,
  environmentServices,
  servers,
} from "@/lib/db/schema";
import { loadServerCredentials } from "@/lib/environments";
import { canOrg } from "@/lib/permissions";
import {
  allowedBackupFilename,
  allowedDatabaseName,
  type DatabaseBinding,
} from "@/lib/provisioning/database";
import { findService, type ServiceRole } from "@/lib/services";
import { shq } from "@/lib/sh";
import { executeRemoteCommand } from "@/lib/ssh";
import { uuidSchema } from "@/lib/validation";
import { getServerTranslator } from "@/server/i18n";

// Database hosts: Postgres containers on a server that environments share
// (see lib/provisioning/database). Registering one is fleet-level, so every
// call needs org server:manage.

export const databaseHostInputSchema = z.object({
  serverId: uuidSchema,
  // A container name as docker accepts it; it is shell-quoted anyway.
  containerName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/, "Invalid container name"),
  // Where backups are written, inside the container.
  backupPath: z
    .string()
    .trim()
    .min(2)
    .max(1024)
    .regex(/^\/[^\0\n]*$/, "Backup path must be absolute"),
  label: z.string().trim().min(1).max(200),
});
export type DatabaseHostInput = z.infer<typeof databaseHostInputSchema>;

const VERIFY_TIMEOUT_MS = 15_000;

export async function listDatabaseHosts(
  serverId?: string
): Promise<DatabaseHost[]> {
  await requireOrgPermission({ server: ["manage"] });
  return db
    .select()
    .from(databaseHosts)
    .where(serverId ? eq(databaseHosts.serverId, serverId) : undefined)
    .orderBy(asc(databaseHosts.label));
}

/**
 * Registers a Postgres container as a database host after checking, over
 * SSH, that the superuser can run a query in it (trusted local auth, the
 * same access the database operations use). 404 for an unknown server, 502
 * when the check fails, 409 when the container is already registered.
 */
export async function createDatabaseHost(
  data: DatabaseHostInput
): Promise<DatabaseHost> {
  const session = await requireOrgPermission({ server: ["manage"] });
  const input = databaseHostInputSchema.parse(data);
  const [server] = await db
    .select({ id: servers.id, name: servers.name })
    .from(servers)
    .where(eq(servers.id, input.serverId))
    .limit(1);
  const creds = server ? await loadServerCredentials(server.id) : null;
  if (!(server && creds)) {
    throw new HTTPException(404, { message: "Not Found" });
  }
  const t = await getServerTranslator("actionErrors");
  try {
    await executeRemoteCommand(
      creds,
      `docker exec ${shq(input.containerName)} psql -U postgres -Atc 'select 1'`,
      VERIFY_TIMEOUT_MS
    );
  } catch (error) {
    console.error(
      `Database host check failed on server ${server.id} (${input.containerName}):`,
      error
    );
    throw new HTTPException(502, { message: t("databaseHostUnreachable") });
  }
  const [host] = await db
    .insert(databaseHosts)
    .values(input)
    .onConflictDoNothing()
    .returning();
  if (!host) {
    throw new HTTPException(409, { message: t("databaseHostExists") });
  }
  await recordActivity({
    actorId: session.user.id,
    action: "database_host.create",
    entityType: "server",
    entityId: server.id,
    data: {
      server: server.name,
      container: host.containerName,
      label: host.label,
    },
  });
  return host;
}

/** Deletes a database host; 409 while any environment is bound to it. */
export async function deleteDatabaseHost(id: string): Promise<void> {
  const session = await requireOrgPermission({ server: ["manage"] });
  const [host] = await db
    .select({
      id: databaseHosts.id,
      serverId: databaseHosts.serverId,
      containerName: databaseHosts.containerName,
      label: databaseHosts.label,
      server: servers.name,
    })
    .from(databaseHosts)
    .innerJoin(servers, eq(servers.id, databaseHosts.serverId))
    .where(eq(databaseHosts.id, id))
    .limit(1);
  if (!host) throw new HTTPException(404, { message: "Not Found" });
  const [bound] = await db
    .select({ id: environmentServices.id })
    .from(environmentServices)
    .where(eq(environmentServices.databaseHostId, id))
    .limit(1);
  const inUse = async (): Promise<never> => {
    const t = await getServerTranslator("actionErrors");
    throw new HTTPException(409, { message: t("databaseHostInUse") });
  };
  if (bound) await inUse();
  try {
    await db.delete(databaseHosts).where(eq(databaseHosts.id, id));
  } catch (error) {
    // A binding made since the check: the foreign key refuses the delete.
    const pg = error as { code?: string; cause?: { code?: string } };
    if ((pg.code ?? pg.cause?.code) === "23503") await inUse();
    throw error;
  }
  await recordActivity({
    actorId: session.user.id,
    action: "database_host.delete",
    entityType: "server",
    entityId: host.serverId,
    data: {
      server: host.server,
      container: host.containerName,
      label: host.label,
    },
  });
}

// --- Confinement -----------------------------------------------------------
//
// A shared database binding lives in a container that every environment on
// its host uses. A caller without org server:manage is confined to the
// binding's own databases (lib/provisioning/database#allowedDatabaseName) and
// may not control the container or read its logs.

type WithDbService = {
  id: string;
  services: {
    role: string;
    dbKind: DatabaseBinding["dbKind"];
    dbName: string | null;
  }[];
};

function bindingOf(environment: WithDbService): DatabaseBinding | null {
  const service = findService(environment, "db");
  return service?.dbName
    ? { dbKind: service.dbKind, dbName: service.dbName }
    : null;
}

function canManageServers(orgRole: string | null | undefined): boolean {
  return canOrg(orgRole, { server: ["manage"] });
}

async function confined(): Promise<never> {
  const t = await getServerTranslator("actionErrors");
  throw new ForbiddenError(t("sharedDatabaseConfined"));
}

/** The names among `names` the caller may act on in this environment. */
export function filterAllowedDatabaseNames<T extends { name: string }>(
  environment: WithDbService,
  orgRole: string | null | undefined,
  entries: T[]
): T[] {
  const binding = bindingOf(environment);
  if (!binding) return entries;
  const manage = canManageServers(orgRole);
  return entries.filter((e) => allowedDatabaseName(binding, e.name, manage));
}

/** 403 unless the caller may act on every database in `names`. */
export async function requireAllowedDatabaseNames(
  environment: WithDbService,
  orgRole: string | null | undefined,
  names: string[]
): Promise<void> {
  const binding = bindingOf(environment);
  if (!binding) return;
  const manage = canManageServers(orgRole);
  if (!names.every((n) => allowedDatabaseName(binding, n, manage))) {
    await confined();
  }
}

/** The backup files among `files` the caller may see in this environment. */
export function filterAllowedBackups<T extends { name: string }>(
  environment: WithDbService,
  orgRole: string | null | undefined,
  files: T[]
): T[] {
  const binding = bindingOf(environment);
  if (!binding) return files;
  const manage = canManageServers(orgRole);
  return files.filter((f) => allowedBackupFilename(binding, f.name, manage));
}

/** 403 unless the caller may read backup `filename` of this environment. */
export async function requireAllowedBackup(
  environment: WithDbService,
  orgRole: string | null | undefined,
  filename: string
): Promise<void> {
  const binding = bindingOf(environment);
  if (!binding) return;
  if (!allowedBackupFilename(binding, filename, canManageServers(orgRole))) {
    await confined();
  }
}

/**
 * 403 when `role` is the db service of a shared binding and the caller lacks
 * org server:manage: starting, stopping or restarting that container, or
 * reading its logs, reaches every environment on the host.
 */
export async function requireSharedDbServiceAccess(
  environment: WithDbService,
  orgRole: string | null | undefined,
  role: ServiceRole
): Promise<void> {
  if (role !== "db" || canManageServers(orgRole)) return;
  if (findService(environment, "db")?.dbKind !== "shared") return;
  const t = await getServerTranslator("actionErrors");
  throw new ForbiddenError(t("sharedDatabaseServiceConfined"));
}

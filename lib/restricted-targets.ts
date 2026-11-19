import { and, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-session";
import {
  assertStrongSession,
  callerCanOrgTarget,
  ForbiddenError,
  requireOrgGrant,
  requireOrgPermission,
  requireProjectPermission,
} from "@/lib/authz";
import { db } from "@/lib/db";
import { instanceSettings, s3Connections, servers } from "@/lib/db/schema";
import type { ExplorerSource } from "@/lib/explorer";
import {
  canOrg,
  type OrgPermissions,
  type ProjectPermissions,
} from "@/lib/permissions";
import { notFound } from "@/server/errors";

// Restricted targets: the servers and the bucket the engineer grant does not
// reach (lib/permissions#canOrgAccessTarget). An infra-only server
// (servers.infra_only) and the instance backup destination
// (instance_settings.backup_destination_id), whose objects are full dumps of
// the Panel database.

/** The S3 connection instance backups go to, or null when they stay local. */
export async function backupDestinationId(): Promise<string | null> {
  const [row] = await db
    .select({ id: instanceSettings.backupDestinationId })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Whether an explorer source is a restricted target. An unknown server or
 * connection is not: the explorer then answers it as not found, as before.
 */
export async function isRestrictedSource(
  source: ExplorerSource
): Promise<boolean> {
  if (source.kind === "s3") {
    // Compared in SQL, with the uuid semantics resolveBackend's lookup uses:
    // a JS string compare would let "<UPPERCASE backup id>" through.
    const [row] = await db
      .select({ id: instanceSettings.id })
      .from(instanceSettings)
      .where(
        and(
          eq(instanceSettings.id, 1),
          eq(instanceSettings.backupDestinationId, source.connectionId)
        )
      )
      .limit(1);
    return row !== undefined;
  }
  const [row] = await db
    .select({ infraOnly: servers.infraOnly })
    .from(servers)
    .where(eq(servers.id, source.serverId))
    .limit(1);
  return row?.infraOnly ?? false;
}

/**
 * What an explorer call does to its source: `read` lists, stats, reads and
 * downloads; `write` creates, saves, uploads, deletes, renames, moves, copies
 * or compresses.
 */
export type ExplorerIntent = "read" | "write";

const SERVER_FILES: OrgPermissions = { server: ["files"] };
const STORAGE_FILES: OrgPermissions = { storage: ["files"] };

/**
 * The environment rights an explorer call on that environment's storage
 * connection needs. Listing the connections themselves only takes viewing
 * the environment (server/services/environment-storage), but the objects in
 * an application bucket are the application's data, like its variables: so
 * reading them takes project `variable:read`, the engineer-set statement
 * that reads the environment's secret-bearing data (the managed .env). QA,
 * BA, PM and observer don't hold it. Changing files takes editing the
 * environment's settings (`environment:update`, the right
 * server/services/environments#updateEnvironment checks).
 */
export const ENVIRONMENT_STORAGE_RIGHTS: Record<
  ExplorerIntent,
  ProjectPermissions
> = {
  read: { variable: ["read"] },
  write: { environment: ["update"] },
};

/**
 * The file explorer's whole authorization, for every entry point (the
 * service actions and the archive, download and upload routes), before any
 * credential load or I/O. Throws (401, 403 ForbiddenError, 404).
 *
 * - A server: the org `server:files` permission, then, for a caller who has
 *   it only through the engineer grant, the infra-only check (unchanged).
 * - An S3 connection owned by an environment: that environment's rights
 *   (ENVIRONMENT_STORAGE_RIGHTS by intent) plus a strong sign-in, as every
 *   file explorer needs. An environment the caller can't see is a 404, like
 *   a connection that does not exist.
 * - An unassigned S3 connection, or the instance backup destination wherever
 *   it sits: the org role's own `storage:files` (admin, infra), never the
 *   engineer grant. An unassigned one is a 404 to everyone else (it is not
 *   theirs to know of); the backup destination stays the 403 it always was.
 */
export async function authorizeExplorerSource(
  source: ExplorerSource,
  intent: ExplorerIntent
) {
  if (source.kind === "sftp") {
    const session = await requireOrgPermission(SERVER_FILES);
    // The org role reaches every target; only the grant needs the lookup.
    if (canOrg(session.user.role, SERVER_FILES)) return session;
    const restricted = await isRestrictedSource(source);
    if (!(await callerCanOrgTarget(session, SERVER_FILES, restricted))) {
      throw new ForbiddenError();
    }
    return session;
  }

  const session = await requireSession();
  const [connection] = await db
    .select({ environmentId: s3Connections.environmentId })
    .from(s3Connections)
    .where(eq(s3Connections.id, source.connectionId))
    .limit(1);
  if (!connection) notFound();
  if (await isRestrictedSource(source)) {
    requireOrgGrant(session, STORAGE_FILES);
    return session;
  }
  if (connection.environmentId === null) {
    if (!canOrg(session.user.role, STORAGE_FILES)) notFound();
    requireOrgGrant(session, STORAGE_FILES);
    return session;
  }
  await requireProjectPermission(
    { environmentId: connection.environmentId },
    ENVIRONMENT_STORAGE_RIGHTS[intent]
  );
  assertStrongSession(session);
  return session;
}

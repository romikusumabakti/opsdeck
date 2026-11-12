import { and, eq } from "drizzle-orm";
import {
  callerCanOrgTarget,
  ForbiddenError,
  requireOrgPermission,
} from "@/lib/authz";
import { db } from "@/lib/db";
import { instanceSettings, servers } from "@/lib/db/schema";
import type { ExplorerSource } from "@/lib/explorer";
import { canOrg, type OrgPermissions } from "@/lib/permissions";

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

function filesPermission(source: ExplorerSource): OrgPermissions {
  return source.kind === "s3" ? { storage: ["files"] } : { server: ["files"] };
}

/**
 * The file explorer's whole authorization, for every entry point (the
 * service actions and the archive, download and upload routes), before any
 * credential load or I/O: the files permission of the source's kind, then,
 * for a caller who has it only through the engineer grant, the restricted
 * target check. Throws like requireOrgPermission (401, or a 403
 * ForbiddenError).
 */
export async function authorizeExplorerSource(source: ExplorerSource) {
  const perms = filesPermission(source);
  const session = await requireOrgPermission(perms);
  // The org role reaches every target; only the grant needs the lookup.
  if (canOrg(session.user.role, perms)) return session;
  const restricted = await isRestrictedSource(source);
  if (!(await callerCanOrgTarget(session, perms, restricted))) {
    throw new ForbiddenError();
  }
  return session;
}

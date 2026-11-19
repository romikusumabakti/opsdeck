import { eq } from "drizzle-orm";
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
import { normalizeKeyPrefix, s3BucketKey } from "@/lib/validation";
import { notFound } from "@/server/errors";

// Restricted targets: the servers and the buckets the engineer grant does not
// reach (lib/permissions#canOrgAccessTarget), nor an environment's rights.
// An infra-only server (servers.infra_only), and the places that hold full
// dumps of the Panel database: the backup destination (instance_settings
// backup_s3_*), which is no S3 connection and so never an explorer source,
// but any connection pointing into it (the same bucket name on any
// endpoint, a key prefix inside the destination's or containing it), and the S3 connection
// backups went to before the destination got its own credentials
// (instance_settings.backup_destination_id), until a later release drops it.

/**
 * The S3 connection instance backups went to before the backup destination
 * got its own credentials (legacy backup_destination_id), or null.
 */
export async function backupDestinationId(): Promise<string | null> {
  const [row] = await db
    .select({ id: instanceSettings.backupDestinationId })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  return row?.id ?? null;
}

type S3Location = {
  endpoint: string;
  bucket: string;
  keyPrefix: string | null;
};

/**
 * Whether a bucket location reaches into the backup destination: the same
 * bucket name and one key prefix inside the other (no prefix is the whole
 * bucket, which holds every prefix). The endpoint is deliberately not
 * compared: one store answers under aliases no comparison can enumerate (DNS
 * names, IP literals, proxies), so the same bucket name with an overlapping
 * prefix counts as the destination on any endpoint. Prefixes are compared in
 * their stored form (normalizeKeyPrefix); one that does not normalise counts
 * as the whole bucket.
 */
export function locationsOverlap(a: S3Location, b: S3Location): boolean {
  if (s3BucketKey(a.bucket) !== s3BucketKey(b.bucket)) return false;
  const pa = prefixKey(a.keyPrefix);
  const pb = prefixKey(b.keyPrefix);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

function prefixKey(prefix: string | null): string {
  const normalised = normalizeKeyPrefix(prefix);
  return normalised.ok ? (normalised.prefix ?? "") : "";
}

async function loadRestrictedLocations() {
  const [row] = await db
    .select({
      legacyId: instanceSettings.backupDestinationId,
      endpoint: instanceSettings.backupS3Endpoint,
      bucket: instanceSettings.backupS3Bucket,
      keyPrefix: instanceSettings.backupS3KeyPrefix,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  return {
    legacyId: row?.legacyId ?? null,
    destination:
      row?.endpoint && row.bucket
        ? {
            endpoint: row.endpoint,
            bucket: row.bucket,
            keyPrefix: row.keyPrefix,
          }
        : null,
  };
}

/** Whether a location (an environment's new or moved connection) reaches into the backup destination. */
export async function overlapsBackupDestination(
  location: S3Location
): Promise<boolean> {
  const { destination } = await loadRestrictedLocations();
  return destination !== null && locationsOverlap(location, destination);
}

type S3ConnectionLocation = S3Location & { id: string };

/**
 * The restricted-connection check, loaded once for many rows: whether a
 * connection is the legacy backup destination connection or reaches into
 * the backup destination (locationsOverlap). The rule isRestrictedSource
 * applies, for the pages' isBackupDestination flag.
 */
export async function restrictedConnectionCheck(): Promise<
  (connection: S3ConnectionLocation) => boolean
> {
  const restricted = await loadRestrictedLocations();
  return (connection) =>
    connection.id === restricted.legacyId ||
    (restricted.destination !== null &&
      locationsOverlap(connection, restricted.destination));
}

/**
 * Whether an explorer source is a restricted target. An unknown server or
 * connection is not: the explorer then answers it as not found, as before.
 */
export async function isRestrictedSource(
  source: ExplorerSource
): Promise<boolean> {
  if (source.kind === "s3") {
    // Looked up in SQL, with the uuid semantics resolveBackend's lookup uses;
    // the row's own id is then compared, so "<UPPERCASE id>" is no way round.
    const [[connection], isRestricted] = await Promise.all([
      db
        .select({
          id: s3Connections.id,
          endpoint: s3Connections.endpoint,
          bucket: s3Connections.bucket,
          keyPrefix: s3Connections.keyPrefix,
        })
        .from(s3Connections)
        .where(eq(s3Connections.id, source.connectionId))
        .limit(1),
      restrictedConnectionCheck(),
    ]);
    return connection ? isRestricted(connection) : false;
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
 * - An unassigned S3 connection, or one into the backup destination
 *   wherever it sits (isRestrictedSource): the org role's own `storage:files`
 *   (admin, infra), never the engineer grant nor an environment's rights. An
 *   unassigned one is a 404 to everyone else (it is not theirs to know of); a
 *   restricted one stays the 403 it always was.
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

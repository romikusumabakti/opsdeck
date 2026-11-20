import { and, eq, isNull } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import { requireSession } from "@/lib/auth-session";
import {
  ForbiddenError,
  requireOrgGrant,
  requireProjectPermission,
} from "@/lib/authz";
import { db } from "@/lib/db";
import {
  environmentArchives,
  environments,
  projects,
  type S3Connection,
  type SafeS3Connection,
  s3Connections,
} from "@/lib/db/schema";
import { canOrg, type OrgPermissions } from "@/lib/permissions";
import {
  backupDestinationId,
  isRestrictedSource,
  restrictedConnectionCheck,
} from "@/lib/restricted-targets";
import { CodedHTTPException, notFound } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";

// S3 connections across environments: where an old /storage/<id> link
// leads (getS3ConnectionLocation) and the admin handling of unassigned
// connections (no environment; Admin › Storage), which takes the org role's
// own storage:manage, never the engineer grant. An environment's own
// connections are managed through server/services/environment-storage, the
// only place a connection is created, edited or probed. `secretKey` is
// stripped before any row reaches the client.

const STORAGE_MANAGE: OrgPermissions = { storage: ["manage"] };

// The org role's own storage right, with the strong sign-in a change needs.
async function requireOrgStorage(perms: OrgPermissions) {
  const session = await requireSession();
  requireOrgGrant(session, perms);
  return session;
}

type S3Location = Pick<
  S3Connection,
  | "endpoint"
  | "region"
  | "bucket"
  | "keyPrefix"
  | "accessKeyId"
  | "forcePathStyle"
>;
const LOCATION_FIELDS = [
  "endpoint",
  "region",
  "bucket",
  "keyPrefix",
  "accessKeyId",
  "forcePathStyle",
] as const satisfies readonly (keyof S3Location)[];

/**
 * Whether `next` points a connection anywhere its stored secret was not given
 * for: another endpoint, region, bucket, key prefix, access key or addressing
 * style (an omitted field is unchanged). Such a change, saved or probed, must
 * bring its own secret; otherwise whoever may edit the connection could aim
 * the stored credentials at another bucket, another prefix of the same one,
 * or a host of their own.
 */
export function changesS3Location(
  stored: S3Location,
  next: Partial<S3Location>
): boolean {
  return LOCATION_FIELDS.some(
    (field) => next[field] !== undefined && next[field] !== stored[field]
  );
}

/** The code (and actionErrors key) of that refusal. */
export const SECRET_REQUIRED_FOR_LOCATION_CHANGE =
  "s3SecretRequiredForLocationChange";

/**
 * The client-safe projection of a connection row: no secret.
 * `isBackupDestination` is whether the connection is a restricted target
 * (lib/restricted-targets#restrictedConnectionCheck: the legacy backup
 * destination connection, or one reaching into the backup destination), so
 * the pages hide Edit, Browse, Assign and Delete for it.
 */
export function toSafeS3Connection(
  row: S3Connection,
  restricted: boolean
): SafeS3Connection {
  const { secretKey, ...rest } = row;
  return {
    ...rest,
    hasSecret: secretKey.length > 0,
    isBackupDestination: restricted,
  };
}

/** Many rows, with the restricted check loaded once. */
export async function toSafeS3Connections(
  rows: S3Connection[]
): Promise<SafeS3Connection[]> {
  const isRestricted = await restrictedConnectionCheck();
  return rows.map((row) => toSafeS3Connection(row, isRestricted(row)));
}

/** Where an old /storage/<id> link leads (see getS3ConnectionLocation). */
export type S3ConnectionLocation =
  | { kind: "environment"; projectKey: string; envSlug: string }
  | { kind: "admin" };

/**
 * Where a connection is managed, for the removed global /storage/<id> URLs:
 * its environment (project key and slug) when the caller may view that
 * environment (project:read), Admin › Storage for an unassigned one when the
 * org role holds storage:manage. Everything else, a missing connection
 * included, is the same 404, so the answer reveals nothing of connections
 * the caller can't reach.
 */
export async function getS3ConnectionLocation(
  id: string
): Promise<S3ConnectionLocation> {
  const session = await requireSession();
  const [row] = await db
    .select({
      environmentId: s3Connections.environmentId,
      envSlug: environments.slug,
      projectKey: projects.key,
    })
    .from(s3Connections)
    .leftJoin(environments, eq(environments.id, s3Connections.environmentId))
    .leftJoin(projects, eq(projects.id, environments.projectId))
    .where(eq(s3Connections.id, id))
    .limit(1);
  if (!row) notFound();
  if (row.environmentId === null) {
    if (!canOrg(session.user.role, STORAGE_MANAGE)) notFound();
    return { kind: "admin" };
  }
  try {
    await requireProjectPermission(
      { environmentId: row.environmentId },
      { project: ["read"] }
    );
  } catch (error) {
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }
  if (!row.projectKey || !row.envSlug) notFound();
  return {
    kind: "environment",
    projectKey: row.projectKey,
    envSlug: row.envSlug,
  };
}

/**
 * Refuses (coded 409) deleting a connection something still reads by id:
 * the legacy instance backup destination (backup_destination_id, kept until
 * a later release; `s3BackupDestinationRestricted`) and one old environment
 * archives live in (`s3ConnectionHoldsArchives`: their download and prune
 * resolve it, and the delete would leave them unreachable).
 */
async function refuseNeededConnection(connectionId: string): Promise<void> {
  const [[connection], legacyId] = await Promise.all([
    db
      .select({ id: s3Connections.id })
      .from(s3Connections)
      .where(eq(s3Connections.id, connectionId))
      .limit(1),
    backupDestinationId(),
  ]);
  if (!connection) return;
  if (connection.id === legacyId) {
    throw await conflict("s3BackupDestinationRestricted");
  }
  const [archive] = await db
    .select({ id: environmentArchives.id })
    .from(environmentArchives)
    .where(eq(environmentArchives.s3ConnectionId, connection.id))
    .limit(1);
  if (archive) throw await conflict("s3ConnectionHoldsArchives");
}

async function conflict(code: string): Promise<CodedHTTPException> {
  const t = await getServerTranslator("actionErrors");
  return new CodedHTTPException(409, code, t(code));
}

/** Admin › Storage: the connections no environment owns. */
export async function listUnassignedS3Connections(): Promise<
  SafeS3Connection[]
> {
  await requireOrgStorage(STORAGE_MANAGE);
  const rows = await db
    .select()
    .from(s3Connections)
    .where(isNull(s3Connections.environmentId))
    .orderBy(s3Connections.name);
  return toSafeS3Connections(rows);
}

/**
 * Give an unassigned connection to an environment (404 when either is
 * missing). Refused with a coded 409: a connection an environment already
 * owns (`s3ConnectionAlreadyAssigned`), the instance backup destination,
 * which holds dumps of the Menara database (`s3BackupDestinationNotAssignable`),
 * and a connection old environment archives still live in
 * (`s3ConnectionHoldsArchives`): their download and prune resolve it by id,
 * and an environment's managers could then edit or delete it.
 */
export async function assignS3Connection(
  connectionId: string,
  environmentId: string
): Promise<SafeS3Connection> {
  const session = await requireOrgStorage(STORAGE_MANAGE);
  const [environment] = await db
    .select({ name: environments.name })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!environment) notFound();
  const [current] = await db
    .select({ environmentId: s3Connections.environmentId })
    .from(s3Connections)
    .where(eq(s3Connections.id, connectionId))
    .limit(1);
  if (!current) notFound();
  if (current.environmentId !== null) {
    throw await conflict("s3ConnectionAlreadyAssigned");
  }
  if (await isRestrictedSource({ kind: "s3", connectionId })) {
    throw await conflict("s3BackupDestinationNotAssignable");
  }
  const [archive] = await db
    .select({ id: environmentArchives.id })
    .from(environmentArchives)
    .where(eq(environmentArchives.s3ConnectionId, connectionId))
    .limit(1);
  if (archive) throw await conflict("s3ConnectionHoldsArchives");
  // Still unassigned: a concurrent assignment is not overwritten.
  const [updated] = await db
    .update(s3Connections)
    .set({ environmentId, updatedAt: new Date() })
    .where(
      and(
        eq(s3Connections.id, connectionId),
        isNull(s3Connections.environmentId)
      )
    )
    .returning();
  if (!updated) throw await conflict("s3ConnectionAlreadyAssigned");
  await recordActivity({
    actorId: session.user.id,
    action: "storage.assigned",
    entityType: "s3Connection",
    entityId: updated.id,
    data: { name: updated.name, environment: environment.name },
  });
  // Never restricted: assignment refuses those.
  return toSafeS3Connection(updated, false);
}

/**
 * Delete an unassigned connection (404 for one an environment owns; the
 * coded 409s of refuseNeededConnection).
 */
export async function deleteUnassignedS3Connection(
  connectionId: string
): Promise<void> {
  const session = await requireOrgStorage(STORAGE_MANAGE);
  await refuseNeededConnection(connectionId);
  const [deleted] = await db
    .delete(s3Connections)
    .where(
      and(
        eq(s3Connections.id, connectionId),
        isNull(s3Connections.environmentId)
      )
    )
    .returning({ id: s3Connections.id, name: s3Connections.name });
  if (!deleted) notFound();
  await recordActivity({
    actorId: session.user.id,
    action: "storage.deleted",
    entityType: "s3Connection",
    entityId: deleted.id,
    data: { name: deleted.name, environment: "" },
  });
}

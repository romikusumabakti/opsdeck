import { and, eq, isNull } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import { requireSession } from "@/lib/auth-session";
import { requireOrgGrant, requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import {
  environmentArchives,
  environments,
  type NewS3Connection,
  type S3Connection,
  type SafeS3Connection,
  s3Connections,
} from "@/lib/db/schema";
import { testS3Connection } from "@/lib/explorer/s3";
import type { OrgPermissions } from "@/lib/permissions";
import {
  backupDestinationId,
  isRestrictedSource,
} from "@/lib/restricted-targets";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import type { ActionResponse } from "@/lib/types";
import {
  s3ConnectionInputSchema,
  s3ConnectionUpdateSchema,
} from "@/lib/validation";
import { CodedHTTPException, notFound } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";

// S3-compatible targets for the storage explorer, across environments: the
// global list (until the global Storage pages go) and the admin handling of
// unassigned connections (no environment). Every read and change here takes
// the org role's own storage right (admin, infra; observer reads), never the
// engineer grant: the list spans every environment, including those of
// projects the caller can't see. An environment's own connections are
// managed through server/services/environment-storage. `secretKey` is
// stripped before any row reaches the client.

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

/** The client-safe projection of a connection row: no secret. */
export function toSafeS3Connection(
  row: S3Connection,
  backupId: string | null
): SafeS3Connection {
  const { secretKey, ...rest } = row;
  return {
    ...rest,
    hasSecret: secretKey.length > 0,
    isBackupDestination: row.id === backupId,
  };
}

export async function getS3Connections(): Promise<SafeS3Connection[]> {
  await requireOrgStorage({ storage: ["read"] });
  const [rows, backupId] = await Promise.all([
    db.select().from(s3Connections).orderBy(s3Connections.name),
    backupDestinationId(),
  ]);
  return rows.map((row) => toSafeS3Connection(row, backupId));
}

export async function getS3Connection(
  id: string
): Promise<SafeS3Connection | undefined> {
  await requireOrgStorage({ storage: ["read"] });
  const [[row], backupId] = await Promise.all([
    db.select().from(s3Connections).where(eq(s3Connections.id, id)).limit(1),
    backupDestinationId(),
  ]);
  return row ? toSafeS3Connection(row, backupId) : undefined;
}

export async function createS3Connection(
  data: NewS3Connection
): Promise<ActionResponse<SafeS3Connection>> {
  await requireOrgPermission({ storage: ["manage"] });
  const t = await getServerTranslator("actionErrors");
  const parsed = s3ConnectionInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: t("invalidInput") };
  }
  try {
    const created = one(
      await db
        .insert(s3Connections)
        .values({
          ...parsed.data,
          secretKey: encryptSecret(parsed.data.secretKey),
        })
        .returning(),
      "S3 connection"
    );
    // A new connection is not the backup destination: that is chosen later.
    return {
      success: true,
      data: toSafeS3Connection(created, null),
      message: t("s3Created"),
    };
  } catch (error) {
    console.error("Failed to create S3 connection:", error);
    return { success: false, message: t("s3CreateFailed") };
  }
}

export async function updateS3Connection(
  id: string,
  data: Partial<NewS3Connection>
): Promise<ActionResponse> {
  await requireOrgPermission({ storage: ["manage"] });
  const t = await getServerTranslator("actionErrors");
  const parsed = s3ConnectionUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: t("invalidInput") };
  }
  // Empty/omitted secretKey means "keep the stored one" — drop it from the set
  // — but only while the location stays the one the secret was given for.
  const patch = { ...parsed.data };
  if (!patch.secretKey) {
    const [stored] = await db
      .select()
      .from(s3Connections)
      .where(eq(s3Connections.id, id))
      .limit(1);
    if (!stored) return { success: false, message: t("s3NotFound") };
    if (changesS3Location(stored, patch)) {
      return {
        success: false,
        message: t(SECRET_REQUIRED_FOR_LOCATION_CHANGE),
        code: SECRET_REQUIRED_FOR_LOCATION_CHANGE,
      };
    }
  }
  if (patch.secretKey) patch.secretKey = encryptSecret(patch.secretKey);
  else delete patch.secretKey;
  try {
    const [updated] = await db
      .update(s3Connections)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(s3Connections.id, id))
      .returning();
    if (!updated) {
      return { success: false, message: t("s3NotFound") };
    }
    return { success: true, message: t("s3Updated") };
  } catch (error) {
    console.error(`Failed to update S3 connection ${id}:`, error);
    return { success: false, message: t("s3UpdateFailed") };
  }
}

export async function deleteS3Connection(id: string): Promise<ActionResponse> {
  await requireOrgPermission({ storage: ["manage"] });
  const t = await getServerTranslator("actionErrors");
  try {
    await db.delete(s3Connections).where(eq(s3Connections.id, id));
    return { success: true, message: t("s3Deleted") };
  } catch (error) {
    console.error(`Failed to delete S3 connection ${id}:`, error);
    return { success: false, message: t("s3DeleteFailed") };
  }
}

// Probe a connection without persisting. In edit mode the secret may be omitted;
// the stored one is loaded by id — mirrors testServerConnection — and used
// only with the stored location (changesS3Location).
export async function testS3ConnectionAction(input: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretKey?: string;
  forcePathStyle: boolean;
  connectionId?: string;
}): Promise<{ ok: true } | { ok: false; message: string; code?: string }> {
  await requireOrgPermission({ storage: ["manage"] });
  const t = await getServerTranslator("actionErrors");

  let secretKey = input.secretKey;
  if (!secretKey && input.connectionId != null) {
    const [row] = await db
      .select()
      .from(s3Connections)
      .where(eq(s3Connections.id, input.connectionId))
      .limit(1);
    if (!row) return { ok: false, message: t("s3NotFound") };
    if (
      changesS3Location(row, {
        endpoint: input.endpoint.trim(),
        region: input.region.trim(),
        bucket: input.bucket.trim(),
        accessKeyId: input.accessKeyId.trim(),
        forcePathStyle: input.forcePathStyle,
      })
    ) {
      return {
        ok: false,
        message: t(SECRET_REQUIRED_FOR_LOCATION_CHANGE),
        code: SECRET_REQUIRED_FOR_LOCATION_CHANGE,
      };
    }
    secretKey = decryptSecret(row.secretKey);
  }
  if (!secretKey) {
    return { ok: false, message: t("s3SecretRequiredForTest") };
  }

  return testS3Connection({
    endpoint: input.endpoint.trim(),
    region: input.region.trim(),
    bucket: input.bucket.trim(),
    accessKeyId: input.accessKeyId.trim(),
    secretKey,
    forcePathStyle: input.forcePathStyle,
  });
}

const STORAGE_MANAGE: OrgPermissions = { storage: ["manage"] };

async function conflict(code: string): Promise<CodedHTTPException> {
  const t = await getServerTranslator("actionErrors");
  return new CodedHTTPException(409, code, t(code));
}

/** Admin › Storage: the connections no environment owns. */
export async function listUnassignedS3Connections(): Promise<
  SafeS3Connection[]
> {
  await requireOrgStorage(STORAGE_MANAGE);
  const [rows, backupId] = await Promise.all([
    db
      .select()
      .from(s3Connections)
      .where(isNull(s3Connections.environmentId))
      .orderBy(s3Connections.name),
    backupDestinationId(),
  ]);
  return rows.map((row) => toSafeS3Connection(row, backupId));
}

/**
 * Give an unassigned connection to an environment (404 when either is
 * missing). Refused with a coded 409: a connection an environment already
 * owns (`s3ConnectionAlreadyAssigned`), the instance backup destination,
 * which holds dumps of the Panel database (`s3BackupDestinationNotAssignable`),
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
  return toSafeS3Connection(updated, null);
}

/** Delete an unassigned connection (404 for one an environment owns). */
export async function deleteUnassignedS3Connection(
  connectionId: string
): Promise<void> {
  const session = await requireOrgStorage(STORAGE_MANAGE);
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

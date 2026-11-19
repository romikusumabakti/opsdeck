import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { assertStrongSession, requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import {
  environments,
  type SafeS3Connection,
  s3Connections,
} from "@/lib/db/schema";
import { testS3Connection } from "@/lib/explorer/s3";
import {
  backupDestinationId,
  isRestrictedSource,
  overlapsBackupDestination,
} from "@/lib/restricted-targets";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import {
  type EnvironmentStorageInput,
  type environmentStorageUpdateSchema,
  normalizeKeyPrefix,
} from "@/lib/validation";
import { badRequest, CodedHTTPException, notFound } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";
import {
  changesS3Location,
  SECRET_REQUIRED_FOR_LOCATION_CHANGE,
  toSafeS3Connection,
} from "@/server/services/s3-connections";

// An environment's storage: the S3 connections (application buckets) it owns,
// each optionally confined to a key prefix. Viewing them takes what viewing
// the environment takes (project `project:read`); adding, editing, deleting
// and testing take what editing its settings takes (project
// `environment:update`, as updateEnvironment) plus a strong sign-in, since
// they store or use bucket credentials. An environment the caller can't see,
// and a connection that is not this environment's, are both a 404. Secrets
// are never returned (toSafeS3Connection) and never logged, and a stored
// secret is only ever used with the location it was given for
// (changesS3Location): moving a connection to another endpoint, bucket,
// prefix, access key or addressing style takes a new secret. The instance
// backup destination is never handled here, wherever it sits (409), and no
// connection is added or moved into it (409 s3BackupDestinationOverlap).

const VIEW = { project: ["read"] } as const;
const MANAGE = { environment: ["update"] } as const;

type EnvironmentStorageUpdate = z.infer<typeof environmentStorageUpdateSchema>;

async function requireView(environmentId: string) {
  return requireProjectPermission({ environmentId }, VIEW);
}

async function requireManage(environmentId: string) {
  const access = await requireProjectPermission({ environmentId }, MANAGE);
  assertStrongSession(access.session);
  return access;
}

async function environmentName(environmentId: string): Promise<string> {
  const [row] = await db
    .select({ name: environments.name })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  return row?.name ?? notFound();
}

// The connection, only when it belongs to this environment.
async function ownedConnection(environmentId: string, connectionId: string) {
  const [row] = await db
    .select()
    .from(s3Connections)
    .where(
      and(
        eq(s3Connections.id, connectionId),
        eq(s3Connections.environmentId, environmentId)
      )
    )
    .limit(1);
  return row ?? notFound();
}

// The instance backup destination (dumps of the Panel database) is Admin ›
// Instance's: never edited, deleted or probed as an environment's storage.
async function refuseRestricted(connectionId: string): Promise<void> {
  if (!(await isRestrictedSource({ kind: "s3", connectionId }))) return;
  const t = await getServerTranslator("actionErrors");
  throw new CodedHTTPException(
    409,
    "s3BackupDestinationRestricted",
    t("s3BackupDestinationRestricted")
  );
}

// An environment's connection never points into the instance backup
// destination (same endpoint and bucket, overlapping key prefix): its
// managers could then browse and edit the Panel's dumps.
async function refuseBackupDestinationOverlap(location: {
  endpoint: string;
  bucket: string;
  keyPrefix: string | null;
}): Promise<void> {
  if (!(await overlapsBackupDestination(location))) return;
  const t = await getServerTranslator("actionErrors");
  throw new CodedHTTPException(
    409,
    "s3BackupDestinationOverlap",
    t("s3BackupDestinationOverlap")
  );
}

async function secretRequiredForLocationChange(): Promise<never> {
  const t = await getServerTranslator("actionErrors");
  badRequest(
    t(SECRET_REQUIRED_FOR_LOCATION_CHANGE),
    SECRET_REQUIRED_FOR_LOCATION_CHANGE
  );
}

// The stored form of a typed prefix, or the coded 400.
async function keyPrefixOf(
  input: string | null | undefined
): Promise<string | null> {
  const normalised = normalizeKeyPrefix(input);
  if (normalised.ok) return normalised.prefix;
  const t = await getServerTranslator("actionErrors");
  badRequest(t("s3KeyPrefixInvalid"), "s3KeyPrefixInvalid");
}

export async function listEnvironmentStorage(
  environmentId: string
): Promise<SafeS3Connection[]> {
  await requireView(environmentId);
  const [rows, backupId] = await Promise.all([
    db
      .select()
      .from(s3Connections)
      .where(eq(s3Connections.environmentId, environmentId))
      .orderBy(s3Connections.name),
    backupDestinationId(),
  ]);
  return rows.map((row) => toSafeS3Connection(row, backupId));
}

export async function getEnvironmentStorage(
  environmentId: string,
  connectionId: string
): Promise<SafeS3Connection> {
  await requireView(environmentId);
  const [row, backupId] = await Promise.all([
    ownedConnection(environmentId, connectionId),
    backupDestinationId(),
  ]);
  return toSafeS3Connection(row, backupId);
}

export async function createEnvironmentStorage(
  environmentId: string,
  data: EnvironmentStorageInput
): Promise<SafeS3Connection> {
  const { session } = await requireManage(environmentId);
  const keyPrefix = await keyPrefixOf(data.keyPrefix);
  await refuseBackupDestinationOverlap({ ...data, keyPrefix });
  const environment = await environmentName(environmentId);
  const created = one(
    await db
      .insert(s3Connections)
      .values({
        name: data.name,
        endpoint: data.endpoint,
        region: data.region,
        bucket: data.bucket,
        accessKeyId: data.accessKeyId,
        secretKey: encryptSecret(data.secretKey),
        forcePathStyle: data.forcePathStyle,
        keyPrefix,
        environmentId,
      })
      .returning(),
    "S3 connection"
  );
  await recordActivity({
    actorId: session.user.id,
    action: "storage.created",
    entityType: "s3Connection",
    entityId: created.id,
    data: { name: created.name, environment },
  });
  // A new connection is never the backup destination.
  return toSafeS3Connection(created, null);
}

export async function updateEnvironmentStorage(
  environmentId: string,
  connectionId: string,
  data: EnvironmentStorageUpdate
): Promise<SafeS3Connection> {
  const { session } = await requireManage(environmentId);
  const stored = await ownedConnection(environmentId, connectionId);
  await refuseRestricted(connectionId);
  const { secretKey, keyPrefix: typedPrefix, ...fields } = data;
  // Omitted = unchanged; sent (also blank or null) = set, blank = none.
  const keyPrefix =
    typedPrefix === undefined ? undefined : await keyPrefixOf(typedPrefix);
  if (
    !secretKey &&
    changesS3Location(stored, {
      ...fields,
      ...(keyPrefix === undefined ? {} : { keyPrefix }),
    })
  ) {
    await secretRequiredForLocationChange();
  }
  await refuseBackupDestinationOverlap({
    endpoint: fields.endpoint ?? stored.endpoint,
    bucket: fields.bucket ?? stored.bucket,
    keyPrefix: keyPrefix === undefined ? stored.keyPrefix : keyPrefix,
  });
  const environment = await environmentName(environmentId);
  const [updated] = await db
    .update(s3Connections)
    .set({
      ...fields,
      ...(keyPrefix === undefined ? {} : { keyPrefix }),
      // Empty/omitted secretKey means "keep the stored one".
      ...(secretKey ? { secretKey: encryptSecret(secretKey) } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(s3Connections.id, connectionId),
        eq(s3Connections.environmentId, environmentId)
      )
    )
    .returning();
  if (!updated) notFound();
  await recordActivity({
    actorId: session.user.id,
    action: "storage.updated",
    entityType: "s3Connection",
    entityId: updated.id,
    data: { name: updated.name, environment },
  });
  return toSafeS3Connection(updated, await backupDestinationId());
}

export async function deleteEnvironmentStorage(
  environmentId: string,
  connectionId: string
): Promise<void> {
  const { session } = await requireManage(environmentId);
  await ownedConnection(environmentId, connectionId);
  await refuseRestricted(connectionId);
  const environment = await environmentName(environmentId);
  const [deleted] = await db
    .delete(s3Connections)
    .where(
      and(
        eq(s3Connections.id, connectionId),
        eq(s3Connections.environmentId, environmentId)
      )
    )
    .returning({ id: s3Connections.id, name: s3Connections.name });
  if (!deleted) notFound();
  await recordActivity({
    actorId: session.user.id,
    action: "storage.deleted",
    entityType: "s3Connection",
    entityId: deleted.id,
    data: { name: deleted.name, environment },
  });
}

export type EnvironmentStorageProbe = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretKey?: string;
  forcePathStyle: boolean;
  keyPrefix?: string | null;
  connectionId?: string;
};

/**
 * Probe form values without saving them. In edit mode the secret may be
 * omitted: the stored one is used, but only for a connection of this
 * environment and only with its stored location (else the coded 400). The
 * probe lists under the prefix, as the explorer will.
 */
export async function testEnvironmentStorage(
  environmentId: string,
  input: EnvironmentStorageProbe
): Promise<{ ok: true } | { ok: false; message: string }> {
  await requireManage(environmentId);
  const keyPrefix = await keyPrefixOf(input.keyPrefix);
  const location = {
    endpoint: input.endpoint.trim(),
    region: input.region.trim(),
    bucket: input.bucket.trim(),
    accessKeyId: input.accessKeyId.trim(),
    forcePathStyle: input.forcePathStyle,
    keyPrefix,
  };
  let secretKey = input.secretKey;
  if (input.connectionId !== undefined) {
    const stored = await ownedConnection(environmentId, input.connectionId);
    await refuseRestricted(input.connectionId);
    if (!secretKey) {
      if (changesS3Location(stored, location)) {
        await secretRequiredForLocationChange();
      }
      secretKey = decryptSecret(stored.secretKey);
    }
  }
  if (!secretKey) {
    const t = await getServerTranslator("actionErrors");
    return { ok: false, message: t("s3SecretRequiredForTest") };
  }
  return testS3Connection({ ...location, secretKey });
}

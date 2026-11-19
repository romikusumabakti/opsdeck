import { and, eq } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { type InstanceSettings, instanceSettings } from "@/lib/db/schema";
import { testS3Connection } from "@/lib/explorer/s3";
import {
  type BackupDestinationView,
  backupDestinationView,
  storedBackupDestination as storedDestination,
} from "@/lib/instance-backup/destination";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import {
  type BackupDestinationInput,
  normalizeKeyPrefix,
  normalizeS3Endpoint,
} from "@/lib/validation";
import { badRequest } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";
import { requireInstanceManage } from "@/server/services/instance-backups";
import {
  changesS3Location,
  SECRET_REQUIRED_FOR_LOCATION_CHANGE,
} from "@/server/services/s3-connections";

// Admin › Instance › Backups, "Backup destination": the S3 bucket instance
// backups and the archives of deleted environments go to, with its own
// credentials (instance_settings.backup_s3_*), not an S3 connection, so no
// environment can browse or edit it. Every function takes org
// instance:manage with a strong sign-in (requireInstanceManage), as the rest
// of the instance backup settings. The secret key is stored encrypted
// (encryptSecret), never returned (`secretSet` only) and never logged; a
// stored secret is only ever used with the location it was given for
// (changesS3Location): another endpoint, region, bucket, key prefix, access
// key or addressing style takes the secret again. Clearing it keeps backups
// on this server, as before one was set. The legacy backup_destination_id is
// never written here (expand/contract).

async function settingsRow(): Promise<InstanceSettings> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  // The migration inserts the single row; its absence is a broken install.
  if (!row) throw new Error("instance_settings row 1 is missing");
  return row;
}

// The stored form of the typed location, or the coded 400 for a bad prefix.
async function locationOf(input: BackupDestinationInput) {
  const keyPrefix = normalizeKeyPrefix(input.keyPrefix);
  if (!keyPrefix.ok) {
    const t = await getServerTranslator("actionErrors");
    badRequest(t("s3KeyPrefixInvalid"), "s3KeyPrefixInvalid");
  }
  return {
    endpoint: normalizeS3Endpoint(input.endpoint),
    region: input.region.trim(),
    bucket: input.bucket.trim(),
    accessKeyId: input.accessKeyId.trim(),
    forcePathStyle: input.forcePathStyle,
    keyPrefix: keyPrefix.prefix,
  };
}

async function secretRequiredForLocationChange(): Promise<never> {
  const t = await getServerTranslator("actionErrors");
  badRequest(
    t(SECRET_REQUIRED_FOR_LOCATION_CHANGE),
    SECRET_REQUIRED_FOR_LOCATION_CHANGE
  );
}

export async function getBackupDestination(): Promise<BackupDestinationView | null> {
  await requireInstanceManage();
  return backupDestinationView(await settingsRow());
}

/**
 * Sets the destination. A blank or omitted secret keeps the stored one, but
 * only while every location field stays as stored (else, and when none is
 * stored yet, the coded 400 s3SecretRequiredForLocationChange). The update
 * is conditional on the stored secret being the one checked, so a concurrent
 * change of the location can't pair it with this request's fields.
 */
export async function saveBackupDestination(
  input: BackupDestinationInput
): Promise<BackupDestinationView> {
  const session = await requireInstanceManage();
  const location = await locationOf(input);
  const secretKey = input.secretKey ? input.secretKey : undefined;
  const stored = storedDestination(await settingsRow());
  if (!secretKey && (!stored || changesS3Location(stored, location))) {
    await secretRequiredForLocationChange();
  }
  const [updated] = await db
    .update(instanceSettings)
    .set({
      backupS3Endpoint: location.endpoint,
      backupS3Region: location.region,
      backupS3Bucket: location.bucket,
      backupS3AccessKeyId: location.accessKeyId,
      backupS3ForcePathStyle: location.forcePathStyle,
      backupS3KeyPrefix: location.keyPrefix,
      ...(secretKey ? { backupS3SecretKey: encryptSecret(secretKey) } : {}),
    })
    .where(
      secretKey || !stored
        ? eq(instanceSettings.id, 1)
        : and(
            eq(instanceSettings.id, 1),
            eq(instanceSettings.backupS3SecretKey, stored.secretKey)
          )
    )
    .returning();
  if (!updated) await secretRequiredForLocationChange();
  await recordActivity({
    actorId: session.user.id,
    action: "instance.backupDestinationChanged",
    entityType: "instance",
    data: {
      state: "set",
      endpoint: location.endpoint,
      bucket: location.bucket,
    },
  });
  const view = updated ? backupDestinationView(updated) : null;
  if (!view) throw new Error("the saved backup destination is incomplete");
  return view;
}

/** Removes the destination: backups stay on this server from the next run. */
export async function clearBackupDestination(): Promise<{ success: true }> {
  const session = await requireInstanceManage();
  const wasSet = storedDestination(await settingsRow()) !== null;
  await db
    .update(instanceSettings)
    .set({
      backupS3Endpoint: null,
      backupS3Region: null,
      backupS3Bucket: null,
      backupS3AccessKeyId: null,
      backupS3SecretKey: null,
      backupS3ForcePathStyle: true,
      backupS3KeyPrefix: null,
    })
    .where(eq(instanceSettings.id, 1));
  if (wasSet) {
    await recordActivity({
      actorId: session.user.id,
      action: "instance.backupDestinationChanged",
      entityType: "instance",
      data: { state: "cleared", endpoint: "", bucket: "" },
    });
  }
  return { success: true };
}

/**
 * Probes typed values without saving them, listing under the key prefix as
 * backups will. Without a secret the stored one is used, only for the
 * unchanged stored location (else the coded 400); with none stored, the
 * answer asks for one.
 */
export async function testBackupDestination(
  input: BackupDestinationInput
): Promise<{ ok: true } | { ok: false; message: string }> {
  await requireInstanceManage();
  const location = await locationOf(input);
  let secretKey = input.secretKey ? input.secretKey : undefined;
  if (!secretKey) {
    const stored = storedDestination(await settingsRow());
    if (!stored) {
      const t = await getServerTranslator("actionErrors");
      return { ok: false, message: t("s3SecretRequiredForTest") };
    }
    if (changesS3Location(stored, location)) {
      await secretRequiredForLocationChange();
    }
    secretKey = decryptSecret(stored.secretKey);
  }
  return testS3Connection({ ...location, secretKey });
}

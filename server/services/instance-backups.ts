import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { ForbiddenError, requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import {
  type InstanceBackup,
  instanceBackups,
  instanceSettings,
  s3Connections,
} from "@/lib/db/schema";
import { instanceName, isBackupRunning } from "@/lib/instance-backup/archive";
import {
  type BackupManifest,
  parseManifest,
  secretsKeyFingerprint,
} from "@/lib/instance-backup/manifest";
import { openBackupSource } from "@/lib/instance-backup/restore";
import {
  enqueue,
  INSTANCE_BACKUP_MANUAL_JOB_ID,
  scheduleInstanceBackup,
} from "@/lib/queue";
import { APP_TIMEZONE } from "@/lib/timezone";
import {
  hasPendingRequest,
  readUpdateStatus,
  updaterInstalled,
  writeUpdateRequest,
} from "@/lib/updates/files";
import {
  BACKUP_OBJECT_KEY_RE,
  RELEASE_VERSION_RE,
  UPDATES_DIR,
} from "@/lib/updates/request";
import { CodedHTTPException, notFound } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";

/**
 * Admin → Instance → Backups: the Panel's own backup settings, history and
 * "Back up now". Every function needs org instance:manage (admins only); a
 * refusal is a 403 with code `forbidden`.
 *
 * SECRETS_KEY never leaves this module: only its fingerprint
 * (sha256, 16 hex) is stored, returned or compared.
 */

/** How many runs the history shows. */
export const BACKUP_HISTORY_LIMIT = 50;

export const instanceBackupSettingsSchema = z.object({
  destinationId: z.uuid().nullable(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  keepDaily: z.number().int().min(1).max(90),
  keepWeekly: z.number().int().min(0).max(52),
});
export type InstanceBackupSettingsInput = z.infer<
  typeof instanceBackupSettingsSchema
>;

export const verifyKeySchema = z.object({ key: z.string().min(1).max(1024) });

export type InstanceBackupSettings = InstanceBackupSettingsInput & {
  /** The zone `time` is read in (APP_TIMEZONE). */
  timeZone: string;
  secretsKeyFingerprint: string | null;
};

export type InstanceBackupsPage = {
  /** What a restore's confirmation must be typed as. */
  instance: string;
  settings: InstanceBackupSettings;
  backups: InstanceBackup[];
  /** The S3 connections a backup can go to (no credentials). */
  destinations: { id: string; name: string; bucket: string }[];
};

export async function requireInstanceManage() {
  try {
    return await requireOrgPermission({ instance: ["manage"] });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      throw new ForbiddenError("Forbidden", "forbidden");
    }
    throw error;
  }
}

async function coded(
  status: 400 | 409 | 503,
  code: string
): Promise<CodedHTTPException> {
  const t = await getServerTranslator("instanceBackups.errors");
  return new CodedHTTPException(status, code, t(code));
}

/** A refusal of an update or restore request (messages in instanceUpdates.errors). */
export async function updateRefusal(
  status: 400 | 409 | 503,
  code: string
): Promise<CodedHTTPException> {
  const t = await getServerTranslator("instanceUpdates.errors");
  return new CodedHTTPException(status, code, t(code));
}

async function loadSettingsRow() {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  // The migration inserts the single row; its absence is a broken install.
  if (!row) throw new Error("instance_settings row 1 is missing");
  return row;
}

/** The fingerprint of the key this process runs with, if any. */
function liveFingerprint(): string | null {
  const key = process.env.SECRETS_KEY;
  return key ? secretsKeyFingerprint(key) : null;
}

export async function getInstanceBackups(): Promise<InstanceBackupsPage> {
  await requireInstanceManage();
  const [row, backups, destinations] = await Promise.all([
    loadSettingsRow(),
    db
      .select()
      .from(instanceBackups)
      .orderBy(desc(instanceBackups.startedAt))
      .limit(BACKUP_HISTORY_LIMIT),
    db
      .select({
        id: s3Connections.id,
        name: s3Connections.name,
        bucket: s3Connections.bucket,
      })
      .from(s3Connections)
      .orderBy(s3Connections.name),
  ]);
  return {
    instance: instanceName(),
    settings: {
      destinationId: row.backupDestinationId,
      time: row.backupTime,
      keepDaily: row.backupKeepDaily,
      keepWeekly: row.backupKeepWeekly,
      timeZone: APP_TIMEZONE,
      secretsKeyFingerprint: row.secretsKeyFingerprint ?? liveFingerprint(),
    },
    backups,
    destinations,
  };
}

/** Saves the settings and moves the daily schedule to the new time. */
export async function saveInstanceBackupSettings(
  input: InstanceBackupSettingsInput
): Promise<{ success: true }> {
  await requireInstanceManage();
  if (input.destinationId) {
    const [found] = await db
      .select({ id: s3Connections.id })
      .from(s3Connections)
      .where(eq(s3Connections.id, input.destinationId))
      .limit(1);
    if (!found) throw await coded(400, "backupDestinationNotFound");
  }
  await db
    .update(instanceSettings)
    .set({
      backupDestinationId: input.destinationId,
      backupTime: input.time,
      backupKeepDaily: input.keepDaily,
      backupKeepWeekly: input.keepWeekly,
    })
    .where(eq(instanceSettings.id, 1));
  try {
    await scheduleInstanceBackup(input.time);
  } catch (error) {
    // The settings are saved; the worker re-registers from them on boot.
    console.error("Failed to reschedule the instance backup:", error);
    throw await coded(503, "backupScheduleFailed");
  }
  return { success: true };
}

/** Queues a manual backup; refused while one is running. */
export async function requestInstanceBackup(): Promise<{ queued: true }> {
  await requireInstanceManage();
  if (await isBackupRunning()) throw await coded(409, "backupAlreadyRunning");
  // A fixed job id: a second click while the first still waits is dropped.
  await enqueue(
    "instance/backup.run",
    { trigger: "manual" },
    { jobId: INSTANCE_BACKUP_MANUAL_JOB_ID }
  );
  return { queued: true };
}

/** Dismisses a failed backup from Home's "Needs attention". */
export async function acknowledgeInstanceBackup(
  id: string
): Promise<{ success: true }> {
  await requireInstanceManage();
  const acked = await db
    .update(instanceBackups)
    .set({ acknowledgedAt: new Date() })
    .where(
      and(
        eq(instanceBackups.id, id),
        eq(instanceBackups.status, "failed"),
        isNull(instanceBackups.acknowledgedAt)
      )
    )
    .returning({ id: instanceBackups.id });
  if (acked.length === 0) {
    // Already acknowledged (or not a failure) is fine; unknown is a 404.
    const [exists] = await db
      .select({ id: instanceBackups.id })
      .from(instanceBackups)
      .where(eq(instanceBackups.id, id))
      .limit(1);
    if (!exists) notFound();
  }
  return { success: true };
}

/**
 * Whether `key` is the SECRETS_KEY backups are taken with, by fingerprint.
 * The key is neither stored, logged nor returned.
 */
export async function verifySecretsKey(
  key: string
): Promise<{ match: boolean }> {
  await requireInstanceManage();
  const row = await loadSettingsRow();
  const expected = row.secretsKeyFingerprint ?? liveFingerprint();
  return {
    match: expected !== null && secretsKeyFingerprint(key) === expected,
  };
}

/**
 * Boot: store the running key's fingerprint when none is stored yet, and
 * register the daily schedule from the saved time (schedulers live in Redis,
 * which may have been flushed).
 */
export async function syncInstanceBackupOnBoot(): Promise<void> {
  const row = await loadSettingsRow();
  const fingerprint = liveFingerprint();
  if (!row.secretsKeyFingerprint && fingerprint) {
    await db
      .update(instanceSettings)
      .set({ secretsKeyFingerprint: fingerprint })
      .where(
        and(
          eq(instanceSettings.id, 1),
          isNull(instanceSettings.secretsKeyFingerprint)
        )
      );
  }
  if (process.env.REDIS_URL) await scheduleInstanceBackup(row.backupTime);
}

// --- Restore requests --------------------------------------------------------

export const restoreConfirmSchema = z.object({
  confirm: z.string().max(200),
});

/**
 * The host updater can take a request now: its dir is mounted
 * (`updaterMissing`), no request is waiting and no run is in progress
 * (`updateInProgress`).
 */
export async function assertUpdaterReady(): Promise<void> {
  if (!(await updaterInstalled(UPDATES_DIR))) {
    throw await updateRefusal(503, "updaterMissing");
  }
  const status = await readUpdateStatus(UPDATES_DIR);
  if (status?.state === "running" || (await hasPendingRequest(UPDATES_DIR))) {
    throw await updateRefusal(409, "updateInProgress");
  }
}

/** The manifest of a backup by restore key; null when it cannot be read. */
async function readBackupManifest(key: string): Promise<BackupManifest | null> {
  const scratch = await mkdtemp(join(tmpdir(), "opsdeck-manifest-"));
  try {
    const source = await openBackupSource(key);
    return parseManifest(await source.readManifest(scratch));
  } catch {
    return null;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Asks the host updater to restore a backup, after the typed confirmation
 * (the instance name) and the checks the restore itself would refuse on:
 * the manifest can be read, its version can run, and it was taken with this
 * SECRETS_KEY. The updater takes a safety backup first, then stops the app.
 */
export async function submitRestoreRequest(
  backup: { location: "s3" | "local"; objectKey: string },
  confirm: string
): Promise<{ requested: true }> {
  const session = await requireInstanceManage();
  if (confirm !== instanceName()) {
    throw await updateRefusal(400, "confirmMismatch");
  }
  await assertUpdaterReady();
  const key =
    backup.location === "local"
      ? `local:${backup.objectKey}`
      : backup.objectKey;
  if (!BACKUP_OBJECT_KEY_RE.test(key)) {
    throw await updateRefusal(409, "restoreNotFound");
  }
  const manifest = await readBackupManifest(key);
  if (!manifest) throw await updateRefusal(409, "restoreNotFound");
  if (!RELEASE_VERSION_RE.test(manifest.version)) {
    throw await updateRefusal(409, "restoreVersionMismatch");
  }
  if (liveFingerprint() !== manifest.secretsKeyFingerprint) {
    throw await updateRefusal(409, "restoreKeyMismatch");
  }
  await writeUpdateRequest(UPDATES_DIR, {
    action: "restore",
    objectKey: key,
    version: manifest.version,
    requestedBy: session.user.id,
    requestedAt: new Date().toISOString(),
  });
  return { requested: true };
}

/** Restore from Admin → Instance → Backups: a succeeded backup in the history. */
export async function requestInstanceRestore(
  id: string,
  confirm: string
): Promise<{ requested: true }> {
  await requireInstanceManage();
  const [row] = await db
    .select({
      status: instanceBackups.status,
      location: instanceBackups.location,
      objectKey: instanceBackups.objectKey,
    })
    .from(instanceBackups)
    .where(eq(instanceBackups.id, id))
    .limit(1);
  if (!row) notFound();
  if (row.status !== "succeeded" || !row.objectKey) {
    throw await updateRefusal(409, "restoreNotFound");
  }
  return submitRestoreRequest(
    { location: row.location, objectKey: row.objectKey },
    confirm
  );
}

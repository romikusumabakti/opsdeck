// The app's only channel to the host updater (ops/install/update.sh, root).
// The app writes `request.json` into the bind-mounted updates dir; the host
// writes `status.json` back. update.sh has no JSON parser: it accepts a
// request only when the whole file is the exact single line that
// serializeUpdateRequest produces, so always write requests through it.
import { z } from "zod";

export const UPDATES_DIR = "/var/lib/opsdeck/updates";
export const REQUEST_FILE = "request.json";
export const STATUS_FILE = "status.json";

/** A release version without the tag's `v`; update.sh uses the same pattern. */
export const RELEASE_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$/;

/**
 * A backup to restore: an S3 object prefix (`opsdeck-backups/<instance>/<name>/`)
 * or `local:<instance>/<name>/` for a copy in the host's backups dir. No `..`,
 * no leading `-` (it becomes an argv of `opsdeck restore`).
 */
export const BACKUP_OBJECT_KEY_RE =
  /^(?!.*\.\.)(local:)?[A-Za-z0-9_][A-Za-z0-9._/-]{0,510}$/;

const version = z.string().regex(RELEASE_VERSION_RE);
const requestedBy = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const requestedAt = z
  .string()
  .regex(
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$/
  );

export const updateRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("update"),
    version,
    requestedBy,
    requestedAt,
  }),
  z.strictObject({
    action: z.literal("restore"),
    objectKey: z.string().regex(BACKUP_OBJECT_KEY_RE),
    /** The version in the backup's manifest; the restore runs under it. */
    version,
    requestedBy,
    requestedAt,
  }),
]);

export type UpdateRequest = z.infer<typeof updateRequestSchema>;

/**
 * Contract of `opsdeck restore <objectKey>` (Task 7) with update.sh, which
 * runs it as `docker compose run --rm --no-deps app opsdeck restore <key>`:
 * - It prints one JSON line with an `errorCode` (string or null).
 * - Exit 0: restored.
 * - Exit RESTORE_REFUSED_EXIT (3): refused, and the database and Garage are
 *   untouched. Every check runs before any write: the archive can be read
 *   (`restoreNotFound`), the manifest sha256 (`restoreChecksumMismatch`), the
 *   SECRETS_KEY fingerprint (`restoreKeyMismatch`), and the manifest version
 *   equals the requested one (`restoreVersionMismatch`). update.sh then puts
 *   the previous images back: rolled_back with that code (another code
 *   becomes `restoreRefused`).
 * - Any other non-zero exit: the data may have changed. update.sh keeps the
 *   restore version and reports failed/`restoreFailed` with `safetyBackup`.
 */
export const RESTORE_REFUSED_EXIT = 3;

/**
 * The canonical file content update.sh accepts: one line, keys in this exact
 * order. Throws (ZodError) for a request the updater would refuse.
 */
export function serializeUpdateRequest(input: UpdateRequest): string {
  const r = updateRequestSchema.parse(input);
  const canonical =
    r.action === "update"
      ? {
          action: r.action,
          version: r.version,
          requestedBy: r.requestedBy,
          requestedAt: r.requestedAt,
        }
      : {
          action: r.action,
          objectKey: r.objectKey,
          version: r.version,
          requestedBy: r.requestedBy,
          requestedAt: r.requestedAt,
        };
  return `${JSON.stringify(canonical)}\n`;
}

export const UPDATE_STEPS = [
  "validate",
  "backup",
  "pull",
  "restore",
  "migrate",
  "up",
  "health",
  "rollback",
  "done",
] as const;

export const UPDATE_STATES = [
  "running",
  "succeeded",
  "failed",
  "rolled_back",
  "refused",
] as const;

/** Codes update.sh writes; `code` stays a string so a newer updater's codes parse. */
export const UPDATE_STATUS_CODES = [
  // refused: nothing was changed
  "invalidRequest",
  "invalidInstall",
  "invalidRelease",
  "releaseNotFound",
  "belowMinFrom",
  "downgrade",
  "backupTooNew",
  // failed: nothing was changed (download) or the pre-update/restore backup failed
  "releaseUnavailable",
  "backupFailed",
  // rolled_back: the previous images run again
  "pullFailed",
  "stopFailed",
  "migrateFailed",
  "upFailed",
  "healthFailed",
  // rolled_back: `opsdeck restore` refused (exit 3) before any write
  "restoreChecksumMismatch",
  "restoreKeyMismatch",
  "restoreNotFound",
  "restoreVersionMismatch",
  "restoreRefused",
  // rolled_back after a signal (`interrupted`) or an updater bug (`updaterError`);
  // failed with these when it stopped before anything changed
  "interrupted",
  "updaterError",
  // failed: the restore ran but the panel is not healthy on its version;
  // `safetyBackup` undoes it
  "restoreFailed",
  // failed: needs an operator
  "rollbackFailed",
] as const;

export type UpdateStatusCode = (typeof UPDATE_STATUS_CODES)[number];

const isoSeconds = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);

export const updateStatusSchema = z.object({
  runId: z.string().min(1),
  /** null when the request itself could not be read. */
  action: z.enum(["update", "restore"]).nullable(),
  /** The requested version (restore: the backup's manifest version). */
  version: version.nullable(),
  /**
   * OPSDECK_VERSION running before the current phase: when the run started,
   * or the restored version once a restore continues into an update.
   */
  from: version.nullable(),
  step: z.enum(UPDATE_STEPS),
  state: z.enum(UPDATE_STATES),
  code: z.string().nullable(),
  startedAt: isoSeconds,
  finishedAt: isoSeconds.nullable(),
  /**
   * A restore whose backup is in place and healthy under its version, before
   * the update to the newer running version (which may still roll back).
   */
  restored: z.boolean().optional(),
  /** The backup a restore took first (trigger `restore`), to undo it. */
  safetyBackup: z
    .object({
      id: z.string().nullable(),
      location: z.enum(["local", "s3"]),
      objectKey: z.string(),
    })
    .optional(),
  /** The last lines of updates/logs/<runId>.log. */
  logTail: z.array(z.string()),
});

export type UpdateStatus = z.infer<typeof updateStatusSchema>;

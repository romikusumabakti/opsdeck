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
  // failed: nothing was changed (download) or the pre-update backup failed
  "releaseUnavailable",
  "backupFailed",
  // rolled_back: the previous images run again
  "pullFailed",
  "restoreFailed",
  "migrateFailed",
  "upFailed",
  "healthFailed",
  // failed: needs an operator
  "rollbackFailed",
  "updaterError",
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
  /** OPSDECK_VERSION running when the run started. */
  from: version.nullable(),
  step: z.enum(UPDATE_STEPS),
  state: z.enum(UPDATE_STATES),
  code: z.string().nullable(),
  startedAt: isoSeconds,
  finishedAt: isoSeconds.nullable(),
  /** The last lines of updates/logs/<runId>.log. */
  logTail: z.array(z.string()),
});

export type UpdateStatus = z.infer<typeof updateStatusSchema>;

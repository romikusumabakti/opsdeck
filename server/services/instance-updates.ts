import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { instanceSettings } from "@/lib/db/schema";
import { instanceName } from "@/lib/instance-backup/archive";
import { APP_TIMEZONE } from "@/lib/timezone";
import {
  hasPendingRequest,
  readUpdateStatus,
  updaterInstalled,
  writeUpdateRequest,
} from "@/lib/updates/files";
import {
  type AvailableRelease,
  checkForUpdate,
  type UpdateChannel,
} from "@/lib/updates/releases";
import {
  RELEASE_VERSION_RE,
  UPDATES_DIR,
  type UpdateStatus,
} from "@/lib/updates/request";
import { compareVersions, OPSDECK_VERSION, parseVersion } from "@/lib/version";
import {
  assertUpdaterReady,
  requireInstanceManage,
  submitRestoreRequest,
  updateRefusal,
} from "@/server/services/instance-backups";

/**
 * Admin → Instance → Updates: the running version, the release available on
 * the instance's channel, the updater's status, and the requests the app may
 * write for the host updater (ops/install/update.sh). Every function needs
 * org instance:manage, like the backups page.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const updateSettingsSchema = z.object({
  channel: z.enum(["stable", "beta"]),
  autoUpdate: z.boolean(),
  window: hhmm,
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const applyUpdateSchema = z.object({
  version: z.string().regex(RELEASE_VERSION_RE),
});

/** The requestedBy of the requests the auto-update job writes. */
export const AUTO_UPDATE_REQUESTER = "auto-update";

/** How long the auto-update window stays open after its start. */
export const AUTO_UPDATE_WINDOW_MINUTES = 60;

export type InstanceUpdatesPage = {
  current: string;
  /** What a restore's confirmation must be typed as. */
  instance: string;
  channel: UpdateChannel;
  autoUpdate: boolean;
  /** HH:MM, the start of the hour auto-updates run in. */
  window: string;
  timeZone: string;
  available: AvailableRelease | null;
  /** `updateCheckFailed` when GitHub could not be read (available is the last known). */
  checkError: string | null;
  checkedAt: Date | null;
  /** Whether the updater's dir is mounted; the code `updaterMissing` otherwise. */
  updaterInstalled: boolean;
  /** A request the updater has not picked up yet. */
  pending: boolean;
  /** The updater's last status.json. */
  status: UpdateStatus | null;
  /**
   * Auto-update is on but leaves `available` alone: its last run did not
   * succeed, so an admin applies it by hand.
   */
  autoUpdateSkipped: boolean;
};

/** The last run updated to `version` and did not succeed (nor is running). */
function lastRunFailedFor(
  status: UpdateStatus | null,
  version: string
): boolean {
  return (
    status?.action === "update" &&
    status.version === version &&
    status.state !== "succeeded" &&
    status.state !== "running"
  );
}

async function loadSettings() {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  if (!row) throw new Error("instance_settings row 1 is missing");
  return row;
}

/**
 * The Updates tab's data. `force` re-reads the releases now instead of the
 * hourly cached result (the "Check now" button).
 */
export async function getInstanceUpdates(
  opts: { force?: boolean } = {}
): Promise<InstanceUpdatesPage> {
  await requireInstanceManage();
  const row = await loadSettings();
  const [check, installed] = await Promise.all([
    checkForUpdate(
      row.updateChannel,
      OPSDECK_VERSION,
      opts.force ? { force: true } : undefined
    ),
    updaterInstalled(UPDATES_DIR),
  ]);
  const status = installed ? await readUpdateStatus(UPDATES_DIR) : null;
  return {
    current: OPSDECK_VERSION,
    instance: instanceName(),
    channel: row.updateChannel,
    autoUpdate: row.autoUpdate,
    window: row.autoUpdateWindow,
    timeZone: APP_TIMEZONE,
    available: check.available,
    checkError: check.error,
    checkedAt: check.checkedAt,
    updaterInstalled: installed,
    pending: installed && (await hasPendingRequest(UPDATES_DIR)),
    status,
    autoUpdateSkipped:
      row.autoUpdate &&
      check.available !== null &&
      lastRunFailedFor(status, check.available.version),
  };
}

export async function saveInstanceUpdateSettings(
  input: UpdateSettingsInput
): Promise<{ success: true }> {
  await requireInstanceManage();
  await db
    .update(instanceSettings)
    .set({
      updateChannel: input.channel,
      autoUpdate: input.autoUpdate,
      autoUpdateWindow: input.window,
    })
    .where(eq(instanceSettings.id, 1));
  return { success: true };
}

/** The current version cannot update to `release` directly. */
function belowMinFrom(release: AvailableRelease): boolean {
  return (
    parseVersion(OPSDECK_VERSION) !== null &&
    compareVersions(OPSDECK_VERSION, release.minFrom) < 0
  );
}

/** Asks the updater for the available version (only that one). */
export async function applyInstanceUpdate(
  version: string
): Promise<{ requested: true }> {
  const session = await requireInstanceManage();
  const row = await loadSettings();
  const { available } = await checkForUpdate(
    row.updateChannel,
    OPSDECK_VERSION
  );
  if (!available || available.version !== version) {
    throw await updateRefusal(409, "updateNotAvailable");
  }
  if (belowMinFrom(available)) throw await updateRefusal(409, "belowMinFrom");
  await assertUpdaterReady();
  await writeUpdateRequest(UPDATES_DIR, {
    action: "update",
    version,
    requestedBy: session.user.id,
    requestedAt: new Date().toISOString(),
  });
  return { requested: true };
}

/**
 * Undoes a restore that failed (status restoreFailed): restores the safety
 * backup the updater took first. Its instance_backups row went away with the
 * restored database, so it is named by the status file.
 */
export async function restoreSafetyBackup(
  confirm: string
): Promise<{ requested: true }> {
  await requireInstanceManage();
  const status = (await updaterInstalled(UPDATES_DIR))
    ? await readUpdateStatus(UPDATES_DIR)
    : null;
  if (
    !status?.safetyBackup ||
    status.state !== "failed" ||
    status.code !== "restoreFailed"
  ) {
    throw await updateRefusal(409, "restoreNotFound");
  }
  return submitRestoreRequest(status.safetyBackup, confirm);
}

/** Minutes since midnight of `at` in `timeZone`. */
function minutesIn(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/** `at` falls in [window, window + 60 min) in the instance time zone. */
export function inAutoUpdateWindow(
  at: Date,
  window: string,
  timeZone: string = APP_TIMEZONE
): boolean {
  const [h, m] = window.split(":").map(Number);
  const start = (h ?? 0) * 60 + (m ?? 0);
  const since = (minutesIn(at, timeZone) - start + 24 * 60) % (24 * 60);
  return since < AUTO_UPDATE_WINDOW_MINUTES;
}

/**
 * The hourly instance-update-check job: refreshes the release check and, when
 * auto-update is on, writes an update request for the available version
 * inside the window. Never while a run is in progress or a request waits,
 * and not again for a version whose last run did not succeed (an admin
 * applies that one by hand).
 */
export async function runInstanceUpdateCheck(
  now: Date = new Date()
): Promise<{ requested: string | null }> {
  const row = await loadSettings();
  const check = await checkForUpdate(row.updateChannel, OPSDECK_VERSION, {
    force: true,
    now,
  });
  if (check.error) console.warn(`Instance update check: ${check.error}`);
  const available = check.available;
  if (!row.autoUpdate || !available) return { requested: null };
  if (!inAutoUpdateWindow(now, row.autoUpdateWindow)) {
    return { requested: null };
  }
  if (belowMinFrom(available)) return { requested: null };
  if (!(await updaterInstalled(UPDATES_DIR))) return { requested: null };
  if (await hasPendingRequest(UPDATES_DIR)) return { requested: null };
  const status = await readUpdateStatus(UPDATES_DIR, now);
  if (status?.state === "running") return { requested: null };
  if (lastRunFailedFor(status, available.version)) return { requested: null };
  await writeUpdateRequest(UPDATES_DIR, {
    action: "update",
    version: available.version,
    requestedBy: AUTO_UPDATE_REQUESTER,
    requestedAt: now.toISOString(),
  });
  return { requested: available.version };
}

// The updates dir from the app's side (server only): whether the updater is
// installed, its status, and writing a request. The format is in request.ts.
import { randomBytes } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  REQUEST_FILE,
  STATUS_FILE,
  serializeUpdateRequest,
  type UpdateRequest,
  type UpdateStatus,
  updateStatusSchema,
} from "./request";

/** Whether the host updater's dir is mounted (install.sh sets it up). */
export async function updaterInstalled(dir: string): Promise<boolean> {
  return stat(dir)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

/** A request the updater has not picked up yet. */
export async function hasPendingRequest(dir: string): Promise<boolean> {
  return stat(join(dir, REQUEST_FILE))
    .then(() => true)
    .catch(() => false);
}

/** The updater's last status; null when there is none or it does not parse. */
export async function readUpdateStatus(
  dir: string
): Promise<UpdateStatus | null> {
  const text = await readFile(join(dir, STATUS_FILE), "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const parsed = updateStatusSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Writes request.json atomically: a temp file in the same dir, renamed over
 * it, so the updater never sees a partial request. Throws for a request the
 * updater would refuse (ZodError) or when the dir is not writable.
 */
export async function writeUpdateRequest(
  dir: string,
  request: UpdateRequest
): Promise<void> {
  const content = serializeUpdateRequest(request);
  const tmp = join(dir, `.request.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, content, { flag: "wx", mode: 0o640 });
  try {
    await rename(tmp, join(dir, REQUEST_FILE));
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

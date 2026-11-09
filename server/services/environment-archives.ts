import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { EnvironmentArchive } from "@/lib/db/schema";
import { LOCAL_BACKUP_ROOT } from "@/lib/instance-backup/archive";
import { loadBackupDestination } from "@/lib/instance-backup/destination";
import {
  ENV_ARCHIVE_PREFIX,
  ENV_ARCHIVE_RETENTION_DAYS,
} from "@/lib/teardown/archive";
import {
  deleteArchiveRow,
  getArchive,
  listArchives,
  listPrunableArchives,
} from "@/lib/teardown/repository";
import { notFound } from "@/server/errors";
import { requireInstanceManage } from "@/server/services/instance-backups";

// Admin → Instance → Backups, "Deleted environments": what a teardown kept
// (lib/teardown/archive), listed and downloaded by org instance:manage, and
// deleted by the daily prune after ENV_ARCHIVE_RETENTION_DAYS.
//
// A file is read only by a name the archive row lists, under the row's own
// prefix, and only once that prefix has the shape the archive step writes
// (`<root>/<instance>/env-archives/<id>/`, or
// `opsdeck-env-archives/<instance>/<id>/`): nothing from the request becomes
// a path or an S3 key.

const DAY_MS = 86_400_000;

// The names lib/teardown/archive writes: `<kind>-<slug>-<hash>.<ext>`.
const FILE_NAME_RE = /^[a-z0-9][a-z0-9_.-]*$/;

export type EnvironmentArchiveListItem = Pick<
  EnvironmentArchive,
  "id" | "projectName" | "environmentName" | "createdAt" | "expiresAt" | "files"
>;

export async function listEnvironmentArchives(): Promise<
  EnvironmentArchiveListItem[]
> {
  await requireInstanceManage();
  return (await listArchives()).map((archive) => ({
    id: archive.id,
    projectName: archive.projectName,
    environmentName: archive.environmentName,
    createdAt: archive.createdAt,
    expiresAt: archive.expiresAt,
    files: archive.files,
  }));
}

/**
 * The local dir of an archive, or null unless its prefix is
 * `<LOCAL_BACKUP_ROOT>/<instance>/env-archives/<id>/` with no `..`.
 */
function localDir(archive: EnvironmentArchive): string | null {
  const prefix = archive.keyPrefix;
  if (!prefix.endsWith("/") || prefix.split("/").includes("..")) return null;
  const dir = resolve(prefix);
  const root = resolve(LOCAL_BACKUP_ROOT);
  const instanceDir = dirname(dirname(dir));
  const ok =
    basename(dir) === archive.id &&
    basename(dirname(dir)) === "env-archives" &&
    dirname(instanceDir) === root &&
    basename(instanceDir) !== "";
  return ok ? dir : null;
}

/** Whether an S3 prefix is `opsdeck-env-archives/<instance>/<id>/`. */
function s3PrefixOk(archive: EnvironmentArchive): boolean {
  const parts = archive.keyPrefix.split("/");
  return (
    archive.keyPrefix.startsWith(ENV_ARCHIVE_PREFIX) &&
    parts.length === 4 &&
    parts[1] !== "" &&
    parts[1] !== ".." &&
    parts[2] === archive.id &&
    parts[3] === ""
  );
}

/**
 * One listed file of an archive as a stream (local file or S3 object), read
 * as the response consumes it. 404 when the archive, the name in its list,
 * or the file is not there.
 */
export async function openArchiveFile(
  id: string,
  name: string
): Promise<{ name: string; stream: Readable }> {
  await requireInstanceManage();
  const archive = (await getArchive(id)) ?? notFound();
  const file = archive.files.find((f) => f.name === name);
  if (!file || !FILE_NAME_RE.test(file.name)) notFound();

  if (archive.location === "local") {
    const dir = localDir(archive) ?? notFound();
    const path = `${dir}${sep}${file.name}`;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) notFound();
    return { name: file.name, stream: createReadStream(path) };
  }
  if (!s3PrefixOk(archive)) notFound();
  const destination = (await loadBackupDestination()) ?? notFound();
  try {
    return {
      name: file.name,
      stream: await destination.store.read(`${archive.keyPrefix}${file.name}`),
    };
  } catch (error) {
    console.error(`Failed to read environment archive ${id}:`, error);
    notFound();
  }
}

/** Deletes an archive's files: the S3 objects under its prefix, or its dir. */
async function deleteArchiveFiles(archive: EnvironmentArchive): Promise<void> {
  if (archive.location === "local") {
    const dir = localDir(archive);
    if (!dir) throw new Error("the archive's local path is not an archive dir");
    await rm(dir, { recursive: true, force: true });
    return;
  }
  if (!s3PrefixOk(archive)) {
    throw new Error("the archive's S3 prefix is not an archive prefix");
  }
  const destination = await loadBackupDestination();
  if (!destination) throw new Error("no backup destination is set");
  const objects = await destination.store.list(archive.keyPrefix);
  if (objects.length > 0) {
    await destination.store.delete(objects.map((o) => o.key));
  }
}

/**
 * The daily prune (job `environment/archives.prune`): for each archive
 * listPrunableArchives selects, deletes its files, then its row. An archive
 * whose files cannot be deleted keeps its row, so the next prune tries again.
 */
export async function pruneEnvironmentArchives(
  now: Date = new Date()
): Promise<{ deleted: number; failed: number }> {
  const incompleteBefore = new Date(
    now.getTime() - ENV_ARCHIVE_RETENTION_DAYS * DAY_MS
  );
  let deleted = 0;
  let failed = 0;
  for (const archive of await listPrunableArchives(now, incompleteBefore)) {
    try {
      await deleteArchiveFiles(archive);
      await deleteArchiveRow(archive.id);
      deleted++;
    } catch (error) {
      failed++;
      console.error(
        `Failed to prune environment archive ${archive.id}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return { deleted, failed };
}

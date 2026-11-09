import { mkdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { EnvironmentArchive } from "@/lib/db/schema";
import { loadServerCredentials } from "@/lib/environments";
import { instanceName, LOCAL_BACKUP_ROOT } from "@/lib/instance-backup/archive";
import {
  type BackupDestination,
  loadBackupDestination,
} from "@/lib/instance-backup/destination";
import { privilegedViaStdin } from "@/lib/privileged";
import { loadDatabaseHost } from "@/lib/provisioning/repository";
import { decryptNullable } from "@/lib/secrets";
import { shq } from "@/lib/sh";
import { redactSecrets, streamRemoteCommandToFile } from "@/lib/ssh";
import { HostKeyMismatchError, type SshTarget } from "@/lib/ssh-connect";
import { StepFailed } from "@/lib/teardown/errors";
import {
  isSafeDeployDir,
  normaliseDeployDir,
  normaliseHost,
} from "@/lib/teardown/paths";
import type { TeardownStepSpec } from "@/lib/teardown/plan";
import {
  addArchiveFile,
  createArchive,
  findOpenArchive,
  loadArchiveSnapshot,
  loadTeardownDbService,
} from "@/lib/teardown/repository";
import {
  stopProjectForArchive,
  type TeardownContext,
  volumeArchiveCommand,
} from "@/lib/teardown/server-steps";

// The archive steps of a teardown: a pg_dump of each database, a tarball of
// each deploy dir and of each stack volume, streamed over SSH into a file and
// kept at the instance backup destination (the S3 connection, else the local
// backup root). They come before anything destructive in the plan, so a
// failure (archiveFailed) leaves everything in place.
//
// One archive row per teardown: the environment's row with no completed_at,
// created by the first archive step and added to by the others. A file the
// row already lists is not taken again, so a retry resumes where it stopped.
// The temp file is always removed. No secret is part of a command: a sudo
// password goes on stdin.

export const ENV_ARCHIVE_RETENTION_DAYS = 30;
/** S3 keys: `opsdeck-env-archives/<instance>/<archiveId>/<file>`. */
export const ENV_ARCHIVE_PREFIX = "opsdeck-env-archives/";

const DAY_MS = 86_400_000;
// One dump or tarball can take long; the stream has no other bound.
const ARCHIVE_COMMAND_TIMEOUT_MS = 2 * 60 * 60_000;
// Exit code of an archive command whose source is gone (dir, volume).
const SOURCE_MISSING = 44;

/** A step's context plus the user the teardown runs for (deleted_by). */
export type ArchiveContext = TeardownContext & { userId: string | null };

type DirParams = Extract<
  TeardownStepSpec,
  { kind: "archive_deploy_dir" }
>["params"];
type ServiceParams = Extract<
  TeardownStepSpec,
  { kind: "archive_database" }
>["params"];

/** The local dir of an archive: `<root>/<instance>/env-archives/<id>`. */
export function localArchiveDir(
  instance: string,
  archiveId: string,
  root: string = LOCAL_BACKUP_ROOT
): string {
  return join(root, instance, "env-archives", archiveId);
}

/** A file-name part: lower case, runs of anything but [a-z0-9_] as `-`. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function errorMessage(ctx: TeardownContext, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw, ctx.secrets);
}

async function loadDestination(
  ctx: TeardownContext
): Promise<BackupDestination | null> {
  try {
    return await loadBackupDestination();
  } catch (error) {
    throw new StepFailed(
      "archiveFailed",
      `the backup destination could not be loaded: ${errorMessage(ctx, error)}`
    );
  }
}

/** The environment's open archive, created on the first archive step. */
async function openArchive(
  ctx: ArchiveContext,
  destination: BackupDestination | null
): Promise<EnvironmentArchive> {
  const existing = await findOpenArchive(ctx.environmentId);
  if (existing) return existing;
  const snapshot = await loadArchiveSnapshot(ctx.environmentId);
  if (!snapshot) {
    throw new StepFailed("archiveFailed", "the environment is gone");
  }
  const id = uuidv7();
  const instance = instanceName();
  return createArchive({
    id,
    environmentId: ctx.environmentId,
    ...snapshot,
    deletedById: ctx.userId,
    expiresAt: new Date(Date.now() + ENV_ARCHIVE_RETENTION_DAYS * DAY_MS),
    location: destination ? "s3" : "local",
    keyPrefix: destination
      ? `${ENV_ARCHIVE_PREFIX}${instance}/${id}/`
      : `${localArchiveDir(instance, id)}/`,
  });
}

/** Creates `dir` and its missing parents with mode 0700. */
async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * Writes the archive file `name` with `produce` (which fills the path it is
 * given) and keeps it: uploaded under the row's S3 prefix, or renamed into
 * the row's local dir. "already" when the row lists the file, "missing" when
 * `produce` found nothing to archive. Any failure is archiveFailed.
 */
async function storeFile(
  ctx: ArchiveContext,
  name: string,
  produce: (path: string) => Promise<"written" | "missing">
): Promise<"stored" | "already" | "missing"> {
  const destination = await loadDestination(ctx);
  const archive = await openArchive(ctx, destination);
  if (archive.files.some((file) => file.name === name)) return "already";
  if (archive.location === "s3" && !destination) {
    throw new StepFailed(
      "archiveFailed",
      "this archive goes to S3, but no backup destination is set any more"
    );
  }

  // S3 files are staged under the local root too, never in /tmp (which may
  // be memory). Local files are written beside their final name.
  const dir =
    archive.location === "local"
      ? archive.keyPrefix.replace(/\/$/, "")
      : localArchiveDir(instanceName(), archive.id);
  const partial = join(dir, `.${name}.partial`);
  try {
    await privateDir(dir);
    if ((await produce(partial)) === "missing") return "missing";
    const { size } = await stat(partial);
    if (archive.location === "local") {
      await rename(partial, join(dir, name));
    } else {
      try {
        await destination?.store.upload(`${archive.keyPrefix}${name}`, partial);
      } catch (error) {
        throw new StepFailed(
          "archiveFailed",
          `the upload of ${name} failed: ${errorMessage(ctx, error)}`
        );
      }
    }
    await addArchiveFile(archive.id, { name, size });
    return "stored";
  } catch (error) {
    if (error instanceof StepFailed || error instanceof HostKeyMismatchError) {
      throw error;
    }
    throw new StepFailed(
      "archiveFailed",
      `${name} could not be written: ${errorMessage(ctx, error)}`
    );
  } finally {
    await rm(partial, { force: true }).catch(() => {});
    // The staging dir of an S3 archive is left empty.
    if (archive.location === "s3") await rmdir(dir).catch(() => {});
  }
}

/**
 * Streams `command`'s stdout into `path`. A non-zero exit, or no output, is
 * archiveFailed with the first stderr line; SOURCE_MISSING is "missing".
 */
async function streamTo(
  ctx: TeardownContext,
  target: SshTarget,
  command: string,
  path: string,
  what: string,
  stdin?: string
): Promise<"written" | "missing" | { failed: string }> {
  let result: Awaited<ReturnType<typeof streamRemoteCommandToFile>>;
  try {
    result = await streamRemoteCommandToFile(target, command, path, {
      timeoutMs: ARCHIVE_COMMAND_TIMEOUT_MS,
      ...(stdin === undefined ? {} : { stdin }),
    });
  } catch (error) {
    if (error instanceof HostKeyMismatchError) throw error;
    return { failed: `${what}: ${errorMessage(ctx, error)}` };
  }
  if (result.code === SOURCE_MISSING) return "missing";
  if (result.code !== 0) {
    const line = redactSecrets(
      result.stderr.split("\n")[0]?.trim() ?? "",
      ctx.secrets
    );
    return {
      failed: `${what} exited with ${result.code ?? "a signal"}${line ? `: ${line}` : ""}`,
    };
  }
  if (result.bytes === 0) return { failed: `${what} wrote nothing` };
  return "written";
}

/** streamTo, with a failure thrown as archiveFailed. */
async function streamOrFail(
  ctx: TeardownContext,
  target: SshTarget,
  command: string,
  path: string,
  what: string
): Promise<"written" | "missing"> {
  const result = await streamTo(ctx, target, command, path, what);
  if (typeof result === "object") {
    throw new StepFailed("archiveFailed", result.failed);
  }
  return result;
}

async function serverTarget(
  ctx: TeardownContext,
  serverId: string
): Promise<SshTarget> {
  const creds = await loadServerCredentials(serverId);
  if (!creds) {
    throw new StepFailed("serverCommandFailed", `server ${serverId} not found`);
  }
  if (creds.password) ctx.secrets.push(creds.password);
  return { ...creds, run: ctx.runId };
}

function stored(
  result: "stored" | "already" | "missing",
  name: string,
  missing: string
): string {
  switch (result) {
    case "stored":
      return `${name} archived`;
    case "already":
      return `${name} already archived`;
    case "missing":
      return missing;
  }
}

/**
 * archive_database: `pg_dump -Fc` of the environment's database, run in its
 * container (a docker db service on its server, or the shared host's
 * container), kept as `db-<db>.dump`.
 */
export async function archiveDatabase(
  ctx: ArchiveContext,
  params: ServiceParams
): Promise<string> {
  const service = await loadTeardownDbService(params.serviceId);
  if (
    !service ||
    service.environmentId !== ctx.environmentId ||
    service.role !== "db" ||
    !service.dbName
  ) {
    throw new StepFailed("databaseNotRegistered");
  }
  if (service.dbType !== "postgres") {
    throw new StepFailed("databaseBackupUnsupported");
  }

  let target: SshTarget;
  let container: string;
  if (service.dbKind === "shared") {
    const host = service.databaseHostId
      ? await loadDatabaseHost(service.databaseHostId)
      : null;
    if (!host) throw new StepFailed("databaseNotRegistered");
    const password = decryptNullable(host.server.password);
    if (password) ctx.secrets.push(password);
    target = {
      serverId: host.server.id,
      host: host.server.host,
      username: host.server.username,
      password,
      auth: host.server.auth,
      run: ctx.runId,
    };
    container = host.containerName;
  } else if (service.serviceType === "docker") {
    target = await serverTarget(ctx, service.serverId);
    container = service.serviceName;
  } else {
    // A systemd or Kubernetes database: the Panel has no dump path for it.
    throw new StepFailed("databaseBackupUnsupported");
  }

  const database = service.dbName;
  const name = `db-${slug(database)}.dump`;
  const command = `docker exec ${shq(container)} pg_dump -Fc -U postgres ${shq(database)}`;
  const result = await storeFile(ctx, name, (path) =>
    streamOrFail(ctx, target, command, path, "pg_dump")
  );
  return stored(result, name, `Database ${database} not found to archive`);
}

/** The canonical deploy dir, or unsafeDeployDir before any SSH. */
function safeDir(deployDir: string): string {
  if (!isSafeDeployDir(deployDir)) throw new StepFailed("unsafeDeployDir");
  const dir = normaliseDeployDir(deployDir);
  if (!isSafeDeployDir(dir)) throw new StepFailed("unsafeDeployDir");
  return dir;
}

/** A file-name part for the machine, so two servers' files never clash. */
const machine = (target: SshTarget) => slug(normaliseHost(target.host));

/**
 * archive_deploy_dir: `tar -C <parent> -czf - <base>` of the deploy dir
 * (hand-placed .env files, server-only config), kept as
 * `deploy-<host>-<dir>.tar.gz`. As the SSH user first, then elevated when
 * that fails (containers leave root-owned files in bind mounts). Nothing to
 * archive when the dir is gone.
 */
export async function archiveDeployDir(
  ctx: ArchiveContext,
  params: DirParams
): Promise<string> {
  const dir = safeDir(params.deployDir);
  const target = await serverTarget(ctx, params.serverId);
  const cut = dir.lastIndexOf("/");
  const parent = dir.slice(0, cut) || "/";
  const base = dir.slice(cut + 1);
  const tar = `tar -C ${shq(parent)} -czf - -- ${shq(base)}`;
  const quoted = shq(dir);
  const check = `if [ ! -e ${quoted} ] && [ ! -L ${quoted} ]; then exit ${SOURCE_MISSING}; fi`;
  const elevated = privilegedViaStdin(tar, target);
  const name = `deploy-${machine(target)}-${slug(dir)}.tar.gz`;

  const result = await storeFile(ctx, name, async (path) => {
    const plain = await streamTo(ctx, target, `${check}; ${tar}`, path, "tar");
    if (typeof plain !== "object") return plain;
    if (elevated.command === tar) {
      throw new StepFailed("archiveFailed", plain.failed);
    }
    const retry = await streamTo(
      ctx,
      target,
      `${check}; ${elevated.command}`,
      path,
      "tar (elevated)",
      elevated.stdin
    );
    if (typeof retry === "object") {
      throw new StepFailed("archiveFailed", `${plain.failed}; ${retry.failed}`);
    }
    return retry;
  });
  return stored(result, name, `No deploy dir ${dir}; nothing to archive`);
}

/**
 * archive_volumes: stops the stack (stopProjectForArchive, after its checks)
 * so its volumes are consistent, then keeps each of the project's volumes as
 * `volume-<host>-<volume>.tar.gz`. Each volume is checked to still exist
 * right before it is read: `docker run -v` would create an empty one. A
 * failure after the stop leaves the stack stopped, and says so; a retry
 * resumes with the volumes not archived yet.
 */
export async function archiveVolumes(
  ctx: ArchiveContext,
  params: DirParams
): Promise<string> {
  const stopped = await stopProjectForArchive(ctx, params);
  if (stopped.volumes.length === 0) return stopped.message;
  const archived: string[] = [];
  try {
    const target = await serverTarget(ctx, params.serverId);
    for (const volume of stopped.volumes) {
      const name = `volume-${machine(target)}-${volume}.tar.gz`;
      const command = `docker volume inspect ${shq(volume)} >/dev/null 2>&1 || exit ${SOURCE_MISSING}; ${volumeArchiveCommand(volume)}`;
      const result = await storeFile(ctx, name, (path) =>
        streamOrFail(ctx, target, command, path, `the archive of ${volume}`)
      );
      if (result === "missing") {
        throw new StepFailed(
          "archiveFailed",
          `volume ${volume} no longer exists`
        );
      }
      archived.push(stored(result, name, ""));
    }
  } catch (error) {
    if (error instanceof HostKeyMismatchError) throw error;
    const detail =
      error instanceof StepFailed
        ? (error.detail ?? error.message)
        : errorMessage(ctx, error);
    throw new StepFailed(
      "archiveFailed",
      `${detail}. The stack ${stopped.project} in ${normaliseDeployDir(params.deployDir)} was stopped for the archive and is left stopped`
    );
  }
  return `${stopped.message}; ${archived.join(", ")}`;
}

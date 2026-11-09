import { createHash } from "node:crypto";
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
import { sharedDbRole } from "@/lib/jobs/commands";
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
/**
 * The time budget of one archive file (a dump, or a deploy dir's plain and
 * elevated tar together); the stream has no other bound.
 */
export const ARCHIVE_COMMAND_TIMEOUT_MS = 2 * 60 * 60_000;
// An elevated tar retry needs at least this much of the budget left.
const MIN_RETRY_MS = 60_000;
// Exit codes of an archive command: its source is gone (dir, volume), or
// docker could not say whether the volume exists.
const SOURCE_MISSING = 44;
const INSPECT_FAILED = 45;

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

/**
 * An archive file name: a readable slug, then 10 hex of the sha256 of the
 * exact source (`identity`), so two sources never share a name even when
 * their slugs do (`/srv/app-x` and `/srv/app/x`, `App` and `app`).
 */
function fileName(
  kind: "db" | "deploy" | "volume",
  readable: string,
  identity: string,
  extension: string
): string {
  const hash = createHash("sha256").update(identity).digest("hex");
  return `${kind}-${readable}-${hash.slice(0, 10)}.${extension}`;
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

type StreamOptions = {
  timeoutMs: number;
  stdin?: string;
  /** The command exits SOURCE_MISSING when its source is gone. */
  missingExit: boolean;
};

/**
 * Streams `command`'s stdout into `path`. A non-zero exit, or no output, is
 * a failure with the first stderr line; SOURCE_MISSING is "missing" only for
 * a command that checks its source.
 */
async function streamTo(
  ctx: TeardownContext,
  target: SshTarget,
  command: string,
  path: string,
  what: string,
  options: StreamOptions
): Promise<"written" | "missing" | { failed: string }> {
  let result: Awaited<ReturnType<typeof streamRemoteCommandToFile>>;
  try {
    result = await streamRemoteCommandToFile(target, command, path, {
      timeoutMs: options.timeoutMs,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    });
  } catch (error) {
    if (error instanceof HostKeyMismatchError) throw error;
    return { failed: `${what}: ${errorMessage(ctx, error)}` };
  }
  if (options.missingExit && result.code === SOURCE_MISSING) return "missing";
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
  what: string,
  missingExit: boolean
): Promise<"written" | "missing"> {
  const result = await streamTo(ctx, target, command, path, what, {
    timeoutMs: ARCHIVE_COMMAND_TIMEOUT_MS,
    missingExit,
  });
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

/** The step's log line; "missing" without a message is a failure. */
function stored(
  result: "stored" | "already" | "missing",
  name: string,
  missing?: string
): string {
  switch (result) {
    case "stored":
      return `${name} archived`;
    case "already":
      return `${name} already archived`;
    case "missing":
      if (missing === undefined) {
        throw new StepFailed(
          "archiveFailed",
          `nothing was written for ${name}`
        );
      }
      return missing;
  }
}

/**
 * archive_database: `pg_dump -Fc` of the environment's database, kept as
 * `db-<db>-<hash of the service id>.dump`. A docker db service is dumped in
 * its container as postgres; a shared binding in its host's container as the
 * binding's own role, never as postgres (see pgSharedBackupPipeline).
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
  let user: string;
  if (service.dbKind === "shared") {
    if (!service.dbRole) throw new StepFailed("databaseNotRegistered");
    user = sharedDbRole(service);
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
    user = "postgres";
  } else {
    // A systemd or Kubernetes database: the Panel has no dump path for it.
    throw new StepFailed("databaseBackupUnsupported");
  }

  const database = service.dbName;
  const name = fileName("db", slug(database), params.serviceId, "dump");
  const command = `docker exec ${shq(container)} pg_dump -Fc -U ${user === "postgres" ? user : shq(user)} ${shq(database)}`;
  const result = await storeFile(ctx, name, (path) =>
    streamOrFail(ctx, target, command, path, "pg_dump", false)
  );
  return stored(result, name);
}

/** The canonical deploy dir, or unsafeDeployDir before any SSH. */
function safeDir(deployDir: string): string {
  if (!isSafeDeployDir(deployDir)) throw new StepFailed("unsafeDeployDir");
  const dir = normaliseDeployDir(deployDir);
  if (!isSafeDeployDir(dir)) throw new StepFailed("unsafeDeployDir");
  return dir;
}

/** The machine part of a file name and of its source identity. */
const machine = (target: SshTarget) => normaliseHost(target.host);

/**
 * archive_deploy_dir: `tar -C <parent> -czf - <base>` of the deploy dir
 * (hand-placed .env files, server-only config), kept as
 * `deploy-<host>-<dir>-<hash of host and dir>.tar.gz`. As the SSH user
 * first, then elevated when that fails (containers leave root-owned files in
 * bind mounts); both share one time budget. Nothing to archive when the dir
 * is gone.
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
  const host = machine(target);
  const name = fileName(
    "deploy",
    `${slug(host)}-${slug(dir)}`,
    `${host}\n${dir}`,
    "tar.gz"
  );

  const result = await storeFile(ctx, name, async (path) => {
    const deadline = Date.now() + ARCHIVE_COMMAND_TIMEOUT_MS;
    const plain = await streamTo(ctx, target, `${check}; ${tar}`, path, "tar", {
      timeoutMs: ARCHIVE_COMMAND_TIMEOUT_MS,
      missingExit: true,
    });
    if (typeof plain !== "object") return plain;
    if (elevated.command === tar) {
      throw new StepFailed("archiveFailed", plain.failed);
    }
    const left = deadline - Date.now();
    if (left < MIN_RETRY_MS) {
      throw new StepFailed(
        "archiveFailed",
        `${plain.failed}; no time left to retry elevated`
      );
    }
    const retry = await streamTo(
      ctx,
      target,
      `${check}; ${elevated.command}`,
      path,
      "tar (elevated)",
      {
        timeoutMs: left,
        missingExit: true,
        ...(elevated.stdin === undefined ? {} : { stdin: elevated.stdin }),
      }
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
 * `volume-<host>-<volume>-<hash of host and volume>.tar.gz`. Each volume is
 * checked to still exist right before it is read (`docker run -v` would
 * create an empty one); only docker's "no such volume" counts as gone, any
 * other inspect error fails with docker's message. A
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
      const host = machine(target);
      const name = fileName(
        "volume",
        `${slug(host)}-${volume}`,
        `${host}\n${volume}`,
        "tar.gz"
      );
      // Docker says "no such volume", Podman "no such volume" too, either
      // capitalised; anything else (daemon down, permission) is not gone.
      const inspect = [
        `if ! err=$(docker volume inspect ${shq(volume)} 2>&1 >/dev/null); then`,
        `  case "$err" in *[Nn]"o such volume"*) exit ${SOURCE_MISSING};; esac`,
        `  printf '%s\\n' "$err" >&2; exit ${INSPECT_FAILED}`,
        "fi",
      ].join("\n");
      const command = `${inspect}\n${volumeArchiveCommand(volume)}`;
      const result = await storeFile(ctx, name, (path) =>
        streamOrFail(
          ctx,
          target,
          command,
          path,
          `the archive of ${volume}`,
          true
        )
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

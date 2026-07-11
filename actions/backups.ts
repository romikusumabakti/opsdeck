"use server";

import { unstable_cache, updateTag } from "next/cache";
import { requireCapability, requireSession } from "@/lib/auth-session";
import { backupListCacheTag } from "@/lib/db-cache-tags";
import { loadEnvironmentWithServers } from "@/lib/projects";
import { enqueue } from "@/lib/queue";
import { createRun } from "@/lib/run-progress";
import { buildDbShellCommand } from "@/lib/services";
import { shq } from "@/lib/sh";
import { executeRemoteCommand } from "@/lib/ssh";
import type { Backup } from "@/lib/types";
import {
  backupFilenameSchema,
  databaseNameSchema,
  projectIdSchema,
} from "@/lib/validation";

type BackupListResult =
  | { success: true; data: Backup[] }
  | { success: false; error: string };

// Resolve the operation's target database. An omitted target (or one equal to
// the project's configured database) means the trusted "default database" and
// bypasses validation. Any other, client-supplied database is validated against
// databaseNameSchema before it reaches a shell/SQL command.
function resolveTargetDatabase(
  project: { dbName: string },
  provided: string | undefined
): string {
  if (!provided || provided === project.dbName) return project.dbName;
  const parsed = databaseNameSchema.safeParse(provided);
  if (!parsed.success) {
    throw new Error("Invalid database name");
  }
  return parsed.data;
}

// The SSH probe with no session/request state, so it is safe inside
// `unstable_cache`. Throws on failure so a transient SSH error is not cached.
async function probeBackupList(projectId: string): Promise<Backup[]> {
  const project = await loadEnvironmentWithServers(projectId);
  if (!project) {
    throw new Error("Project not found");
  }
  // Match exactly what createDatabaseBackup writes — `.sql` / `.sql.gz` for
  // postgres (compressed or not) and `.bak` for mssql. Anything else in the
  // folder is ignored so users can't pick an unrestoreable file from the
  // dropdown.
  const extensionPattern =
    project.dbType === "postgres" ? "\\.sql(\\.gz)?" : "\\.bak";

  // `grep -E` for the optional `.gz` alternation. Run as the DB's OS user
  // for systemd so the listing works even when the backup dir is mode 700
  // (typical for Postgres data dirs and mssql backup dirs); no-op for
  // docker/kubernetes where the exec wrapper already enters the container.
  const inner = `ls -lt ${shq(project.dbBackupPath)} | grep -E ${shq(`${extensionPattern}$`)} | awk '{print $5, $9}'`;
  const cmd = buildDbShellCommand(
    project.dbServiceType,
    project.dbServiceName,
    inner,
    {
      runAsUser: project.dbType === "postgres" ? "postgres" : "mssql",
      sudoPassword: project.dbServer.password,
    }
  );
  const output = await executeRemoteCommand(
    {
      host: project.dbServer.host,
      username: project.dbServer.username,
      password: project.dbServer.password,
    },
    cmd
  );

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [size, name] = line.trim().split(/\s+/);
      return { name, size };
    });
}

export async function getBackupList(
  projectId: string
): Promise<BackupListResult> {
  await requireSession();
  if (!projectIdSchema.safeParse(projectId).success) {
    return { success: false, error: "Invalid project id" };
  }
  try {
    const data = await unstable_cache(
      () => probeBackupList(projectId),
      ["backup-list", projectId],
      { tags: [backupListCacheTag(projectId)], revalidate: 30 }
    )();
    return { success: true, data };
  } catch (error) {
    const message = (error as Error).message;
    if (message === "Project not found") {
      return { success: false, error: message };
    }
    // Don't surface raw SSH stderr (paths, hostnames) to the client.
    console.error(`Failed to fetch backups for project ${projectId}:`, error);
    return { success: false, error: "Failed to fetch backups" };
  }
}

// Drop the cached backup listing so the restore tab reflects a file the worker
// just wrote. Called from the client once a backup run completes — the enqueue
// path can't invalidate because the file only exists after the worker finishes.
export async function revalidateBackupList(projectId: string): Promise<void> {
  await requireSession();
  if (!projectIdSchema.safeParse(projectId).success) return;
  updateTag(backupListCacheTag(projectId));
}

export async function createDatabaseBackup(
  projectId: string,
  options: { compress?: boolean; database?: string } = {}
): Promise<{ runId: string }> {
  if (!projectIdSchema.safeParse(projectId).success) {
    throw new Error("Invalid project id");
  }
  const session = await requireCapability("ops.destructive", {
    environmentId: projectId,
  });
  const project = await loadEnvironmentWithServers(projectId);
  if (!project) throw new Error("Project not found");
  const database = resolveTargetDatabase(project, options.database);

  const compress = options.compress ?? true;
  const runId = await createRun({
    projectId: project.id,
    userId: session.user.id,
    description: compress
      ? `Backup database (${database})`
      : `Backup database (${database}, uncompressed)`,
  });
  // Enqueue only the projectId + database — the worker re-loads credentials
  // server-side so they never live in the job payload.
  await enqueue("db/backup.requested", {
    projectId: project.id,
    compress,
    database,
    runId,
  });
  return { runId };
}

export async function restoreDatabaseBackup(
  projectId: string,
  options: {
    filename: string;
    restartBackend?: boolean;
    database?: string;
    sourceProjectId?: string;
  }
): Promise<{ runId: string }> {
  if (!projectIdSchema.safeParse(projectId).success) {
    throw new Error("Invalid project id");
  }
  const session = await requireCapability("ops.destructive", {
    environmentId: projectId,
  });
  const parsedFilename = backupFilenameSchema.safeParse(options.filename);
  if (!parsedFilename.success) {
    throw new Error("Invalid backup filename");
  }
  const filename = parsedFilename.data;
  const project = await loadEnvironmentWithServers(projectId);
  if (!project) throw new Error("Project not found");
  const database = resolveTargetDatabase(project, options.database);

  // Resolve an optional cross-project source. A source equal to (or omitting)
  // the target reads the backup from the target's own dir as before. Any other
  // source must share the target's dbType (postgres↔postgres, mssql↔mssql); the
  // worker reads it directly when the DB location also matches, otherwise it
  // stages the file across hosts.
  let sourceProjectId: string | undefined;
  if (options.sourceProjectId && options.sourceProjectId !== projectId) {
    if (!projectIdSchema.safeParse(options.sourceProjectId).success) {
      throw new Error("Invalid source project id");
    }
    const source = await loadEnvironmentWithServers(options.sourceProjectId);
    if (!source) throw new Error("Source project not found");
    if (source.dbType !== project.dbType) {
      throw new Error("Source project must have the same database type");
    }
    sourceProjectId = source.id;
  }

  const isDefault = database === project.dbName;
  const runId = await createRun({
    projectId: project.id,
    userId: session.user.id,
    description: options.restartBackend
      ? `Restore database ${database} from ${filename} (+ restart backend)`
      : `Restore database ${database} from ${filename}`,
  });
  await enqueue("db/restore.requested", {
    projectId: project.id,
    filename,
    // Only forward a non-default target so the worker keeps using its trusted
    // project.dbName when restoring the default database.
    database: isDefault ? undefined : database,
    restartBackend: options.restartBackend ?? false,
    sourceProjectId,
    runId,
  });
  return { runId };
}

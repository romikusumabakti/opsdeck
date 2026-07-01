"use server";

import { requireSession } from "@/lib/auth-session";
import { loadProjectWithServers } from "@/lib/projects";
import { enqueue } from "@/lib/queue";
import { buildDbShellCommand } from "@/lib/services";
import { shq } from "@/lib/sh";
import { executeRemoteCommand } from "@/lib/ssh";
import { createTask } from "@/lib/task-progress";
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

export async function getBackupList(
  projectId: string
): Promise<BackupListResult> {
  await requireSession();
  if (!projectIdSchema.safeParse(projectId).success) {
    return { success: false, error: "Invalid project id" };
  }
  const project = await loadProjectWithServers(projectId);
  if (!project) {
    return { success: false, error: "Project not found" };
  }
  try {
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

    const backups = output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [size, name] = line.trim().split(/\s+/);
        return { name, size };
      });

    return { success: true, data: backups };
  } catch (error) {
    // Don't surface raw SSH stderr (paths, hostnames) to the client.
    console.error(`Failed to fetch backups for project ${projectId}:`, error);
    return { success: false, error: "Failed to fetch backups" };
  }
}

export async function createDatabaseBackup(
  projectId: string,
  options: { compress?: boolean; database?: string } = {}
): Promise<{ taskId: string }> {
  const session = await requireSession();
  if (!projectIdSchema.safeParse(projectId).success) {
    throw new Error("Invalid project id");
  }
  const project = await loadProjectWithServers(projectId);
  if (!project) throw new Error("Project not found");
  const database = resolveTargetDatabase(project, options.database);

  const compress = options.compress ?? true;
  const taskId = await createTask({
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
    taskId,
  });
  return { taskId };
}

export async function restoreDatabaseBackup(
  projectId: string,
  options: { filename: string; restartBackend?: boolean; database?: string }
): Promise<{ taskId: string }> {
  const session = await requireSession();
  if (!projectIdSchema.safeParse(projectId).success) {
    throw new Error("Invalid project id");
  }
  const parsedFilename = backupFilenameSchema.safeParse(options.filename);
  if (!parsedFilename.success) {
    throw new Error("Invalid backup filename");
  }
  const filename = parsedFilename.data;
  const project = await loadProjectWithServers(projectId);
  if (!project) throw new Error("Project not found");
  const database = resolveTargetDatabase(project, options.database);

  const isDefault = database === project.dbName;
  const taskId = await createTask({
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
    taskId,
  });
  return { taskId };
}

"use server";

import { inngest } from "@/inngest/client";
import { requireSession } from "@/lib/auth-session";
import type { ProjectWithServers } from "@/lib/db/schema";
import { buildDbShellCommand } from "@/lib/services";
import { shq } from "@/lib/sh";
import { executeRemoteCommand } from "@/lib/ssh";
import { createTask } from "@/lib/task-progress";
import type { Backup } from "@/lib/types";

type BackupListResult =
  | { success: true; data: Backup[] }
  | { success: false; error: string };

export async function getBackupList(
  project: ProjectWithServers
): Promise<BackupListResult> {
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
    return { success: false, error: `Failed to fetch backups: ${error}` };
  }
}

export async function createDatabaseBackup(
  project: ProjectWithServers & { compress?: boolean }
): Promise<{ taskId: string }> {
  const session = await requireSession();
  const compress = project.compress ?? true;
  const taskId = await createTask({
    projectId: project.id,
    userId: session.user.id,
    description: compress
      ? `Backup database (${project.dbName})`
      : `Backup database (${project.dbName}, uncompressed)`,
  });
  await inngest.send({
    name: "db/backup.requested",
    data: { ...project, compress, taskId },
  });
  return { taskId };
}

export async function restoreDatabaseBackup(
  project: ProjectWithServers & {
    filename: string;
    restartBackend?: boolean;
  }
): Promise<{ taskId: string }> {
  const session = await requireSession();
  const taskId = await createTask({
    projectId: project.id,
    userId: session.user.id,
    description: project.restartBackend
      ? `Restore database from ${project.filename} (+ restart backend)`
      : `Restore database from ${project.filename}`,
  });
  await inngest.send({
    name: "db/restore.requested",
    data: { ...project, taskId },
  });
  return { taskId };
}

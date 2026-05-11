"use server";

import { inngest } from "@/inngest/client";
import { requireSession } from "@/lib/auth-session";
import type { ProjectWithServers } from "@/lib/db/schema";
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
    // Match exactly what createDatabaseBackup writes — `.sql.gz` for postgres
    // (always gzipped) and `.bak` for mssql (RESTORE DATABASE cannot read a
    // gzipped file directly). Anything else in the folder is ignored so users
    // can't pick an unrestoreable file from the dropdown.
    const extensionPattern =
      project.dbType === "postgres" ? "\\.sql\\.gz" : "\\.bak";

    const listCmd = project.dbIsBackupMounted
      ? `ls -lt ${shq(project.dbBackupPath)}`
      : `docker exec ${shq(project.dbServiceName)} ls -lt ${shq(project.dbBackupPath)}`;

    const cmd = `${listCmd} | grep ${shq(`${extensionPattern}$`)} | awk '{print $5, $9}'`;
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
  project: ProjectWithServers
): Promise<{ taskId: string }> {
  const session = await requireSession();
  const taskId = await createTask({
    projectId: project.id,
    userId: session.user.id,
    description: `Backup database (${project.dbName})`,
  });
  await inngest.send({
    name: "db/backup.requested",
    data: { ...project, taskId },
  });
  return { taskId };
}

export async function restoreDatabaseBackup(
  project: ProjectWithServers & { filename: string }
): Promise<{ taskId: string }> {
  const session = await requireSession();
  const taskId = await createTask({
    projectId: project.id,
    userId: session.user.id,
    description: `Restore database from ${project.filename}`,
  });
  await inngest.send({
    name: "db/restore.requested",
    data: { ...project, taskId },
  });
  return { taskId };
}

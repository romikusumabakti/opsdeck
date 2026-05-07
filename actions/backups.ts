"use server";

import { inngest } from "@/inngest/client";
import type { ProjectWithServers } from "@/lib/db/schema";
import { executeRemoteCommand } from "@/lib/ssh";

export async function getBackupList(project: ProjectWithServers) {
  try {
    const extensionPattern =
      project.dbType === "postgres"
        ? "\\.sql\\(\\.gz\\)\\?"
        : "\\.bak\\(\\.gz\\)\\?";

    const listCmd = project.dbIsBackupMounted
      ? `ls -lt ${project.dbBackupPath}`
      : `docker exec ${project.dbServiceName} ls -lt ${project.dbBackupPath}`;

    const cmd = `${listCmd} | grep "${extensionPattern}$" | awk '{print $5, $9}'`;
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

export async function createDatabaseBackup(project: ProjectWithServers) {
  await inngest.send({
    name: "db/backup.requested",
    data: project,
  });
}

export async function restoreDatabaseBackup(
  project: ProjectWithServers & { filename: string }
) {
  await inngest.send({
    name: "db/restore.requested",
    data: project,
  });
}

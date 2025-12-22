"use server";

import { inngest } from "@/inngest/client";
import { Project } from "@/lib/db/schema";
import { executeRemoteCommand } from "@/lib/ssh";

export async function getBackupList(project: Project) {
  try {
    const extensionPattern =
      project.dbType === "postgres"
        ? "\\.sql\\(\\.gz\\)\\?"
        : "\\.bak\\(\\.gz\\)\\?";

    // List files, sort by time (newest first), output format: size|filename
    const listCmd = project.dbIsBackupMounted
      ? `ls -lt ${project.dbBackupPath}`
      : `docker exec ${project.dbServiceName} ls -lt ${project.dbBackupPath}`;

    // We stream the output of 'ls' (from host or docker) into grep/awk on the host
    const cmd = `${listCmd} | grep "${extensionPattern}$" | awk '{print $5, $9}'`;
    const output = await executeRemoteCommand(
      {
        host: project.dbServerHost,
        username: project.dbServerUsername,
        password: project.dbServerPassword,
      },
      cmd
    );

    // Parse Linux ls output
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

export async function createDatabaseBackup(project: Project) {
  await inngest.send({
    name: "db/backup.requested",
    data: project,
  });
}

export async function restoreDatabaseBackup(project: Project) {
  await inngest.send({
    name: "db/restore.requested",
    data: project,
  });
}

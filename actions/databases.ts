"use server";

import { inngest } from "@/inngest/client";
import { requireSession } from "@/lib/auth-session";
import { loadProjectWithServers } from "@/lib/projects";
import { buildDbShellCommand, buildSqlcmdCommand } from "@/lib/services";
import { shq } from "@/lib/sh";
import { executeRemoteCommand } from "@/lib/ssh";
import { createTask } from "@/lib/task-progress";
import { databaseNameSchema, projectIdSchema } from "@/lib/validation";

export interface DatabaseEntry {
  name: string;
  isDefault: boolean;
}

type DatabaseListResult =
  | { success: true; data: DatabaseEntry[] }
  | { success: false; error: string };

// Enumerate the databases that live on the project's DB server, so the picker
// can offer targets other than the project's configured "default" database.
// Synchronous SSH (like getBackupList) — the list is needed to render the page,
// not as a background task.
export async function getDatabaseList(
  projectId: string
): Promise<DatabaseListResult> {
  await requireSession();
  if (!projectIdSchema.safeParse(projectId).success) {
    return { success: false, error: "Invalid project id" };
  }
  const project = await loadProjectWithServers(projectId);
  if (!project) {
    return { success: false, error: "Project not found" };
  }

  try {
    let cmd: string;
    if (project.dbType === "mssql") {
      if (!project.dbPassword) {
        return {
          success: false,
          error: "Project dbPassword is required to list MSSQL databases",
        };
      }
      // Skip the four system databases (database_id 1-4: master, tempdb, model,
      // msdb). `-h -1` drops the header, `-W` trims trailing spaces so each line
      // is a clean database name. `SET NOCOUNT ON` suppresses the row-count tail.
      const query =
        "SET NOCOUNT ON; SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name;";
      cmd = buildSqlcmdCommand(
        query,
        project.dbPassword,
        project.dbServiceType,
        project.dbServiceName,
        ["-h", "-1", "-W"]
      );
    } else {
      // `-tAc`: tuples-only, unaligned, run-command — one bare datname per line.
      // Exclude template databases (template0/template1) which can't be backed
      // up or restored into.
      const query =
        "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname";
      const inner = `psql -U postgres -tAc ${shq(query)}`;
      cmd = buildDbShellCommand(
        project.dbServiceType,
        project.dbServiceName,
        inner,
        { runAsUser: "postgres", sudoPassword: project.dbServer.password }
      );
    }

    const output = await executeRemoteCommand(
      {
        host: project.dbServer.host,
        username: project.dbServer.username,
        password: project.dbServer.password,
      },
      cmd
    );
    const names = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    // Always surface the configured database, even if the enumeration somehow
    // missed it (permissions, race), and mark it as the default.
    if (!names.includes(project.dbName)) {
      names.unshift(project.dbName);
    }
    const data = names.map((name) => ({
      name,
      isDefault: name === project.dbName,
    }));

    return { success: true, data };
  } catch (error) {
    // Don't surface raw SSH stderr (paths, hostnames) to the client.
    console.error(`Failed to list databases for project ${projectId}:`, error);
    return { success: false, error: "Failed to list databases" };
  }
}

export async function createDatabase(
  projectId: string,
  options: { database: string }
): Promise<{ taskId: string }> {
  const session = await requireSession();
  if (!projectIdSchema.safeParse(projectId).success) {
    throw new Error("Invalid project id");
  }
  const parsed = databaseNameSchema.safeParse(options.database);
  if (!parsed.success) {
    throw new Error("Invalid database name");
  }
  const database = parsed.data;
  const project = await loadProjectWithServers(projectId);
  if (!project) throw new Error("Project not found");

  const taskId = await createTask({
    projectId: project.id,
    userId: session.user.id,
    description: `Create database (${database})`,
  });
  await inngest.send({
    name: "db/database.create.requested",
    data: { projectId: project.id, database, taskId },
  });
  return { taskId };
}

export async function dropDatabase(
  projectId: string,
  options: { database: string }
): Promise<{ taskId: string }> {
  const session = await requireSession();
  if (!projectIdSchema.safeParse(projectId).success) {
    throw new Error("Invalid project id");
  }
  const parsed = databaseNameSchema.safeParse(options.database);
  if (!parsed.success) {
    throw new Error("Invalid database name");
  }
  const database = parsed.data;
  const project = await loadProjectWithServers(projectId);
  if (!project) throw new Error("Project not found");

  // Guard the project's configured database — dropping it would break the panel
  // and every other operation that targets it. The worker re-checks too.
  if (database === project.dbName) {
    throw new Error("Cannot drop the project's configured database");
  }

  const taskId = await createTask({
    projectId: project.id,
    userId: session.user.id,
    description: `Drop database (${database})`,
  });
  await inngest.send({
    name: "db/database.drop.requested",
    data: { projectId: project.id, database, taskId },
  });
  return { taskId };
}

export async function renameDatabase(
  projectId: string,
  options: { from: string; to: string }
): Promise<{ taskId: string }> {
  const session = await requireSession();
  if (!projectIdSchema.safeParse(projectId).success) {
    throw new Error("Invalid project id");
  }
  const parsedFrom = databaseNameSchema.safeParse(options.from);
  if (!parsedFrom.success) {
    throw new Error("Invalid database name");
  }
  const parsedTo = databaseNameSchema.safeParse(options.to);
  if (!parsedTo.success) {
    throw new Error("Invalid new database name");
  }
  const from = parsedFrom.data;
  const to = parsedTo.data;
  if (from === to) {
    throw new Error("New name must differ from the current name");
  }
  const project = await loadProjectWithServers(projectId);
  if (!project) throw new Error("Project not found");

  // Guard the project's configured database — renaming it would orphan the
  // panel's configured dbName. The worker re-checks too.
  if (from === project.dbName) {
    throw new Error("Cannot rename the project's configured database");
  }

  const taskId = await createTask({
    projectId: project.id,
    userId: session.user.id,
    description: `Rename database (${from} → ${to})`,
  });
  await inngest.send({
    name: "db/database.rename.requested",
    data: { projectId: project.id, from, to, taskId },
  });
  return { taskId };
}

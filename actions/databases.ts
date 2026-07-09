"use server";

import { unstable_cache } from "next/cache";
import { requireSession } from "@/lib/auth-session";
import { dbListCacheTag } from "@/lib/db-cache-tags";
import { loadProjectWithServers } from "@/lib/projects";
import { enqueue } from "@/lib/queue";
import { createRun } from "@/lib/run-progress";
import { buildDbShellCommand, buildSqlcmdCommand } from "@/lib/services";
import { shq } from "@/lib/sh";
import { executeRemoteCommand } from "@/lib/ssh";
import { databaseNameSchema, projectIdSchema } from "@/lib/validation";

export interface DatabaseEntry {
  name: string;
  isDefault: boolean;
  // On-disk size in bytes. Best-effort: undefined when the probe couldn't
  // measure it (e.g. the injected default db, or a size column that failed to
  // parse). The UI simply omits the badge when absent.
  sizeBytes?: number;
}

type DatabaseListResult =
  | { success: true; data: DatabaseEntry[] }
  | { success: false; error: string };

// The actual SSH probe, with no session/request state so it is safe to wrap in
// `unstable_cache`. Throws on any failure so a transient SSH error is NOT
// cached — only successful listings are stored (see getDatabaseList).
async function probeDatabaseList(projectId: string): Promise<DatabaseEntry[]> {
  const project = await loadProjectWithServers(projectId);
  if (!project) {
    throw new Error("Project not found");
  }

  let cmd: string;
  if (project.dbType === "mssql") {
    if (!project.dbPassword) {
      throw new Error("Project dbPassword is required to list MSSQL databases");
    }
    // Skip the four system databases (database_id 1-4: master, tempdb, model,
    // msdb). `-h -1` drops the header, `-W` trims trailing spaces so each line
    // is a clean database name. `SET NOCOUNT ON` suppresses the row-count tail.
    // Emit `name|sizeBytes` (size = SUM of file pages × 8 KB) so listing and
    // size come back in one round-trip; parsing tolerates a missing size.
    const query =
      "SET NOCOUNT ON; SELECT name + '|' + CAST(CAST((SELECT SUM(mf.size) FROM sys.master_files mf WHERE mf.database_id = d.database_id) AS BIGINT) * 8192 AS VARCHAR(32)) FROM sys.databases d WHERE database_id > 4 ORDER BY name;";
    cmd = buildSqlcmdCommand(
      query,
      project.dbPassword,
      project.dbServiceType,
      project.dbServiceName,
      ["-h", "-1", "-W"]
    );
  } else {
    // `-tAc`: tuples-only, unaligned, run-command — one `datname|sizeBytes` per
    // line (pg_database_size gives on-disk bytes). Exclude template databases
    // (template0/template1) which can't be backed up or restored into.
    const query =
      "SELECT datname || '|' || pg_database_size(datname) FROM pg_database WHERE datistemplate = false ORDER BY datname";
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
  // Each line is `name|sizeBytes`. Split on the first `|` only — validated
  // database names never contain one, and a line with no `|` (older query, or
  // a size that failed to compute) still yields a usable name.
  const entries = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sep = line.indexOf("|");
      const name = sep >= 0 ? line.slice(0, sep) : line;
      const sizeStr = sep >= 0 ? line.slice(sep + 1).trim() : "";
      const size = Number(sizeStr);
      return {
        name,
        sizeBytes:
          sizeStr !== "" && Number.isFinite(size) && size >= 0
            ? size
            : undefined,
      };
    });
  // Always surface the configured database, even if the enumeration somehow
  // missed it (permissions, race), and mark it as the default.
  if (!entries.some((e) => e.name === project.dbName)) {
    entries.unshift({ name: project.dbName, sizeBytes: undefined });
  }
  return entries.map((e) => ({
    ...e,
    isDefault: e.name === project.dbName,
  }));
}

// Enumerate the databases that live on the project's DB server, so the picker
// can offer targets other than the project's configured "default" database.
// Synchronous SSH (like getBackupList), so the result is cached per project for
// a short window to keep repeat navigations off the remote host; the timeout
// guard in executeRemoteCommand bounds a cold miss.
export async function getDatabaseList(
  projectId: string
): Promise<DatabaseListResult> {
  await requireSession();
  if (!projectIdSchema.safeParse(projectId).success) {
    return { success: false, error: "Invalid project id" };
  }
  try {
    const data = await unstable_cache(
      () => probeDatabaseList(projectId),
      ["db-list", projectId],
      { tags: [dbListCacheTag(projectId)], revalidate: 30 }
    )();
    return { success: true, data };
  } catch (error) {
    // Don't surface raw SSH stderr (paths, hostnames) to the client. "Project
    // not found" / the mssql-password message are safe and stay verbatim.
    const message = (error as Error).message;
    if (message === "Project not found" || message.startsWith("Project ")) {
      return { success: false, error: message };
    }
    console.error(`Failed to list databases for project ${projectId}:`, error);
    return { success: false, error: "Failed to list databases" };
  }
}

export async function createDatabase(
  projectId: string,
  options: { database: string }
): Promise<{ runId: string }> {
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

  const runId = await createRun({
    projectId: project.id,
    userId: session.user.id,
    description: `Create database (${database})`,
  });
  await enqueue("db/database.create.requested", {
    projectId: project.id,
    database,
    runId,
  });
  return { runId };
}

export async function dropDatabase(
  projectId: string,
  options: { database: string }
): Promise<{ runId: string }> {
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

  const runId = await createRun({
    projectId: project.id,
    userId: session.user.id,
    description: `Drop database (${database})`,
  });
  await enqueue("db/database.drop.requested", {
    projectId: project.id,
    database,
    runId,
  });
  return { runId };
}

export async function renameDatabase(
  projectId: string,
  options: { from: string; to: string }
): Promise<{ runId: string }> {
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

  const runId = await createRun({
    projectId: project.id,
    userId: session.user.id,
    description: `Rename database (${from} → ${to})`,
  });
  await enqueue("db/database.rename.requested", {
    projectId: project.id,
    from,
    to,
    runId,
  });
  return { runId };
}

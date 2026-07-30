"use server";

import { unstable_cache } from "next/cache";
import { requireCapability, requireSession } from "@/lib/auth-session";
import { dbListCacheTag } from "@/lib/db-cache-tags";
import { loadEnvironmentWithServers } from "@/lib/environments";
import { enqueue } from "@/lib/queue";
import { createRun } from "@/lib/run-progress";
import {
  buildDbShellCommand,
  buildSqlcmdCommand,
  dbConfig,
} from "@/lib/services";
import { shq } from "@/lib/sh";
import { executeRemoteCommand } from "@/lib/ssh";
import { databaseNameSchema, uuidSchema } from "@/lib/validation";

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
async function probeDatabaseList(
  environmentId: string
): Promise<DatabaseEntry[]> {
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) {
    throw new Error("Environment not found");
  }

  const dbSvc = dbConfig(environment);
  let cmd: string;
  if (dbSvc.dbType === "mssql") {
    if (!dbSvc.dbPassword) {
      throw new Error(
        "Environment dbPassword is required to list MSSQL databases"
      );
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
      dbSvc.dbPassword,
      dbSvc.serviceType,
      dbSvc.serviceName,
      ["-h", "-1", "-W"]
    );
  } else {
    // `-tAc`: tuples-only, unaligned, run-command — one `datname|sizeBytes` per
    // line (pg_database_size gives on-disk bytes). Exclude template databases
    // (template0/template1) which can't be backed up or restored into.
    const query =
      "SELECT datname || '|' || pg_database_size(datname) FROM pg_database WHERE datistemplate = false ORDER BY datname";
    const inner = `psql -U postgres -tAc ${shq(query)}`;
    cmd = buildDbShellCommand(dbSvc.serviceType, dbSvc.serviceName, inner, {
      runAsUser: "postgres",
      sudoPassword: dbSvc.server.password,
    });
  }

  const output = await executeRemoteCommand(
    {
      host: dbSvc.server.host,
      username: dbSvc.server.username,
      password: dbSvc.server.password,
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
  if (!entries.some((e) => e.name === dbSvc.dbName)) {
    entries.unshift({ name: dbSvc.dbName, sizeBytes: undefined });
  }
  return entries.map((e) => ({
    ...e,
    isDefault: e.name === dbSvc.dbName,
  }));
}

// Enumerate the databases that live on the environment's DB server, so the picker
// can offer targets other than the environment's configured "default" database.
// Synchronous SSH (like getBackupList), so the result is cached per environment for
// a short window to keep repeat navigations off the remote host; the timeout
// guard in executeRemoteCommand bounds a cold miss.
export async function getDatabaseList(
  environmentId: string
): Promise<DatabaseListResult> {
  await requireSession();
  if (!uuidSchema.safeParse(environmentId).success) {
    return { success: false, error: "Invalid environment id" };
  }
  try {
    const data = await unstable_cache(
      () => probeDatabaseList(environmentId),
      ["db-list", environmentId],
      { tags: [dbListCacheTag(environmentId)], revalidate: 30 }
    )();
    return { success: true, data };
  } catch (error) {
    // Don't surface raw SSH stderr (paths, hostnames) to the client. "Environment
    // not found" / the mssql-password message are safe and stay verbatim.
    const message = (error as Error).message;
    if (
      message === "Environment not found" ||
      message.startsWith("Environment ")
    ) {
      return { success: false, error: message };
    }
    console.error(
      `Failed to list databases for environment ${environmentId}:`,
      error
    );
    return { success: false, error: "Failed to list databases" };
  }
}

export async function createDatabase(
  environmentId: string,
  options: { database: string }
): Promise<{ runId: string }> {
  if (!uuidSchema.safeParse(environmentId).success) {
    throw new Error("Invalid environment id");
  }
  const session = await requireCapability("ops.destructive", {
    environmentId: environmentId,
  });
  const parsed = databaseNameSchema.safeParse(options.database);
  if (!parsed.success) {
    throw new Error("Invalid database name");
  }
  const database = parsed.data;
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) throw new Error("Environment not found");

  const runId = await createRun({
    environmentId: environment.id,
    userId: session.user.id,
    description: `Create database (${database})`,
  });
  await enqueue("db/database.create.requested", {
    environmentId: environment.id,
    database,
    runId,
  });
  return { runId };
}

export async function dropDatabase(
  environmentId: string,
  options: { database: string }
): Promise<{ runId: string }> {
  if (!uuidSchema.safeParse(environmentId).success) {
    throw new Error("Invalid environment id");
  }
  const session = await requireCapability("ops.destructive", {
    environmentId: environmentId,
  });
  const parsed = databaseNameSchema.safeParse(options.database);
  if (!parsed.success) {
    throw new Error("Invalid database name");
  }
  const database = parsed.data;
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) throw new Error("Environment not found");

  // Guard the environment's configured database — dropping it would break the panel
  // and every other operation that targets it. The worker re-checks too.
  if (database === dbConfig(environment).dbName) {
    throw new Error("Cannot drop the environment's configured database");
  }

  const runId = await createRun({
    environmentId: environment.id,
    userId: session.user.id,
    description: `Drop database (${database})`,
  });
  await enqueue("db/database.drop.requested", {
    environmentId: environment.id,
    database,
    runId,
  });
  return { runId };
}

export async function renameDatabase(
  environmentId: string,
  options: { from: string; to: string }
): Promise<{ runId: string }> {
  if (!uuidSchema.safeParse(environmentId).success) {
    throw new Error("Invalid environment id");
  }
  const session = await requireCapability("ops.destructive", {
    environmentId: environmentId,
  });
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
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) throw new Error("Environment not found");

  // Guard the environment's configured database — renaming it would orphan the
  // panel's configured dbName. The worker re-checks too.
  if (from === dbConfig(environment).dbName) {
    throw new Error("Cannot rename the environment's configured database");
  }

  const runId = await createRun({
    environmentId: environment.id,
    userId: session.user.id,
    description: `Rename database (${from} → ${to})`,
  });
  await enqueue("db/database.rename.requested", {
    environmentId: environment.id,
    from,
    to,
    runId,
  });
  return { runId };
}

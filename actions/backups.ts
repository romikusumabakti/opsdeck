"use server";

import { unstable_cache, updateTag } from "next/cache";
import { requireCapability, requireSession } from "@/lib/auth-session";
import { backupListCacheTag } from "@/lib/db-cache-tags";
import { loadEnvironmentWithServers } from "@/lib/environments";
import { enqueue } from "@/lib/queue";
import { createRun } from "@/lib/run-progress";
import { buildDbShellCommand, dbConfig } from "@/lib/services";
import { shq } from "@/lib/sh";
import { executeRemoteCommand } from "@/lib/ssh";
import type { Backup } from "@/lib/types";
import {
  backupFilenameSchema,
  databaseNameSchema,
  uuidSchema,
} from "@/lib/validation";

type BackupListResult =
  | { success: true; data: Backup[] }
  | { success: false; error: string };

// Resolve the operation's target database. An omitted target (or one equal to
// the environment's configured database) means the trusted "default database" and
// bypasses validation. Any other, client-supplied database is validated against
// databaseNameSchema before it reaches a shell/SQL command.
function resolveTargetDatabase(
  environment: { dbName: string },
  provided: string | undefined
): string {
  if (!provided || provided === environment.dbName) return environment.dbName;
  const parsed = databaseNameSchema.safeParse(provided);
  if (!parsed.success) {
    throw new Error("Invalid database name");
  }
  return parsed.data;
}

// The SSH probe with no session/request state, so it is safe inside
// `unstable_cache`. Throws on failure so a transient SSH error is not cached.
async function probeBackupList(environmentId: string): Promise<Backup[]> {
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) {
    throw new Error("Environment not found");
  }
  const dbSvc = dbConfig(environment);
  // Match exactly what createDatabaseBackup writes — `.sql` / `.sql.gz` for
  // postgres (compressed or not) and `.bak` for mssql. Anything else in the
  // folder is ignored so users can't pick an unrestoreable file from the
  // dropdown.
  const extensionPattern =
    dbSvc.dbType === "postgres" ? "\\.sql(\\.gz)?" : "\\.bak";

  // `grep -E` for the optional `.gz` alternation. Run as the DB's OS user
  // for systemd so the listing works even when the backup dir is mode 700
  // (typical for Postgres data dirs and mssql backup dirs); no-op for
  // docker/kubernetes where the exec wrapper already enters the container.
  const inner = `ls -lt ${shq(dbSvc.dbBackupPath)} | grep -E ${shq(`${extensionPattern}$`)} | awk '{print $5, $9}'`;
  const cmd = buildDbShellCommand(dbSvc.serviceType, dbSvc.serviceName, inner, {
    runAsUser: dbSvc.dbType === "postgres" ? "postgres" : "mssql",
    sudoPassword: dbSvc.server.password,
  });
  const output = await executeRemoteCommand(
    {
      host: dbSvc.server.host,
      username: dbSvc.server.username,
      password: dbSvc.server.password,
    },
    cmd
  );

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [size, name] = line.trim().split(/\s+/);
      return size && name ? { name, size } : null;
    })
    .filter((entry) => entry !== null);
}

export async function getBackupList(
  environmentId: string
): Promise<BackupListResult> {
  await requireSession();
  if (!uuidSchema.safeParse(environmentId).success) {
    return { success: false, error: "Invalid environment id" };
  }
  try {
    const data = await unstable_cache(
      () => probeBackupList(environmentId),
      ["backup-list", environmentId],
      { tags: [backupListCacheTag(environmentId)], revalidate: 30 }
    )();
    return { success: true, data };
  } catch (error) {
    const message = (error as Error).message;
    if (message === "Environment not found") {
      return { success: false, error: message };
    }
    // Don't surface raw SSH stderr (paths, hostnames) to the client.
    console.error(
      `Failed to fetch backups for environment ${environmentId}:`,
      error
    );
    return { success: false, error: "Failed to fetch backups" };
  }
}

// Drop the cached backup listing so the restore tab reflects a file the worker
// just wrote. Called from the client once a backup run completes — the enqueue
// path can't invalidate because the file only exists after the worker finishes.
export async function revalidateBackupList(
  environmentId: string
): Promise<void> {
  await requireSession();
  if (!uuidSchema.safeParse(environmentId).success) return;
  updateTag(backupListCacheTag(environmentId));
}

export async function createDatabaseBackup(
  environmentId: string,
  options: { compress?: boolean; database?: string } = {}
): Promise<{ runId: string }> {
  if (!uuidSchema.safeParse(environmentId).success) {
    throw new Error("Invalid environment id");
  }
  const session = await requireCapability("ops.destructive", {
    environmentId: environmentId,
  });
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) throw new Error("Environment not found");
  const database = resolveTargetDatabase(
    dbConfig(environment),
    options.database
  );

  const compress = options.compress ?? true;
  const runId = await createRun({
    environmentId: environment.id,
    userId: session.user.id,
    description: compress
      ? `Backup database (${database})`
      : `Backup database (${database}, uncompressed)`,
  });
  // Enqueue only the environmentId + database — the worker re-loads credentials
  // server-side so they never live in the job payload.
  await enqueue("db/backup.requested", {
    environmentId: environment.id,
    compress,
    database,
    runId,
  });
  return { runId };
}

export async function restoreDatabaseBackup(
  environmentId: string,
  options: {
    filename: string;
    restartBackend?: boolean;
    database?: string;
    sourceEnvironmentId?: string;
  }
): Promise<{ runId: string }> {
  if (!uuidSchema.safeParse(environmentId).success) {
    throw new Error("Invalid environment id");
  }
  const session = await requireCapability("ops.destructive", {
    environmentId: environmentId,
  });
  const parsedFilename = backupFilenameSchema.safeParse(options.filename);
  if (!parsedFilename.success) {
    throw new Error("Invalid backup filename");
  }
  const filename = parsedFilename.data;
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) throw new Error("Environment not found");
  const dbSvc = dbConfig(environment);
  const database = resolveTargetDatabase(dbSvc, options.database);

  // Resolve an optional cross-environment source. A source equal to (or omitting)
  // the target reads the backup from the target's own dir as before. Any other
  // source must share the target's dbType (postgres↔postgres, mssql↔mssql); the
  // worker reads it directly when the DB location also matches, otherwise it
  // stages the file across hosts.
  let sourceEnvironmentId: string | undefined;
  if (
    options.sourceEnvironmentId &&
    options.sourceEnvironmentId !== environmentId
  ) {
    if (!uuidSchema.safeParse(options.sourceEnvironmentId).success) {
      throw new Error("Invalid source environment id");
    }
    const source = await loadEnvironmentWithServers(
      options.sourceEnvironmentId
    );
    if (!source) throw new Error("Source environment not found");
    if (dbConfig(source).dbType !== dbSvc.dbType) {
      throw new Error("Source environment must have the same database type");
    }
    sourceEnvironmentId = source.id;
  }

  const isDefault = database === dbSvc.dbName;
  const runId = await createRun({
    environmentId: environment.id,
    userId: session.user.id,
    description: options.restartBackend
      ? `Restore database ${database} from ${filename} (+ restart backend)`
      : `Restore database ${database} from ${filename}`,
  });
  await enqueue("db/restore.requested", {
    environmentId: environment.id,
    filename,
    // Only forward a non-default target so the worker keeps using its trusted
    // environment.dbName when restoring the default database.
    database: isDefault ? undefined : database,
    restartBackend: options.restartBackend ?? false,
    sourceEnvironmentId,
    runId,
  });
  return { runId };
}

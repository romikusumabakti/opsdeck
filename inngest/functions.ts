import type { ProjectWithServers } from "@/lib/db/schema";
import { loadProjectWithServers } from "@/lib/projects";
import {
  buildControlCommand,
  buildDbShellCommand,
  buildSqlcmdCommand,
  getServiceConfig,
  type ServiceAction,
  type ServiceRole,
} from "@/lib/services";
import { shq } from "@/lib/sh";
import { executeRemoteCommand } from "@/lib/ssh";
import { appendTaskOutput, completeTask, failTask } from "@/lib/task-progress";
import { inngest } from "./client";

// Inngest's step.run signature is generic and Jsonifies its return type, which
// breaks a strict generic wrapper. Use a loose shape here and cast back at the
// call sites — runtime values are unchanged, the Jsonify is purely for the
// memoization layer.
type StepShape = {
  run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>;
};

// Wraps a step so its label is appended to task output before/after running,
// and any thrown error gets logged then surfaced as a task failure.
async function tracked<T>(
  taskId: string,
  step: StepShape,
  id: string,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  await step.run(`${id}-log-start`, () => appendTaskOutput(taskId, label));
  try {
    return (await step.run(id, fn)) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await step.run(`${id}-log-fail`, () =>
      appendTaskOutput(taskId, `✗ ${label} — ${message}`)
    );
    throw err;
  }
}

// Escape a value used inside a T-SQL single-quoted string literal (e.g. file
// paths in `N'...'`). SQL standard: a single quote is doubled.
function sqlQuoteString(value: string): string {
  return value.replace(/'/g, "''");
}

// Escape a SQL Server identifier wrapped in [brackets]. A literal `]` must be
// doubled to `]]`.
function sqlBracketId(value: string): string {
  return value.replace(/]/g, "]]");
}

// Escape a Postgres identifier wrapped in "double quotes". A literal `"` must
// be doubled to `""`.
function pgQuoteId(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

// Escape a value used inside a Postgres 'single-quoted' string literal (e.g. a
// datname compared in WHERE). A single quote is doubled.
function pgQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export const createDatabaseBackup = inngest.createFunction(
  {
    id: "create-db-backup",
    triggers: { event: "db/backup.requested" },
    // No auto-retry: the per-attempt catch marks the task `failed` immediately,
    // so retrying would leave a failed task row while the work re-runs.
    // Operators re-trigger from the UI. Matches the other side-effecting funcs.
    retries: 0,
  },
  async ({ event, step }) => {
    const { taskId, compress, projectId, database } = event.data as {
      projectId: string;
      taskId: string;
      compress?: boolean;
      database?: string;
    };
    const project = await loadProjectWithServers(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const useCompression = compress ?? true;
    // Fall back to the project's configured database when no explicit target is
    // sent (backups of the "default database"). The action layer has already
    // validated any non-default `database` against databaseNameSchema.
    const dbName = database ?? project.dbName;

    const credentials = {
      host: project.dbServer.host,
      username: project.dbServer.username,
      password: project.dbServer.password,
    };

    try {
      await tracked(
        taskId,
        step,
        "ensure-backup-dir",
        "Ensuring backup directory exists",
        async () => {
          // Run as the DB's OS user so the directory ends up owned by the
          // process that later writes into it: pg_dump runs as `postgres`,
          // and SQL Server's BACKUP DATABASE writes the .bak file from the
          // `mssql` server process. No-op `runAsUser` for docker/kubernetes
          // — the exec wrapper already enters the container.
          const runAsUser =
            project.dbType === "postgres" ? "postgres" : "mssql";
          const mkdirCmd = buildDbShellCommand(
            project.dbServiceType,
            project.dbServiceName,
            `mkdir -p ${shq(project.dbBackupPath)}`,
            { runAsUser, sudoPassword: credentials.password }
          );
          await executeRemoteCommand(credentials, mkdirCmd);
        }
      );

      const filename = await tracked(
        taskId,
        step,
        "run-backup",
        `Running ${project.dbType === "mssql" ? "BACKUP DATABASE" : "pg_dump"} for ${dbName}${useCompression ? "" : " (uncompressed)"}`,
        async () => {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          if (project.dbType === "mssql") {
            return await runMssqlBackup(
              project,
              dbName,
              ts,
              credentials,
              useCompression
            );
          }
          return await runPostgresBackup(
            project,
            dbName,
            ts,
            credentials,
            useCompression
          );
        }
      );

      await step.run("finish", async () => {
        await appendTaskOutput(taskId, `✓ Backup file created: ${filename}`);
        await completeTask(taskId);
      });

      return { success: true, filename };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.run("record-failure", () => failTask(taskId, message));
      throw err;
    }
  }
);

async function runPostgresBackup(
  project: ProjectWithServers,
  database: string,
  ts: string,
  credentials: { host: string; username: string; password: string },
  compress: boolean
): Promise<string> {
  const fname = compress ? `${database}_${ts}.sql.gz` : `${database}_${ts}.sql`;
  const target = `${project.dbBackupPath}/${fname}`;
  // `--clean --if-exists` emits idempotent DROP IF EXISTS for every object
  // before the CREATE statements, so the dump can be restored into a database
  // that already has the schema (otherwise CREATE TABLE errors out on
  // re-restore). When piping through gzip, `set -o pipefail` so pg_dump
  // failures bubble up instead of getting masked by gzip's exit 0.
  const dumpCmd = `pg_dump -U postgres --clean --if-exists ${shq(database)}`;
  const inner = compress
    ? `set -o pipefail; ${dumpCmd} | gzip > ${shq(target)}`
    : `${dumpCmd} > ${shq(target)}`;
  // `runAsUser: "postgres"` satisfies systemd-postgres peer auth (and is a
  // no-op for docker/kubernetes, which already enter the container as the
  // appropriate user).
  const cmd = buildDbShellCommand(
    project.dbServiceType,
    project.dbServiceName,
    inner,
    { runAsUser: "postgres", sudoPassword: credentials.password }
  );
  await executeRemoteCommand(credentials, cmd);
  return fname;
}

async function runMssqlBackup(
  project: ProjectWithServers,
  database: string,
  ts: string,
  credentials: { host: string; username: string; password: string },
  compress: boolean
): Promise<string> {
  if (!project.dbPassword) {
    throw new Error(
      "Project dbPassword is required for MSSQL backups (sqlcmd needs it)"
    );
  }
  const fname = `${database}_${ts}.bak`;
  const target = `${project.dbBackupPath}/${fname}`;
  // MSSQL .bak format is the same regardless of compression — the COMPRESSION
  // option just toggles internal block-level compression. NO_COMPRESSION is
  // the explicit opt-out (also the engine default when omitted, but explicit
  // is clearer in the audit log).
  const compressionClause = compress ? "COMPRESSION" : "NO_COMPRESSION";
  const query =
    `BACKUP DATABASE [${sqlBracketId(database)}] ` +
    `TO DISK = N'${sqlQuoteString(target)}' ` +
    `WITH FORMAT, INIT, ${compressionClause}, STATS = 5`;
  // Pipe the SQL into sqlcmd via stdin so the query (which contains quotes and
  // brackets) doesn't have to survive shell parsing. `-C` trusts the server
  // cert (required by mssql-tools18 against the default self-signed cert).
  // `-r0` routes severity ≥11 messages to stderr so failures surface in the
  // SSH error path instead of being silently swallowed on stdout.
  const cmd = buildSqlcmdCommand(
    query,
    project.dbPassword,
    project.dbServiceType,
    project.dbServiceName
  );
  await executeRemoteCommand(credentials, cmd);
  return fname;
}

export const mockProjectTimeLegacy = inngest.createFunction(
  {
    id: "mock-project-time-legacy",
    triggers: { event: "project/mock-time.legacy" },
    // Destructive (sets system clock, disables NTP); a blind retry of a
    // partially-applied run would re-disable NTP / re-skew the clock. The
    // function records its own failure and recovery hint instead.
    retries: 0,
  },
  async ({ event, step }) => {
    const { projectId, mockedAt, taskId } = event.data as {
      projectId: string;
      mockedAt: string;
      taskId: string;
    };
    const project = await loadProjectWithServers(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const credentials = {
      host: project.backendServer.host,
      username: project.backendServer.username,
      password: project.backendServer.password,
    };

    // `date -s` expects "YYYY-MM-DD HH:MM:SS"; convert from ISO so the shell
    // gets a clean argument and we don't depend on the remote host's locale.
    const d = new Date(mockedAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateArg = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
      d.getUTCDate()
    )} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(
      d.getUTCSeconds()
    )}`;

    // `sudo -S` reads the password from stdin. Piping via `printf '%s\n'`
    // with a properly shell-quoted argument keeps a password containing
    // single quotes or shell metacharacters from breaking the command (or,
    // worse, becoming a command injection).
    const sudo = (cmd: string) =>
      `printf '%s\\n' ${shq(credentials.password)} | sudo -S ${cmd}`;

    try {
      await tracked(
        taskId,
        step,
        "disable-ntp",
        "Disabling NTP on backend server",
        async () => {
          // Stops the time daemon from reverting our manual override mid-test.
          // `timedatectl set-ntp false` errors with "NTP not supported" when no
          // NTP unit is registered (e.g. chronyd disabled, no timesyncd) — that
          // just means there is nothing to revert our clock, so swallow it. Also
          // stop the daemons directly to cover a running-but-unregistered one.
          await executeRemoteCommand(
            credentials,
            sudo(
              "timedatectl set-ntp false 2>/dev/null; " +
                "systemctl stop chronyd systemd-timesyncd 2>/dev/null; true"
            )
          );
        }
      );

      await tracked(
        taskId,
        step,
        "set-system-time",
        `Setting system time to ${dateArg} UTC`,
        async () => {
          await executeRemoteCommand(
            credentials,
            sudo(`date -u -s ${shq(dateArg)}`)
          );
        }
      );

      await tracked(
        taskId,
        step,
        "restart-backend",
        `Restarting backend service ${project.backendServiceName}`,
        async () => {
          const cmd = buildControlCommand(
            project.backendServiceType,
            project.backendServiceName,
            "restart",
            credentials.password
          );
          await executeRemoteCommand(credentials, cmd);
        }
      );

      await step.run("finish", async () => {
        await appendTaskOutput(taskId, "✓ Mock-time complete");
        await completeTask(taskId);
      });

      return { success: true, mockedAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Heads-up for the operator: by the time we reach here, NTP is off and
      // the system clock may already be set. The server is in an inconsistent
      // state until someone re-enables NTP — surface that in the task log so
      // it's obvious from the UI without digging into the failure.
      await step.run("record-failure", async () => {
        await appendTaskOutput(
          taskId,
          "⚠ Backend server may be in inconsistent state — NTP disabled and time potentially overridden. " +
            "To recover, run `sudo timedatectl set-ntp true` on the backend server."
        );
        await failTask(taskId, message);
      });
      throw err;
    }
  }
);

export const mockProjectTimeResetLegacy = inngest.createFunction(
  {
    id: "mock-project-time-reset-legacy",
    triggers: { event: "project/mock-time.reset-legacy" },
    retries: 0,
  },
  async ({ event, step }) => {
    const { projectId, taskId } = event.data as {
      projectId: string;
      taskId: string;
    };
    const project = await loadProjectWithServers(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const credentials = {
      host: project.backendServer.host,
      username: project.backendServer.username,
      password: project.backendServer.password,
    };

    const sudo = (cmd: string) =>
      `printf '%s\\n' ${shq(credentials.password)} | sudo -S ${cmd}`;

    try {
      await tracked(
        taskId,
        step,
        "enable-ntp",
        "Re-enabling NTP on backend server",
        async () => {
          // Mirror disable-ntp: `set-ntp true` fails with "NTP not supported"
          // on hosts with no registered NTP unit. Start chronyd directly there
          // so the clock can resync; keep the step green either way.
          await executeRemoteCommand(
            credentials,
            sudo(
              "timedatectl set-ntp true 2>/dev/null; " +
                "systemctl start chronyd systemd-timesyncd 2>/dev/null; true"
            )
          );
        }
      );

      // Force an immediate resync. NTP just re-enables polling — without a
      // restart, the host can sit on the mocked time for a polling interval.
      // Try systemd-timesyncd and chronyd; `|| true` keeps the step green when
      // only one of them is installed.
      await tracked(
        taskId,
        step,
        "sync-clock",
        "Forcing immediate clock sync",
        async () => {
          await executeRemoteCommand(
            credentials,
            sudo(
              "systemctl restart systemd-timesyncd 2>/dev/null || systemctl restart chronyd 2>/dev/null || true"
            )
          );
        }
      );

      await tracked(
        taskId,
        step,
        "restart-backend",
        `Restarting backend service ${project.backendServiceName}`,
        async () => {
          const cmd = buildControlCommand(
            project.backendServiceType,
            project.backendServiceName,
            "restart",
            credentials.password
          );
          await executeRemoteCommand(credentials, cmd);
        }
      );

      await step.run("finish", async () => {
        await appendTaskOutput(taskId, "✓ Clock reset complete");
        await completeTask(taskId);
      });

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.run("record-failure", async () => {
        await failTask(taskId, message);
      });
      throw err;
    }
  }
);

export const restoreDatabaseBackup = inngest.createFunction(
  {
    id: "restore-db-backup",
    triggers: { event: "db/restore.requested" },
    // Destructive (drops + recreates the database); never auto-retry a
    // partial restore.
    retries: 0,
  },
  async ({ event, step }) => {
    const { projectId, filename, taskId, restartBackend, database } =
      event.data as {
        projectId: string;
        filename: string;
        taskId: string;
        restartBackend?: boolean;
        database?: string;
      };
    const data = await loadProjectWithServers(projectId);
    if (!data) throw new Error(`Project ${projectId} not found`);
    // Restore target — the configured database unless the picker sent another
    // one (already validated by the action layer).
    const dbName = database ?? data.dbName;
    const credentials = {
      host: data.dbServer.host,
      username: data.dbServer.username,
      password: data.dbServer.password,
    };

    try {
      if (!filename) throw new Error("Filename is required");

      if (data.dbType === "mssql") {
        await tracked(
          taskId,
          step,
          "perform-restore",
          `Restoring ${dbName} from ${filename}`,
          async () => {
            await runMssqlRestore(data, dbName, filename, credentials);
          }
        );
      } else {
        await tracked(
          taskId,
          step,
          "recreate-database",
          `Dropping and recreating ${dbName}`,
          async () => {
            await runPostgresRecreateDatabase(data, dbName, credentials);
          }
        );
        await tracked(
          taskId,
          step,
          "perform-restore",
          `Restoring from ${filename}`,
          async () => {
            await runPostgresRestore(data, dbName, filename, credentials);
          }
        );
      }

      // Optional follow-up: restart backend so it picks up the fresh DB state
      // (drops stale connections, clears in-memory caches). Runs against the
      // backend server's credentials, not the DB server's.
      if (restartBackend) {
        await tracked(
          taskId,
          step,
          "restart-backend",
          `Restarting backend ${data.backendServiceName}`,
          async () => {
            const backendCreds = {
              host: data.backendServer.host,
              username: data.backendServer.username,
              password: data.backendServer.password,
            };
            const cmd = buildControlCommand(
              data.backendServiceType,
              data.backendServiceName,
              "restart",
              backendCreds.password
            );
            await executeRemoteCommand(backendCreds, cmd);
          }
        );
      }

      await step.run("finish", async () => {
        await appendTaskOutput(taskId, `✓ Restore complete (${filename})`);
        await completeTask(taskId);
      });

      return { success: true, restored: filename };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.run("record-failure", () => failTask(taskId, message));
      throw err;
    }
  }
);

async function runPostgresRecreateDatabase(
  data: ProjectWithServers,
  database: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  // `WITH (FORCE)` (Postgres 13+) terminates active connections so the DROP
  // doesn't fail with "database is being accessed by other users". Then
  // recreate so the dump pipes into a clean DB — this lets us handle dumps
  // produced both with and without `--clean --if-exists`.
  const dbId = pgQuoteId(database);
  const query = `DROP DATABASE IF EXISTS ${dbId} WITH (FORCE); CREATE DATABASE ${dbId};`;
  // Pipe the query inside the inner shell so the pipeline doesn't compete
  // with sudo -S's stdin on systemd; `runAsUser: "postgres"` is a no-op for
  // docker/kubernetes.
  const inner = `printf '%s\\n' ${shq(query)} | psql -v ON_ERROR_STOP=on -U postgres -d postgres`;
  const cmd = buildDbShellCommand(
    data.dbServiceType,
    data.dbServiceName,
    inner,
    { runAsUser: "postgres", sudoPassword: credentials.password }
  );
  await executeRemoteCommand(credentials, cmd);
}

async function runPostgresRestore(
  data: ProjectWithServers,
  database: string,
  filename: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  const source = `${data.dbBackupPath}/${filename}`;
  // `-v ON_ERROR_STOP=on` aborts psql at the first failing statement instead
  // of silently continuing through a half-broken restore. Branch on the file
  // suffix so we can restore both gzipped (`.sql.gz`) and plain (`.sql`)
  // dumps produced by createDatabaseBackup.
  const psqlCmd = `psql -v ON_ERROR_STOP=on -U postgres -d ${shq(database)}`;
  const inner = filename.endsWith(".gz")
    ? `set -o pipefail; gunzip -c ${shq(source)} | ${psqlCmd}`
    : `${psqlCmd} < ${shq(source)}`;
  const cmd = buildDbShellCommand(
    data.dbServiceType,
    data.dbServiceName,
    inner,
    { runAsUser: "postgres", sudoPassword: credentials.password }
  );
  await executeRemoteCommand(credentials, cmd);
}

export const controlService = inngest.createFunction(
  {
    id: "control-service",
    triggers: { event: "service/control.requested" },
    // No auto-retry: start/stop/restart is side-effecting and the per-attempt
    // catch already marks the task `failed`. Retrying could e.g. restart a
    // service repeatedly on a transient SSH error.
    retries: 0,
  },
  async ({ event, step }) => {
    const { projectId, role, action, taskId } = event.data as {
      projectId: string;
      role: ServiceRole;
      action: ServiceAction;
      taskId: string;
    };
    const project = await loadProjectWithServers(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const cfg = getServiceConfig(project, role);
    const credentials = {
      host: cfg.server.host,
      username: cfg.server.username,
      password: cfg.server.password,
    };

    try {
      await tracked(
        taskId,
        step,
        "service-control",
        `${action} ${cfg.serviceName} (${cfg.serviceType})`,
        async () => {
          const cmd = buildControlCommand(
            cfg.serviceType,
            cfg.serviceName,
            action,
            credentials.password
          );
          const output = await executeRemoteCommand(credentials, cmd);
          const trimmed = output.trim();
          if (trimmed) {
            await appendTaskOutput(taskId, trimmed);
          }
        }
      );

      await step.run("finish", async () => {
        await appendTaskOutput(
          taskId,
          `✓ ${action} ${cfg.serviceName} complete`
        );
        await completeTask(taskId);
      });

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.run("record-failure", () => failTask(taskId, message));
      throw err;
    }
  }
);

// A logical file inside a SQL Server `.bak`, as reported by RESTORE
// FILELISTONLY. `type`: D = data, L = log, S = FILESTREAM, F = full-text.
type MssqlBackupFile = { logical: string; physical: string; type: string };

// POSIX dirname for the physical paths SQL Server reports (always `/`-style
// inside the Linux container). Keeps a file in the same directory it was
// backed up from when we relocate it.
function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

// Read the logical file layout of a backup so we can build WITH MOVE clauses.
// Output is forced parseable: `-h -1` drops headers, `-W` trims padding, and
// `-s ~` separates columns with a char that won't appear in a path/logical
// name. We only keep rows whose 3rd column is a known file type, which also
// filters sqlcmd's trailing "(N rows affected)" line.
async function getMssqlBackupFileList(
  data: ProjectWithServers,
  source: string,
  credentials: { host: string; username: string; password: string }
): Promise<MssqlBackupFile[]> {
  const query = `RESTORE FILELISTONLY FROM DISK = N'${sqlQuoteString(source)}';`;
  const cmd = buildSqlcmdCommand(
    query,
    data.dbPassword!,
    data.dbServiceType,
    data.dbServiceName,
    ["-h", "-1", "-W", "-s", "~"]
  );
  const out = await executeRemoteCommand(credentials, cmd);
  const files: MssqlBackupFile[] = [];
  for (const line of out.split("\n")) {
    const parts = line.split("~");
    if (parts.length < 3) continue;
    const type = parts[2]?.trim().toUpperCase();
    if (type !== "D" && type !== "L" && type !== "S" && type !== "F") continue;
    files.push({ logical: parts[0].trim(), physical: parts[1].trim(), type });
  }
  if (files.length === 0) {
    throw new Error(`Could not read file list from backup: ${source}`);
  }
  return files;
}

// Map each logical file in the backup to a fresh physical path named after the
// TARGET database. Without this, restoring one DB's backup into a differently
// named DB (e.g. car2's .bak into car3) fails with Msg 1834/3156 because the
// backup's stored paths point at the source DB's live, in-use files. First
// data file → .mdf, extra data files → .ndf, logs → .ldf, all kept in their
// original directory.
function buildMssqlMoveClauses(
  files: MssqlBackupFile[],
  database: string
): string[] {
  let dataIdx = 0;
  let logIdx = 0;
  return files.map((f) => {
    const dir = posixDirname(f.physical);
    let name: string;
    if (f.type === "L") {
      name = `${database}_log${logIdx ? `_${logIdx}` : ""}.ldf`;
      logIdx++;
    } else if (dataIdx === 0) {
      name = `${database}.mdf`;
      dataIdx++;
    } else {
      name = `${database}_${dataIdx}.ndf`;
      dataIdx++;
    }
    const newPath = `${dir}/${name}`;
    return `  MOVE N'${sqlQuoteString(f.logical)}' TO N'${sqlQuoteString(newPath)}'`;
  });
}

async function runMssqlRestore(
  data: ProjectWithServers,
  database: string,
  filename: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  if (!data.dbPassword) {
    throw new Error(
      "Project dbPassword is required for MSSQL restores (sqlcmd needs it)"
    );
  }
  const source = `${data.dbBackupPath}/${filename}`;
  const dbId = sqlBracketId(database);
  const dbLit = sqlQuoteString(database);

  // Relocate the backup's logical files onto the target DB's own paths so a
  // cross-database restore (backup of DB A into DB B) doesn't collide with the
  // source DB's in-use files.
  const files = await getMssqlBackupFileList(data, source, credentials);
  const moves = buildMssqlMoveClauses(files, database);
  const restoreOptions = ["REPLACE", ...moves].join(",\n  ");

  // Kill connections by flipping to SINGLE_USER, then restore. TRY/CATCH so a
  // failed restore still flips back to MULTI_USER instead of leaving the DB
  // wedged. The DB_ID guard handles a target that doesn't exist yet (fresh
  // restore). THROW surfaces the real SQL error number + message to sqlcmd's
  // non-zero exit instead of the generic "terminating abnormally".
  const query =
    `IF DB_ID(N'${dbLit}') IS NOT NULL\n` +
    `  ALTER DATABASE [${dbId}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n` +
    `BEGIN TRY\n` +
    `  RESTORE DATABASE [${dbId}] FROM DISK = N'${sqlQuoteString(source)}' WITH\n  ${restoreOptions};\n` +
    `END TRY\n` +
    `BEGIN CATCH\n` +
    `  DECLARE @err NVARCHAR(MAX) = ERROR_MESSAGE();\n` +
    `  DECLARE @num INT = ERROR_NUMBER();\n` +
    `  IF DB_ID(N'${dbLit}') IS NOT NULL\n` +
    `    ALTER DATABASE [${dbId}] SET MULTI_USER;\n` +
    `  DECLARE @msg NVARCHAR(2048) = CONCAT('Restore failed (Msg ', @num, '): ', @err);\n` +
    `  THROW 50000, @msg, 1;\n` +
    `END CATCH;\n` +
    `IF DB_ID(N'${dbLit}') IS NOT NULL\n` +
    `  ALTER DATABASE [${dbId}] SET MULTI_USER;`;
  const cmd = buildSqlcmdCommand(
    query,
    data.dbPassword,
    data.dbServiceType,
    data.dbServiceName
  );
  await executeRemoteCommand(credentials, cmd);
}

export const createDatabaseFn = inngest.createFunction(
  {
    id: "create-database",
    triggers: { event: "db/database.create.requested" },
    // No auto-retry: a retried CREATE DATABASE would fail on "already exists"
    // and leave a failed task row while the DB is actually present. The
    // per-attempt catch marks the task failed; operators re-trigger from the UI.
    retries: 0,
  },
  async ({ event, step }) => {
    const { projectId, database, taskId } = event.data as {
      projectId: string;
      database: string;
      taskId: string;
    };
    const project = await loadProjectWithServers(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const credentials = {
      host: project.dbServer.host,
      username: project.dbServer.username,
      password: project.dbServer.password,
    };

    try {
      if (!database) throw new Error("Database name is required");

      await tracked(
        taskId,
        step,
        "create-database",
        `Creating database ${database}`,
        async () => {
          if (project.dbType === "mssql") {
            await runMssqlCreateDatabase(project, database, credentials);
          } else {
            await runPostgresCreateDatabase(project, database, credentials);
          }
        }
      );

      await step.run("finish", async () => {
        await appendTaskOutput(taskId, `✓ Database created: ${database}`);
        await completeTask(taskId);
      });

      return { success: true, database };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.run("record-failure", () => failTask(taskId, message));
      throw err;
    }
  }
);

async function runPostgresCreateDatabase(
  project: ProjectWithServers,
  database: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  const query = `CREATE DATABASE ${pgQuoteId(database)};`;
  const inner = `printf '%s\\n' ${shq(query)} | psql -v ON_ERROR_STOP=on -U postgres -d postgres`;
  const cmd = buildDbShellCommand(
    project.dbServiceType,
    project.dbServiceName,
    inner,
    { runAsUser: "postgres", sudoPassword: credentials.password }
  );
  await executeRemoteCommand(credentials, cmd);
}

async function runMssqlCreateDatabase(
  project: ProjectWithServers,
  database: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  if (!project.dbPassword) {
    throw new Error(
      "Project dbPassword is required for MSSQL database creation (sqlcmd needs it)"
    );
  }
  const query = `CREATE DATABASE [${sqlBracketId(database)}];`;
  const cmd = buildSqlcmdCommand(
    query,
    project.dbPassword,
    project.dbServiceType,
    project.dbServiceName
  );
  await executeRemoteCommand(credentials, cmd);
}

export const dropDatabaseFn = inngest.createFunction(
  {
    id: "drop-database",
    triggers: { event: "db/database.drop.requested" },
    // Destructive (irreversibly drops the database); never auto-retry.
    retries: 0,
  },
  async ({ event, step }) => {
    const { projectId, database, taskId } = event.data as {
      projectId: string;
      database: string;
      taskId: string;
    };
    const project = await loadProjectWithServers(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const credentials = {
      host: project.dbServer.host,
      username: project.dbServer.username,
      password: project.dbServer.password,
    };

    try {
      if (!database) throw new Error("Database name is required");
      // Defence in depth: the action layer already blocks dropping the project's
      // configured database, but re-check here so a hand-crafted event can't
      // wipe the default DB out from under the panel.
      if (database === project.dbName) {
        throw new Error("Refusing to drop the project's configured database");
      }

      await tracked(
        taskId,
        step,
        "drop-database",
        `Dropping database ${database}`,
        async () => {
          if (project.dbType === "mssql") {
            await runMssqlDropDatabase(project, database, credentials);
          } else {
            await runPostgresDropDatabase(project, database, credentials);
          }
        }
      );

      await step.run("finish", async () => {
        await appendTaskOutput(taskId, `✓ Database dropped: ${database}`);
        await completeTask(taskId);
      });

      return { success: true, database };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.run("record-failure", () => failTask(taskId, message));
      throw err;
    }
  }
);

async function runPostgresDropDatabase(
  project: ProjectWithServers,
  database: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  // `WITH (FORCE)` (Postgres 13+) terminates active connections so the DROP
  // doesn't fail with "database is being accessed by other users".
  const query = `DROP DATABASE IF EXISTS ${pgQuoteId(database)} WITH (FORCE);`;
  const inner = `printf '%s\\n' ${shq(query)} | psql -v ON_ERROR_STOP=on -U postgres -d postgres`;
  const cmd = buildDbShellCommand(
    project.dbServiceType,
    project.dbServiceName,
    inner,
    { runAsUser: "postgres", sudoPassword: credentials.password }
  );
  await executeRemoteCommand(credentials, cmd);
}

async function runMssqlDropDatabase(
  project: ProjectWithServers,
  database: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  if (!project.dbPassword) {
    throw new Error(
      "Project dbPassword is required for MSSQL database drop (sqlcmd needs it)"
    );
  }
  const dbId = sqlBracketId(database);
  // Flip to SINGLE_USER WITH ROLLBACK IMMEDIATE to kill active connections,
  // then drop. Guard the ALTER with an existence check so dropping a missing
  // DB is a no-op rather than a hard error.
  const query =
    `IF DB_ID(N'${sqlQuoteString(database)}') IS NOT NULL\n` +
    `BEGIN\n` +
    `  ALTER DATABASE [${dbId}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n` +
    `  DROP DATABASE [${dbId}];\n` +
    `END;`;
  const cmd = buildSqlcmdCommand(
    query,
    project.dbPassword,
    project.dbServiceType,
    project.dbServiceName
  );
  await executeRemoteCommand(credentials, cmd);
}

export const renameDatabaseFn = inngest.createFunction(
  {
    id: "rename-database",
    triggers: { event: "db/database.rename.requested" },
    // Not idempotent: a retried rename would fail because the source no longer
    // exists. The per-attempt catch marks the task failed; operators re-trigger.
    retries: 0,
  },
  async ({ event, step }) => {
    const { projectId, from, to, taskId } = event.data as {
      projectId: string;
      from: string;
      to: string;
      taskId: string;
    };
    const project = await loadProjectWithServers(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const credentials = {
      host: project.dbServer.host,
      username: project.dbServer.username,
      password: project.dbServer.password,
    };

    try {
      if (!from || !to) throw new Error("Source and target names are required");
      if (from === to) throw new Error("New name must differ from the old name");
      // Defence in depth: the action layer already blocks renaming the project's
      // configured database, but re-check here so a hand-crafted event can't
      // orphan the default DB out from under the panel.
      if (from === project.dbName) {
        throw new Error("Refusing to rename the project's configured database");
      }

      await tracked(
        taskId,
        step,
        "rename-database",
        `Renaming database ${from} → ${to}`,
        async () => {
          if (project.dbType === "mssql") {
            await runMssqlRenameDatabase(project, from, to, credentials);
          } else {
            await runPostgresRenameDatabase(project, from, to, credentials);
          }
        }
      );

      await step.run("finish", async () => {
        await appendTaskOutput(taskId, `✓ Database renamed: ${from} → ${to}`);
        await completeTask(taskId);
      });

      return { success: true, from, to };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.run("record-failure", () => failTask(taskId, message));
      throw err;
    }
  }
);

async function runPostgresRenameDatabase(
  project: ProjectWithServers,
  from: string,
  to: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  // Terminate active connections first — ALTER DATABASE ... RENAME fails while
  // other sessions hold the source DB open.
  const terminate =
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity ` +
    `WHERE datname = ${pgQuoteLiteral(from)} AND pid <> pg_backend_pid();`;
  const rename = `ALTER DATABASE ${pgQuoteId(from)} RENAME TO ${pgQuoteId(to)};`;
  const query = `${terminate}\n${rename}`;
  const inner = `printf '%s\\n' ${shq(query)} | psql -v ON_ERROR_STOP=on -U postgres -d postgres`;
  const cmd = buildDbShellCommand(
    project.dbServiceType,
    project.dbServiceName,
    inner,
    { runAsUser: "postgres", sudoPassword: credentials.password }
  );
  await executeRemoteCommand(credentials, cmd);
}

async function runMssqlRenameDatabase(
  project: ProjectWithServers,
  from: string,
  to: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  if (!project.dbPassword) {
    throw new Error(
      "Project dbPassword is required for MSSQL database rename (sqlcmd needs it)"
    );
  }
  const fromId = sqlBracketId(from);
  // Flip to SINGLE_USER WITH ROLLBACK IMMEDIATE to kill active connections so
  // MODIFY NAME doesn't fail, rename, then return to MULTI_USER.
  const query =
    `ALTER DATABASE [${fromId}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n` +
    `ALTER DATABASE [${fromId}] MODIFY NAME = [${sqlBracketId(to)}];\n` +
    `ALTER DATABASE [${sqlBracketId(to)}] SET MULTI_USER;`;
  const cmd = buildSqlcmdCommand(
    query,
    project.dbPassword,
    project.dbServiceType,
    project.dbServiceName
  );
  await executeRemoteCommand(credentials, cmd);
}

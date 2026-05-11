import type { ProjectWithServers } from "@/lib/db/schema";
import {
  buildControlCommand,
  getServiceConfig,
  type ServiceAction,
  type ServiceRole,
} from "@/lib/services";
import { shq } from "@/lib/sh";
import { executeRemoteCommand } from "@/lib/ssh";
import { appendTaskOutput, completeTask, failTask } from "@/lib/task-progress";
import { inngest } from "./client";

export const syncJenkinsData = inngest.createFunction(
  { id: "sync-jenkins-data", triggers: { event: "jenkins/sync.data" } },
  async ({ event, step }) => {
    await step.sleep("wait-a-moment", "1s");
    return { message: `Hello ${event.data.email}!` };
  }
);

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

// Build a `printf QUERY | docker exec -i SERVICE sh -c '... sqlcmd ...'`
// invocation. `sqlcmd` isn't on $PATH in Microsoft's mssql images — it lives
// at /opt/mssql-tools18/bin (newer) or /opt/mssql-tools/bin (older). Probe
// both before falling back to PATH lookup so we don't have to know which
// SQL Server version each project is on.
function buildSqlcmdCommand(
  query: string,
  password: string,
  serviceName: string
): string {
  const args = [
    "-S",
    "localhost",
    "-U",
    "sa",
    "-P",
    password,
    "-C",
    "-b",
    "-r0",
  ]
    .map(shq)
    .join(" ");
  const wrapper =
    'for p in /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd; do ' +
    '[ -x "$p" ] && exec "$p" "$@"; done; exec sqlcmd "$@"';
  return (
    `printf '%s\\n' ${shq(query)} | ` +
    `docker exec -i ${shq(serviceName)} ` +
    `sh -c ${shq(wrapper)} sh ${args}`
  );
}

export const createDatabaseBackup = inngest.createFunction(
  { id: "create-db-backup", triggers: { event: "db/backup.requested" } },
  async ({ event, step }) => {
    const { taskId, compress, ...project } = event.data as ProjectWithServers & {
      taskId: string;
      compress?: boolean;
    };
    const useCompression = compress ?? true;

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
          const mkdirCmd = `docker exec ${shq(project.dbServiceName)} mkdir -p ${shq(project.dbBackupPath)}`;
          await executeRemoteCommand(credentials, mkdirCmd);
        }
      );

      const filename = await tracked(
        taskId,
        step,
        "run-backup",
        `Running ${project.dbType === "mssql" ? "BACKUP DATABASE" : "pg_dump"} for ${project.dbName}${useCompression ? "" : " (uncompressed)"}`,
        async () => {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          if (project.dbType === "mssql") {
            return await runMssqlBackup(project, ts, credentials, useCompression);
          }
          return await runPostgresBackup(project, ts, credentials, useCompression);
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
  ts: string,
  credentials: { host: string; username: string; password: string },
  compress: boolean
): Promise<string> {
  const fname = compress
    ? `${project.dbName}_${ts}.sql.gz`
    : `${project.dbName}_${ts}.sql`;
  const target = `${project.dbBackupPath}/${fname}`;
  // `--clean --if-exists` emits idempotent DROP IF EXISTS for every object
  // before the CREATE statements, so the dump can be restored into a database
  // that already has the schema (otherwise CREATE TABLE errors out on
  // re-restore). When piping through gzip, `set -o pipefail` so pg_dump
  // failures bubble up instead of getting masked by gzip's exit 0.
  const dumpCmd = `pg_dump -U postgres --clean --if-exists ${shq(project.dbName)}`;
  const inner = compress
    ? `set -o pipefail; ${dumpCmd} | gzip > ${shq(target)}`
    : `${dumpCmd} > ${shq(target)}`;
  const cmd = `docker exec ${shq(project.dbServiceName)} sh -c ${shq(inner)}`;
  await executeRemoteCommand(credentials, cmd);
  return fname;
}

async function runMssqlBackup(
  project: ProjectWithServers,
  ts: string,
  credentials: { host: string; username: string; password: string },
  compress: boolean
): Promise<string> {
  if (!project.dbPassword) {
    throw new Error(
      "Project dbPassword is required for MSSQL backups (sqlcmd needs it)"
    );
  }
  const fname = `${project.dbName}_${ts}.bak`;
  const target = `${project.dbBackupPath}/${fname}`;
  // MSSQL .bak format is the same regardless of compression — the COMPRESSION
  // option just toggles internal block-level compression. NO_COMPRESSION is
  // the explicit opt-out (also the engine default when omitted, but explicit
  // is clearer in the audit log).
  const compressionClause = compress ? "COMPRESSION" : "NO_COMPRESSION";
  const query =
    `BACKUP DATABASE [${sqlBracketId(project.dbName)}] ` +
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
    project.dbServiceName
  );
  await executeRemoteCommand(credentials, cmd);
  return fname;
}

export const simulateProjectTimeLegacy = inngest.createFunction(
  {
    id: "simulate-project-time-legacy",
    triggers: { event: "project/simulate-time.legacy" },
  },
  async ({ event, step }) => {
    const { project, simulatedAt, taskId } = event.data as {
      project: ProjectWithServers;
      simulatedAt: string;
      taskId: string;
    };

    const credentials = {
      host: project.backendServer.host,
      username: project.backendServer.username,
      password: project.backendServer.password,
    };

    // `date -s` expects "YYYY-MM-DD HH:MM:SS"; convert from ISO so the shell
    // gets a clean argument and we don't depend on the remote host's locale.
    const d = new Date(simulatedAt);
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
          await executeRemoteCommand(credentials, sudo("timedatectl set-ntp false"));
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
        await appendTaskOutput(taskId, "✓ Simulate-time complete");
        await completeTask(taskId);
      });

      return { success: true, simulatedAt };
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

export const restoreDatabaseBackup = inngest.createFunction(
  { id: "restore-db-backup", triggers: { event: "db/restore.requested" } },
  async ({ event, step }) => {
    const data = event.data as ProjectWithServers & {
      filename: string;
      taskId: string;
      restartBackend?: boolean;
    };
    const { filename, taskId, restartBackend } = data;
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
          `Restoring ${data.dbName} from ${filename}`,
          async () => {
            await runMssqlRestore(data, filename, credentials);
          }
        );
      } else {
        await tracked(
          taskId,
          step,
          "recreate-database",
          `Dropping and recreating ${data.dbName}`,
          async () => {
            await runPostgresRecreateDatabase(data, credentials);
          }
        );
        await tracked(
          taskId,
          step,
          "perform-restore",
          `Restoring from ${filename}`,
          async () => {
            await runPostgresRestore(data, filename, credentials);
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
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  // `WITH (FORCE)` (Postgres 13+) terminates active connections so the DROP
  // doesn't fail with "database is being accessed by other users". Then
  // recreate so the dump pipes into a clean DB — this lets us handle dumps
  // produced both with and without `--clean --if-exists`.
  const dbId = pgQuoteId(data.dbName);
  const query = `DROP DATABASE IF EXISTS ${dbId} WITH (FORCE); CREATE DATABASE ${dbId};`;
  const cmd =
    `printf '%s\\n' ${shq(query)} | ` +
    `docker exec -i ${shq(data.dbServiceName)} psql -v ON_ERROR_STOP=on -U postgres -d postgres`;
  await executeRemoteCommand(credentials, cmd);
}

async function runPostgresRestore(
  data: ProjectWithServers,
  filename: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  const source = `${data.dbBackupPath}/${filename}`;
  // `-v ON_ERROR_STOP=on` aborts psql at the first failing statement instead
  // of silently continuing through a half-broken restore. Branch on the file
  // suffix so we can restore both gzipped (`.sql.gz`) and plain (`.sql`)
  // dumps produced by createDatabaseBackup.
  const psqlCmd = `psql -v ON_ERROR_STOP=on -U postgres -d ${shq(data.dbName)}`;
  const inner = filename.endsWith(".gz")
    ? `set -o pipefail; gunzip -c ${shq(source)} | ${psqlCmd}`
    : `${psqlCmd} < ${shq(source)}`;
  const cmd = `docker exec -i ${shq(data.dbServiceName)} sh -c ${shq(inner)}`;
  await executeRemoteCommand(credentials, cmd);
}

export const controlService = inngest.createFunction(
  { id: "control-service", triggers: { event: "service/control.requested" } },
  async ({ event, step }) => {
    const { project, role, action, taskId } = event.data as {
      project: ProjectWithServers;
      role: ServiceRole;
      action: ServiceAction;
      taskId: string;
    };
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

async function runMssqlRestore(
  data: ProjectWithServers,
  filename: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  if (!data.dbPassword) {
    throw new Error(
      "Project dbPassword is required for MSSQL restores (sqlcmd needs it)"
    );
  }
  const source = `${data.dbBackupPath}/${filename}`;
  const dbId = sqlBracketId(data.dbName);
  // Kill connections by flipping to SINGLE_USER, then restore. TRY/CATCH so
  // a failed restore still flips back to MULTI_USER instead of leaving the DB
  // wedged. THROW re-raises the original error to non-zero exit sqlcmd.
  const query =
    `ALTER DATABASE [${dbId}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n` +
    `BEGIN TRY\n` +
    `  RESTORE DATABASE [${dbId}] FROM DISK = N'${sqlQuoteString(source)}' WITH REPLACE;\n` +
    `END TRY\n` +
    `BEGIN CATCH\n` +
    `  DECLARE @err NVARCHAR(MAX) = ERROR_MESSAGE();\n` +
    `  ALTER DATABASE [${dbId}] SET MULTI_USER;\n` +
    `  THROW 50000, @err, 1;\n` +
    `END CATCH;\n` +
    `ALTER DATABASE [${dbId}] SET MULTI_USER;`;
  const cmd = buildSqlcmdCommand(query, data.dbPassword, data.dbServiceName);
  await executeRemoteCommand(credentials, cmd);
}

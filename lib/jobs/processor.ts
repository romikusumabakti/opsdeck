import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";
import type { EnvironmentWithServers } from "@/lib/db/schema";
import { dbLocationMatches } from "@/lib/db-location";
import { loadEnvironmentWithServers } from "@/lib/environments";
import { pushComment, pushIssue } from "@/lib/jira/push";
import { pullProject, syncIssueById } from "@/lib/jira/sync";
import type { JobMap, JobName } from "@/lib/queue";
import { appendRunOutput, completeRun, failRun } from "@/lib/run-progress";
import {
  backendService,
  buildControlCommand,
  buildDbShellCommand,
  buildSqlcmdCommand,
  dbConfig,
  getServiceConfig,
} from "@/lib/services";
import { shq } from "@/lib/sh";
import {
  downloadRemoteFile,
  executeRemoteCommand,
  uploadRemoteFile,
} from "@/lib/ssh";

// Appends a step's label to the run output before running it, and on failure
// logs `✗ label — message` then re-throws so the handler's catch marks the
// run failed. (The old Inngest version wrapped each call in step.run for
// durable memoization; jobs run with attempts: 1, so a plain call suffices.)
async function tracked<T>(
  runId: string,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  await appendRunOutput(runId, label);
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendRunOutput(runId, `✗ ${label} — ${message}`);
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

async function handleCreateDatabaseBackup(
  data: JobMap["db/backup.requested"]
): Promise<{ success: true; filename: string }> {
  const { runId, compress, environmentId, database } = data;
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) throw new Error(`Environment ${environmentId} not found`);
  const useCompression = compress ?? true;
  const db = dbConfig(environment);
  // Fall back to the environment's configured database when no explicit target is
  // sent (backups of the "default database"). The action layer has already
  // validated any non-default `database` against databaseNameSchema.
  const dbName = database ?? db.dbName;

  const credentials = {
    host: db.server.host,
    username: db.server.username,
    password: db.server.password,
  };

  try {
    await tracked(runId, "Ensuring backup directory exists", async () => {
      // Run as the DB's OS user so the directory ends up owned by the
      // process that later writes into it: pg_dump runs as `postgres`,
      // and SQL Server's BACKUP DATABASE writes the .bak file from the
      // `mssql` server process. No-op `runAsUser` for docker/kubernetes
      // — the exec wrapper already enters the container.
      const runAsUser = db.dbType === "postgres" ? "postgres" : "mssql";
      const mkdirCmd = buildDbShellCommand(
        db.serviceType,
        db.serviceName,
        `mkdir -p ${shq(db.dbBackupPath)}`,
        { runAsUser, sudoPassword: credentials.password }
      );
      await executeRemoteCommand(credentials, mkdirCmd);
    });

    const filename = await tracked(
      runId,
      `Running ${db.dbType === "mssql" ? "BACKUP DATABASE" : "pg_dump"} for ${dbName}${useCompression ? "" : " (uncompressed)"}`,
      async () => {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        if (db.dbType === "mssql") {
          return await runMssqlBackup(
            environment,
            dbName,
            ts,
            credentials,
            useCompression
          );
        }
        return await runPostgresBackup(
          environment,
          dbName,
          ts,
          credentials,
          useCompression
        );
      }
    );

    await appendRunOutput(runId, `✓ Backup file created: ${filename}`);
    await completeRun(runId);

    return { success: true, filename };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failRun(runId, message);
    throw err;
  }
}

async function runPostgresBackup(
  environment: EnvironmentWithServers,
  database: string,
  ts: string,
  credentials: { host: string; username: string; password: string },
  compress: boolean
): Promise<string> {
  const db = dbConfig(environment);
  const fname = compress ? `${database}_${ts}.sql.gz` : `${database}_${ts}.sql`;
  const target = `${db.dbBackupPath}/${fname}`;
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
  const cmd = buildDbShellCommand(db.serviceType, db.serviceName, inner, {
    runAsUser: "postgres",
    sudoPassword: credentials.password,
  });
  await executeRemoteCommand(credentials, cmd);
  return fname;
}

async function runMssqlBackup(
  environment: EnvironmentWithServers,
  database: string,
  ts: string,
  credentials: { host: string; username: string; password: string },
  compress: boolean
): Promise<string> {
  const db = dbConfig(environment);
  if (!db.dbPassword) {
    throw new Error(
      "Environment dbPassword is required for MSSQL backups (sqlcmd needs it)"
    );
  }
  const fname = `${database}_${ts}.bak`;
  const target = `${db.dbBackupPath}/${fname}`;
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
    db.dbPassword,
    db.serviceType,
    db.serviceName
  );
  await executeRemoteCommand(credentials, cmd);
  return fname;
}

async function handleMockEnvironmentTimeLegacy(
  data: JobMap["environment/mock-time.legacy"]
): Promise<{ success: true; mockedAt: string }> {
  const { environmentId, mockedAt, runId } = data;
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) throw new Error(`Environment ${environmentId} not found`);
  const backend = backendService(environment);

  const credentials = {
    host: backend.server.host,
    username: backend.server.username,
    password: backend.server.password,
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
    await tracked(runId, "Disabling NTP on backend server", async () => {
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
    });

    await tracked(runId, `Setting system time to ${dateArg} UTC`, async () => {
      await executeRemoteCommand(
        credentials,
        sudo(`date -u -s ${shq(dateArg)}`)
      );
    });

    await tracked(
      runId,
      `Restarting backend service ${backend.serviceName}`,
      async () => {
        const cmd = buildControlCommand(
          backend.serviceType,
          backend.serviceName,
          "restart",
          credentials.password
        );
        // Service restart waits for the unit to report started — can exceed the
        // default 10s. Allow 60s so a slow-but-healthy restart isn't killed.
        await executeRemoteCommand(credentials, cmd, 60000);
      }
    );

    await appendRunOutput(runId, "✓ Mock-time complete");
    await completeRun(runId);

    return { success: true, mockedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Heads-up for the operator: by the time we reach here, NTP is off and
    // the system clock may already be set. The server is in an inconsistent
    // state until someone re-enables NTP — surface that in the run log so
    // it's obvious from the UI without digging into the failure.
    await appendRunOutput(
      runId,
      "⚠ Backend server may be in inconsistent state — NTP disabled and time potentially overridden. " +
        "To recover, run `sudo timedatectl set-ntp true` on the backend server."
    );
    await failRun(runId, message);
    throw err;
  }
}

async function handleMockEnvironmentTimeResetLegacy(
  data: JobMap["environment/mock-time.reset-legacy"]
): Promise<{ success: true }> {
  const { environmentId, runId } = data;
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) throw new Error(`Environment ${environmentId} not found`);
  const backend = backendService(environment);

  const credentials = {
    host: backend.server.host,
    username: backend.server.username,
    password: backend.server.password,
  };

  const sudo = (cmd: string) =>
    `printf '%s\\n' ${shq(credentials.password)} | sudo -S ${cmd}`;

  try {
    await tracked(runId, "Re-enabling NTP on backend server", async () => {
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
    });

    // Force an immediate resync. NTP just re-enables polling — without a
    // restart, the host can sit on the mocked time for a polling interval.
    // Try systemd-timesyncd and chronyd; `|| true` keeps the step green when
    // only one of them is installed.
    await tracked(runId, "Forcing immediate clock sync", async () => {
      await executeRemoteCommand(
        credentials,
        sudo(
          "systemctl restart systemd-timesyncd 2>/dev/null || systemctl restart chronyd 2>/dev/null || true"
        )
      );
    });

    await tracked(
      runId,
      `Restarting backend service ${backend.serviceName}`,
      async () => {
        const cmd = buildControlCommand(
          backend.serviceType,
          backend.serviceName,
          "restart",
          credentials.password
        );
        // Service restart waits for the unit to report started — can exceed the
        // default 10s. Allow 60s so a slow-but-healthy restart isn't killed.
        await executeRemoteCommand(credentials, cmd, 60000);
      }
    );

    await appendRunOutput(runId, "✓ Clock reset complete");
    await completeRun(runId);

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failRun(runId, message);
    throw err;
  }
}

// --- Cross-server restore transfer ----------------------------------------
// When the source backup lives on a different DB server/service than the
// restore target (only the dbType matches), the file must be physically copied
// into the target's backup dir before the normal restore can read it. The move
// hops through the panel: extract the source file into an SSH-owned temp on the
// source host, SFTP it down to the panel, SFTP it up to the target host, then
// place it into the target's backup dir with the DB user's ownership. Streaming
// host-to-host directly isn't possible (SFTP is per-connection), and passing
// the bytes through a shell would collide with `sudo -S`'s stdin.

type SshCreds = { host: string; username: string; password: string };

function credsOf(server: {
  host: string;
  username: string;
  password: string;
}): SshCreds {
  return {
    host: server.host,
    username: server.username,
    password: server.password,
  };
}

function dbOsUser(dbType: "postgres" | "mssql"): string {
  return dbType === "postgres" ? "postgres" : "mssql";
}

// Best-effort side effect (temp cleanup) — logs and swallows so a failed
// cleanup never masks the real restore outcome.
async function ignoreErrors(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error("Restore transfer cleanup failed:", err);
  }
}

// Command (run on the SOURCE host as the SSH user) that writes the backup file
// to `hostTmp`, an SSH-owned path. The db-shell wrapper `cat`s the file from
// inside the container / as the DB OS user; the `> hostTmp` redirect runs in
// the outer SSH-user shell so the temp ends up SSH-readable for SFTP.
function buildExtractCommand(
  environment: EnvironmentWithServers,
  filePath: string,
  hostTmp: string
): string {
  const db = dbConfig(environment);
  const inner = buildDbShellCommand(
    db.serviceType,
    db.serviceName,
    `cat ${shq(filePath)}`,
    {
      runAsUser: dbOsUser(db.dbType),
      sudoPassword: db.server.password,
    }
  );
  return `${inner} > ${shq(hostTmp)}`;
}

// Command (run on the TARGET host) that moves the SSH-owned `hostTmp` into the
// target's backup dir as `dst`, owned/readable by the DB process.
function buildPlaceCommand(
  environment: EnvironmentWithServers,
  hostTmp: string,
  dst: string
): string {
  const db = dbConfig(environment);
  const name = db.serviceName;
  if (db.serviceType === "docker") {
    return (
      `docker cp ${shq(hostTmp)} ${shq(`${name}:${dst}`)} && ` +
      `docker exec ${shq(name)} chmod 644 ${shq(dst)}`
    );
  }
  if (db.serviceType === "kubernetes") {
    // `kubectl cp` needs a pod name, not a deploy/, so stream via `exec -i`.
    const write = `cat > ${shq(dst)}`;
    return (
      `kubectl exec -i deploy/${shq(name)} -- bash -c ${shq(write)} < ${shq(hostTmp)} && ` +
      `kubectl exec deploy/${shq(name)} -- chmod 644 ${shq(dst)}`
    );
  }
  // systemd: copy in as root, then hand ownership to the DB user. The password
  // only feeds sudo (the file is an argument, not stdin), so there's no stdin
  // conflict.
  const user = dbOsUser(db.dbType);
  const script =
    `cp ${shq(hostTmp)} ${shq(dst)}; ` +
    `chown ${user}:${user} ${shq(dst)}; ` +
    `chmod 644 ${shq(dst)}`;
  return `printf '%s\\n' ${shq(db.server.password)} | sudo -S bash -c ${shq(script)}`;
}

// Command (run on the TARGET host) removing the staged copy from the backup dir
// once the restore has consumed it, so foreign backups don't linger.
function buildRemovePlacedCommand(
  environment: EnvironmentWithServers,
  dst: string
): string {
  const db = dbConfig(environment);
  const name = db.serviceName;
  if (db.serviceType === "docker") {
    return `docker exec ${shq(name)} rm -f ${shq(dst)}`;
  }
  if (db.serviceType === "kubernetes") {
    return `kubectl exec deploy/${shq(name)} -- rm -f ${shq(dst)}`;
  }
  return `printf '%s\\n' ${shq(db.server.password)} | sudo -S rm -f ${shq(dst)}`;
}

// Stage `filename` from `sourceEnvironment`'s backup dir into `targetProject`'s
// backup dir (different host/service). Returns a cleanup that removes the placed
// file after the restore is done. Throws (with temps cleaned up) on any failure.
async function transferBackupToTarget(
  sourceEnvironment: EnvironmentWithServers,
  targetProject: EnvironmentWithServers,
  filename: string,
  stamp: string
): Promise<() => Promise<void>> {
  const sourceDb = dbConfig(sourceEnvironment);
  const targetDb = dbConfig(targetProject);
  const srcCreds = credsOf(sourceDb.server);
  const dstCreds = credsOf(targetDb.server);
  const srcHostTmp = `/tmp/opsdeck-restore-src-${stamp}`;
  const dstHostTmp = `/tmp/opsdeck-restore-dst-${stamp}`;
  const localTmp = join(tmpdir(), `opsdeck-restore-${stamp}`);
  const sourceFile = `${sourceDb.dbBackupPath}/${filename}`;
  const dst = `${targetDb.dbBackupPath}/${filename}`;

  // Ensure the target backup dir exists before placing into it.
  await executeRemoteCommand(
    dstCreds,
    buildDbShellCommand(
      targetDb.serviceType,
      targetDb.serviceName,
      `mkdir -p ${shq(targetDb.dbBackupPath)}`,
      {
        runAsUser: dbOsUser(targetDb.dbType),
        sudoPassword: dstCreds.password,
      }
    )
  );

  await executeRemoteCommand(
    srcCreds,
    buildExtractCommand(sourceEnvironment, sourceFile, srcHostTmp)
  );
  try {
    await downloadRemoteFile(srcCreds, srcHostTmp, localTmp);
    await uploadRemoteFile(dstCreds, localTmp, dstHostTmp);
    await executeRemoteCommand(
      dstCreds,
      buildPlaceCommand(targetProject, dstHostTmp, dst)
    );
  } finally {
    // Drop the transient temps on both hosts and the panel regardless of
    // outcome; the placed backup file is cleaned separately after the restore.
    await ignoreErrors(() =>
      executeRemoteCommand(srcCreds, `rm -f ${shq(srcHostTmp)}`)
    );
    await ignoreErrors(() =>
      executeRemoteCommand(dstCreds, `rm -f ${shq(dstHostTmp)}`)
    );
    await ignoreErrors(() => fs.rm(localTmp, { force: true }));
  }

  return async () => {
    await ignoreErrors(() =>
      executeRemoteCommand(
        dstCreds,
        buildRemovePlacedCommand(targetProject, dst)
      )
    );
  };
}

async function handleRestoreDatabaseBackup(
  data: JobMap["db/restore.requested"]
): Promise<{ success: true; restored: string }> {
  const {
    environmentId,
    filename,
    runId,
    restartBackend,
    database,
    sourceEnvironmentId,
  } = data;
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) throw new Error(`Environment ${environmentId} not found`);
  const db = dbConfig(environment);
  // Restore target — the configured database unless the picker sent another
  // one (already validated by the action layer).
  const dbName = database ?? db.dbName;
  const credentials = {
    host: db.server.host,
    username: db.server.username,
    password: db.server.password,
  };

  if (!filename) throw new Error("Filename is required");

  // Optional cross-environment source: read the backup from another environment.
  // - Same DB location (server + service + type): read its `dbBackupPath`
  //   directly — the target's DB server already reaches that path.
  // - Same dbType but different server/service: physically stage the file into
  //   the target's backup dir first (see transferBackupToTarget). Re-validate
  //   the dbType match here (defence in depth — the action already checked).
  let backupPath = db.dbBackupPath;
  let cleanupTransfer: (() => Promise<void>) | null = null;
  if (sourceEnvironmentId && sourceEnvironmentId !== environmentId) {
    const sourceEnvironment =
      await loadEnvironmentWithServers(sourceEnvironmentId);
    if (!sourceEnvironment) {
      throw new Error(`Source environment ${sourceEnvironmentId} not found`);
    }
    const sourceDb = dbConfig(sourceEnvironment);
    if (sourceDb.dbType !== db.dbType) {
      throw new Error(
        "Source environment database type does not match the target"
      );
    }
    if (
      dbLocationMatches(
        {
          serverId: sourceDb.serverId,
          serviceType: sourceDb.serviceType,
          serviceName: sourceDb.serviceName,
          dbType: sourceDb.dbType,
        },
        {
          serverId: db.serverId,
          serviceType: db.serviceType,
          serviceName: db.serviceName,
          dbType: db.dbType,
        }
      )
    ) {
      backupPath = sourceDb.dbBackupPath;
    } else {
      cleanupTransfer = await tracked(
        runId,
        `Transferring backup from ${sourceEnvironment.name}`,
        () =>
          transferBackupToTarget(
            sourceEnvironment,
            environment,
            filename,
            runId
          )
      );
      // File now lives under `filename` in the target's own backup dir.
      backupPath = db.dbBackupPath;
    }
  }
  const source = `${backupPath}/${filename}`;

  try {
    if (db.dbType === "mssql") {
      await tracked(runId, `Restoring ${dbName} from ${filename}`, async () => {
        await runMssqlRestore(environment, dbName, source, credentials);
      });
    } else {
      await tracked(runId, `Dropping and recreating ${dbName}`, async () => {
        await runPostgresRecreateDatabase(environment, dbName, credentials);
      });
      await tracked(runId, `Restoring from ${filename}`, async () => {
        await runPostgresRestore(
          environment,
          dbName,
          filename,
          source,
          credentials
        );
      });
    }

    // Optional follow-up: restart backend so it picks up the fresh DB state
    // (drops stale connections, clears in-memory caches). Runs against the
    // backend server's credentials, not the DB server's.
    if (restartBackend) {
      const backend = backendService(environment);
      await tracked(
        runId,
        `Restarting backend ${backend.serviceName}`,
        async () => {
          const backendCreds = {
            host: backend.server.host,
            username: backend.server.username,
            password: backend.server.password,
          };
          const cmd = buildControlCommand(
            backend.serviceType,
            backend.serviceName,
            "restart",
            backendCreds.password
          );
          // Service restart waits for the unit to report started — can exceed
          // the default 10s. Allow 60s so a slow-but-healthy restart isn't
          // killed (was the cause of the SSH-timeout restore failures).
          await executeRemoteCommand(backendCreds, cmd, 60000);
        }
      );
    }

    await appendRunOutput(runId, `✓ Restore complete (${filename})`);
    await completeRun(runId);

    return { success: true, restored: filename };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failRun(runId, message);
    throw err;
  } finally {
    // Remove the staged copy from the target's backup dir (cross-server source
    // only). Best-effort: never let cleanup change the run's outcome.
    if (cleanupTransfer) await cleanupTransfer();
  }
}

async function runPostgresRecreateDatabase(
  data: EnvironmentWithServers,
  database: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  // `WITH (FORCE)` (Postgres 13+) terminates active connections so the DROP
  // doesn't fail with "database is being accessed by other users". Then
  // recreate so the dump pipes into a clean DB — this lets us handle dumps
  // produced both with and without `--clean --if-exists`.
  const dbSvc = dbConfig(data);
  const dbId = pgQuoteId(database);
  const query = `DROP DATABASE IF EXISTS ${dbId} WITH (FORCE); CREATE DATABASE ${dbId};`;
  // Pipe the query inside the inner shell so the pipeline doesn't compete
  // with sudo -S's stdin on systemd; `runAsUser: "postgres"` is a no-op for
  // docker/kubernetes.
  const inner = `printf '%s\\n' ${shq(query)} | psql -v ON_ERROR_STOP=on -U postgres -d postgres`;
  const cmd = buildDbShellCommand(dbSvc.serviceType, dbSvc.serviceName, inner, {
    runAsUser: "postgres",
    sudoPassword: credentials.password,
  });
  await executeRemoteCommand(credentials, cmd);
}

async function runPostgresRestore(
  data: EnvironmentWithServers,
  database: string,
  filename: string,
  source: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  // `-v ON_ERROR_STOP=on` aborts psql at the first failing statement instead
  // of silently continuing through a half-broken restore. Branch on the file
  // suffix so we can restore both gzipped (`.sql.gz`) and plain (`.sql`)
  // dumps produced by createDatabaseBackup.
  const dbSvc = dbConfig(data);
  const psqlCmd = `psql -v ON_ERROR_STOP=on -U postgres -d ${shq(database)}`;
  const inner = filename.endsWith(".gz")
    ? `set -o pipefail; gunzip -c ${shq(source)} | ${psqlCmd}`
    : `${psqlCmd} < ${shq(source)}`;
  const cmd = buildDbShellCommand(dbSvc.serviceType, dbSvc.serviceName, inner, {
    runAsUser: "postgres",
    sudoPassword: credentials.password,
  });
  await executeRemoteCommand(credentials, cmd);
}

async function handleControlService(
  data: JobMap["service/control.requested"]
): Promise<{ success: true }> {
  const { environmentId, role, action, runId } = data;
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) throw new Error(`Environment ${environmentId} not found`);
  const cfg = getServiceConfig(environment, role);
  const credentials = {
    host: cfg.server.host,
    username: cfg.server.username,
    password: cfg.server.password,
  };

  try {
    await tracked(
      runId,
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
          await appendRunOutput(runId, trimmed);
        }
      }
    );

    await appendRunOutput(runId, `✓ ${action} ${cfg.serviceName} complete`);
    await completeRun(runId);

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failRun(runId, message);
    throw err;
  }
}

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
  data: EnvironmentWithServers,
  source: string,
  credentials: { host: string; username: string; password: string }
): Promise<MssqlBackupFile[]> {
  const dbSvc = dbConfig(data);
  const query = `RESTORE FILELISTONLY FROM DISK = N'${sqlQuoteString(source)}';`;
  const cmd = buildSqlcmdCommand(
    query,
    dbSvc.dbPassword!,
    dbSvc.serviceType,
    dbSvc.serviceName,
    ["-h", "-1", "-W", "-s", "~"]
  );
  const out = await executeRemoteCommand(credentials, cmd);
  const files: MssqlBackupFile[] = [];
  for (const line of out.split("\n")) {
    const parts = line.split("~");
    if (parts.length < 3) continue;
    const type = parts[2]?.trim().toUpperCase();
    if (type !== "D" && type !== "L" && type !== "S" && type !== "F") continue;
    // `parts.length < 3` was skipped above, so 0 and 1 are present.
    files.push({
      logical: parts[0]?.trim() ?? "",
      physical: parts[1]?.trim() ?? "",
      type,
    });
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
  data: EnvironmentWithServers,
  database: string,
  source: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  const dbSvc = dbConfig(data);
  if (!dbSvc.dbPassword) {
    throw new Error(
      "Environment dbPassword is required for MSSQL restores (sqlcmd needs it)"
    );
  }
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
    dbSvc.dbPassword,
    dbSvc.serviceType,
    dbSvc.serviceName
  );
  await executeRemoteCommand(credentials, cmd);
}

async function handleCreateDatabase(
  data: JobMap["db/database.create.requested"]
): Promise<{ success: true; database: string }> {
  const { environmentId, database, runId } = data;
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) throw new Error(`Environment ${environmentId} not found`);
  const db = dbConfig(environment);
  const credentials = {
    host: db.server.host,
    username: db.server.username,
    password: db.server.password,
  };

  try {
    if (!database) throw new Error("Database name is required");

    await tracked(runId, `Creating database ${database}`, async () => {
      if (db.dbType === "mssql") {
        await runMssqlCreateDatabase(environment, database, credentials);
      } else {
        await runPostgresCreateDatabase(environment, database, credentials);
      }
    });

    await appendRunOutput(runId, `✓ Database created: ${database}`);
    await completeRun(runId);

    return { success: true, database };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failRun(runId, message);
    throw err;
  }
}

async function runPostgresCreateDatabase(
  environment: EnvironmentWithServers,
  database: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  const db = dbConfig(environment);
  const query = `CREATE DATABASE ${pgQuoteId(database)};`;
  const inner = `printf '%s\\n' ${shq(query)} | psql -v ON_ERROR_STOP=on -U postgres -d postgres`;
  const cmd = buildDbShellCommand(db.serviceType, db.serviceName, inner, {
    runAsUser: "postgres",
    sudoPassword: credentials.password,
  });
  await executeRemoteCommand(credentials, cmd);
}

async function runMssqlCreateDatabase(
  environment: EnvironmentWithServers,
  database: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  const db = dbConfig(environment);
  if (!db.dbPassword) {
    throw new Error(
      "Environment dbPassword is required for MSSQL database creation (sqlcmd needs it)"
    );
  }
  const query = `CREATE DATABASE [${sqlBracketId(database)}];`;
  const cmd = buildSqlcmdCommand(
    query,
    db.dbPassword,
    db.serviceType,
    db.serviceName
  );
  await executeRemoteCommand(credentials, cmd);
}

async function handleDropDatabase(
  data: JobMap["db/database.drop.requested"]
): Promise<{ success: true; database: string }> {
  const { environmentId, database, runId } = data;
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) throw new Error(`Environment ${environmentId} not found`);
  const db = dbConfig(environment);
  const credentials = {
    host: db.server.host,
    username: db.server.username,
    password: db.server.password,
  };

  try {
    if (!database) throw new Error("Database name is required");
    // Defence in depth: the action layer already blocks dropping the environment's
    // configured database, but re-check here so a hand-crafted event can't
    // wipe the default DB out from under the panel.
    if (database === db.dbName) {
      throw new Error("Refusing to drop the environment's configured database");
    }

    await tracked(runId, `Dropping database ${database}`, async () => {
      if (db.dbType === "mssql") {
        await runMssqlDropDatabase(environment, database, credentials);
      } else {
        await runPostgresDropDatabase(environment, database, credentials);
      }
    });

    await appendRunOutput(runId, `✓ Database dropped: ${database}`);
    await completeRun(runId);

    return { success: true, database };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failRun(runId, message);
    throw err;
  }
}

async function runPostgresDropDatabase(
  environment: EnvironmentWithServers,
  database: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  const db = dbConfig(environment);
  // `WITH (FORCE)` (Postgres 13+) terminates active connections so the DROP
  // doesn't fail with "database is being accessed by other users".
  const query = `DROP DATABASE IF EXISTS ${pgQuoteId(database)} WITH (FORCE);`;
  const inner = `printf '%s\\n' ${shq(query)} | psql -v ON_ERROR_STOP=on -U postgres -d postgres`;
  const cmd = buildDbShellCommand(db.serviceType, db.serviceName, inner, {
    runAsUser: "postgres",
    sudoPassword: credentials.password,
  });
  await executeRemoteCommand(credentials, cmd);
}

async function runMssqlDropDatabase(
  environment: EnvironmentWithServers,
  database: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  const db = dbConfig(environment);
  if (!db.dbPassword) {
    throw new Error(
      "Environment dbPassword is required for MSSQL database drop (sqlcmd needs it)"
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
    db.dbPassword,
    db.serviceType,
    db.serviceName
  );
  await executeRemoteCommand(credentials, cmd);
}

async function handleRenameDatabase(
  data: JobMap["db/database.rename.requested"]
): Promise<{ success: true; from: string; to: string }> {
  const { environmentId, from, to, runId } = data;
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) throw new Error(`Environment ${environmentId} not found`);
  const db = dbConfig(environment);
  const credentials = {
    host: db.server.host,
    username: db.server.username,
    password: db.server.password,
  };

  try {
    if (!from || !to) throw new Error("Source and target names are required");
    if (from === to) throw new Error("New name must differ from the old name");
    // Defence in depth: the action layer already blocks renaming the environment's
    // configured database, but re-check here so a hand-crafted event can't
    // orphan the default DB out from under the panel.
    if (from === db.dbName) {
      throw new Error(
        "Refusing to rename the environment's configured database"
      );
    }

    await tracked(runId, `Renaming database ${from} → ${to}`, async () => {
      if (db.dbType === "mssql") {
        await runMssqlRenameDatabase(environment, from, to, credentials);
      } else {
        await runPostgresRenameDatabase(environment, from, to, credentials);
      }
    });

    await appendRunOutput(runId, `✓ Database renamed: ${from} → ${to}`);
    await completeRun(runId);

    return { success: true, from, to };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failRun(runId, message);
    throw err;
  }
}

async function runPostgresRenameDatabase(
  environment: EnvironmentWithServers,
  from: string,
  to: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  const db = dbConfig(environment);
  // Terminate active connections first — ALTER DATABASE ... RENAME fails while
  // other sessions hold the source DB open.
  const terminate =
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity ` +
    `WHERE datname = ${pgQuoteLiteral(from)} AND pid <> pg_backend_pid();`;
  const rename = `ALTER DATABASE ${pgQuoteId(from)} RENAME TO ${pgQuoteId(to)};`;
  const query = `${terminate}\n${rename}`;
  const inner = `printf '%s\\n' ${shq(query)} | psql -v ON_ERROR_STOP=on -U postgres -d postgres`;
  const cmd = buildDbShellCommand(db.serviceType, db.serviceName, inner, {
    runAsUser: "postgres",
    sudoPassword: credentials.password,
  });
  await executeRemoteCommand(credentials, cmd);
}

async function runMssqlRenameDatabase(
  environment: EnvironmentWithServers,
  from: string,
  to: string,
  credentials: { host: string; username: string; password: string }
): Promise<void> {
  const db = dbConfig(environment);
  if (!db.dbPassword) {
    throw new Error(
      "Environment dbPassword is required for MSSQL database rename (sqlcmd needs it)"
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
    db.dbPassword,
    db.serviceType,
    db.serviceName
  );
  await executeRemoteCommand(credentials, cmd);
}

// Job names and payload keys were renamed when "project" became "environment"
// (`project/mock-time.*` -> `environment/mock-time.*`, `projectId` ->
// `environmentId`). Jobs already sitting in Redis when the worker rolls out
// still carry the old shape, so both are mapped forward here; the aliases can
// go once no pre-rename job can be queued anymore.
const LEGACY_JOB_NAMES: Record<string, JobName> = {
  "project/mock-time.legacy": "environment/mock-time.legacy",
  "project/mock-time.reset-legacy": "environment/mock-time.reset-legacy",
};

function normalizeJobName(name: string): JobName {
  return LEGACY_JOB_NAMES[name] ?? (name as JobName);
}

// biome-ignore lint/suspicious/noExplicitAny: BullMQ hands back untyped job data.
function normalizePayload(name: JobName, data: any): any {
  // The rename shim rewrites a bare `projectId` into `environmentId`. Jira jobs
  // legitimately carry a `projectId` that means the LOGICAL project, so they
  // must skip it — otherwise the sweep would lose its only argument.
  if (name.startsWith("jira/")) return data;
  if (data && typeof data === "object" && !("environmentId" in data)) {
    const { projectId, sourceProjectId, ...rest } = data;
    return {
      ...rest,
      environmentId: projectId,
      ...(sourceProjectId ? { sourceEnvironmentId: sourceProjectId } : {}),
    };
  }
  return data;
}

// Dispatches a job to its handler by name. The Worker calls this for every job;
// a thrown error propagates to BullMQ, which (with attempts: 1) marks the job
// failed — the handlers have already recorded the run failure in Postgres.
export async function processJob(job: Job): Promise<unknown> {
  const name = normalizeJobName(job.name);
  const data = normalizePayload(name, job.data);
  switch (name) {
    case "db/backup.requested":
      return handleCreateDatabaseBackup(data);
    case "db/restore.requested":
      return handleRestoreDatabaseBackup(data);
    case "db/database.create.requested":
      return handleCreateDatabase(data);
    case "db/database.drop.requested":
      return handleDropDatabase(data);
    case "db/database.rename.requested":
      return handleRenameDatabase(data);
    case "service/control.requested":
      return handleControlService(data);
    case "environment/mock-time.legacy":
      return handleMockEnvironmentTimeLegacy(data);
    case "environment/mock-time.reset-legacy":
      return handleMockEnvironmentTimeResetLegacy(data);
    case "jira/sync.project":
      return pullProject(data.projectId, { full: data.full });
    case "jira/issue.changed":
      return syncIssueById(data.connectionId, data.jiraIssueId);
    case "jira/push.issue":
      return pushIssue(data.issueId, data.fields);
    case "jira/push.comment":
      return pushComment(data.commentId);
    default: {
      // Exhaustiveness guard: a new JobName without a case is a compile error.
      const _exhaustive: never = name;
      throw new Error(`Unknown job name: ${String(_exhaustive)}`);
    }
  }
}

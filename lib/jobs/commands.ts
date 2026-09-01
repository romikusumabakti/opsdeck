import {
  buildDbShellCommand,
  type DatabaseType,
  dbConfig,
  MYSQL_CLIENT_RESOLVE,
  MYSQLDUMP_RESOLVE,
  mysqlConnectionFlags,
  mysqlPasswordExport,
  type ServiceType,
} from "@/lib/services";
import { shq } from "@/lib/sh";

/**
 * The string-building half of the background job handlers: SQL identifier and
 * literal escaping, the DDL and restore statements themselves, and the shell
 * pipelines they run inside.
 *
 * Split out of lib/jobs/processor.ts because everything here is pure — no SSH,
 * no database, no run bookkeeping — and it is the part that decides what
 * actually executes on a customer's database server. Kept together with its
 * escaping helpers so a builder can never reach for the wrong quoting rule, and
 * kept out of the handlers so it can be tested by asserting on the produced
 * command rather than by running one.
 */

// --- Escaping --------------------------------------------------------------
//
// Four different rules, deliberately four different functions. Postgres, SQL
// Server, and MySQL each quote identifiers differently, and an identifier and a
// string literal disagree with each other in every dialect — so a single
// generic "escape" helper would be the bug.

/**
 * Escape a value used inside a T-SQL single-quoted string literal (e.g. file
 * paths in `N'...'`). SQL standard: a single quote is doubled.
 *
 * Returns the inner text WITHOUT the surrounding quotes — call sites embed it
 * in an `N'...'` of their own.
 */
export function sqlQuoteString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Escape a SQL Server identifier wrapped in [brackets]. A literal `]` must be
 * doubled to `]]`. Returns the inner text WITHOUT the brackets.
 */
export function sqlBracketId(value: string): string {
  return value.replace(/]/g, "]]");
}

/**
 * Quote a Postgres identifier. A literal `"` is doubled to `""`. Unlike the two
 * above, this returns the value WITH its surrounding quotes.
 */
export function pgQuoteId(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Quote a value used as a Postgres string literal (e.g. a datname compared in
 * WHERE). A single quote is doubled. Returns the value WITH its quotes.
 */
export function pgQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Quote a MySQL/MariaDB identifier. Both engines wrap identifiers in backticks
 * (ANSI_QUOTES is off by default and we never set it), and a literal backtick
 * is doubled. Returns the value WITH its backticks.
 */
export function mysqlQuoteId(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}

// --- Paths -----------------------------------------------------------------

/**
 * `dirname` for a remote POSIX path. Not `node:path` — that would follow the
 * PANEL's platform, and these paths live on the remote host (or inside the
 * Linux container), so a Windows panel must not turn `/var/opt/x` into `\`.
 * Keeps a file in the same directory it was backed up from when we relocate it.
 */
export function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** The OS user a database engine runs as on the remote host. */
const DB_OS_USERS: Record<DatabaseType, string> = {
  postgres: "postgres",
  mssql: "mssql",
  mysql: "mysql",
};

export function dbOsUser(dbType: DatabaseType): string {
  return DB_OS_USERS[dbType];
}

/**
 * Extended-regex fragment matching the filenames an engine's backups carry.
 * SQL Server writes its own `.bak` archives; pg_dump and mysqldump both emit a
 * SQL script the panel optionally gzips. Shared by the backup listing (which
 * filters the directory with it) and, implicitly, by backupFilenameSchema.
 */
export function dbBackupExtensionPattern(dbType: DatabaseType): string {
  return dbType === "mssql" ? "\\.bak" : "\\.sql(\\.gz)?";
}

// --- Postgres --------------------------------------------------------------

/**
 * Wrap a Postgres statement in the pipeline that feeds it to `psql`.
 *
 * The query is piped inside the INNER shell on purpose: on systemd the outer
 * shell's stdin is already carrying the sudo password (`sudo -S`), so a
 * pipeline built outside would compete with it. `-v ON_ERROR_STOP=on` aborts at
 * the first failing statement instead of continuing through a half-applied
 * change.
 */
export function pgPsqlPipeline(query: string): string {
  return `printf '%s\\n' ${shq(query)} | psql -v ON_ERROR_STOP=on -U postgres -d postgres`;
}

/**
 * The inner shell command that dumps `database` to `target`.
 *
 * `--clean --if-exists` emits idempotent DROP IF EXISTS for every object before
 * the CREATE statements, so the dump can be restored into a database that
 * already has the schema (otherwise CREATE TABLE errors out on re-restore).
 * When piping through gzip, `set -o pipefail` so pg_dump failures bubble up
 * instead of getting masked by gzip's exit 0.
 */
export function pgBackupPipeline(
  database: string,
  target: string,
  compress: boolean
): string {
  const dumpCmd = `pg_dump -U postgres --clean --if-exists ${shq(database)}`;
  return compress
    ? `set -o pipefail; ${dumpCmd} | gzip > ${shq(target)}`
    : `${dumpCmd} > ${shq(target)}`;
}

/**
 * Drop and recreate, so a dump pipes into a clean database — this is what lets
 * us restore dumps produced both with and without `--clean --if-exists`.
 * `WITH (FORCE)` (Postgres 13+) terminates active connections so the DROP
 * doesn't fail with "database is being accessed by other users".
 */
export function pgRecreateDatabaseQuery(database: string): string {
  const dbId = pgQuoteId(database);
  return `DROP DATABASE IF EXISTS ${dbId} WITH (FORCE); CREATE DATABASE ${dbId};`;
}

export function pgCreateDatabaseQuery(database: string): string {
  return `CREATE DATABASE ${pgQuoteId(database)};`;
}

/** See pgRecreateDatabaseQuery for why `WITH (FORCE)`. */
export function pgDropDatabaseQuery(database: string): string {
  return `DROP DATABASE IF EXISTS ${pgQuoteId(database)} WITH (FORCE);`;
}

/**
 * Terminate active sessions first — `ALTER DATABASE ... RENAME` fails while
 * other sessions hold the source database open. `pid <> pg_backend_pid()` keeps
 * the statement from killing its own connection.
 */
export function pgRenameDatabaseQuery(from: string, to: string): string {
  const terminate =
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity ` +
    `WHERE datname = ${pgQuoteLiteral(from)} AND pid <> pg_backend_pid();`;
  const rename = `ALTER DATABASE ${pgQuoteId(from)} RENAME TO ${pgQuoteId(to)};`;
  return `${terminate}\n${rename}`;
}

/**
 * The inner shell command that feeds a dump file into `psql`. Branches on the
 * file suffix so both gzipped (`.sql.gz`) and plain (`.sql`) dumps produced by
 * the backup handler restore. `set -o pipefail` is what makes a failing
 * `gunzip` fail the whole command instead of being masked by psql's exit code.
 */
export function pgRestorePipeline(
  database: string,
  source: string,
  gzipped: boolean
): string {
  const psqlCmd = `psql -v ON_ERROR_STOP=on -U postgres -d ${shq(database)}`;
  return gzipped
    ? `set -o pipefail; gunzip -c ${shq(source)} | ${psqlCmd}`
    : `${psqlCmd} < ${shq(source)}`;
}

// --- MySQL / MariaDB -------------------------------------------------------
//
// One code path for both engines. Every pipeline below resolves its client
// binary at run time (MariaDB 11 renamed them) and passes the password through
// MYSQL_PWD so it never reaches argv — see lib/services for both helpers.

/**
 * The dump flags that make a mysqldump a faithful, restorable copy of a schema.
 *
 * `--single-transaction` takes the snapshot inside one consistent read instead
 * of locking the tables. `--routines --triggers --events` are each off by
 * default, and omitting them silently drops stored programs from the dump.
 * `--no-tablespaces` avoids requiring the PROCESS privilege for a statement no
 * restore here needs. Deliberately no `--set-gtid-purged` or
 * `--column-statistics`: those are MySQL-only flags that MariaDB's dumper
 * rejects outright.
 */
const MYSQLDUMP_FLAGS =
  "--single-transaction --routines --triggers --events --no-tablespaces";

/**
 * The inner shell command that dumps `database` to `target`.
 *
 * mysqldump writes a plain SQL script, so compression is gzip exactly as it is
 * for pg_dump, and `set -o pipefail` keeps a dump failure from being masked by
 * gzip's exit 0.
 */
export function mysqlBackupPipeline(
  database: string,
  target: string,
  compress: boolean,
  user: string,
  password: string
): string {
  const prelude = `${MYSQLDUMP_RESOLVE}; ${mysqlPasswordExport(password)};`;
  const dumpCmd =
    `"$MYSQLDUMP" ${mysqlConnectionFlags(user)} ${MYSQLDUMP_FLAGS} ` +
    shq(database);
  return compress
    ? `set -o pipefail; ${prelude} ${dumpCmd} | gzip > ${shq(target)}`
    : `${prelude} ${dumpCmd} > ${shq(target)}`;
}

/**
 * The inner shell command that feeds a dump file back into the client, matching
 * pgRestorePipeline's handling of both `.sql` and `.sql.gz`. The client aborts
 * on the first failing statement in batch mode, so no equivalent of psql's
 * ON_ERROR_STOP is needed.
 */
export function mysqlRestorePipeline(
  database: string,
  source: string,
  gzipped: boolean,
  user: string,
  password: string
): string {
  const prelude = `${MYSQL_CLIENT_RESOLVE}; ${mysqlPasswordExport(password)};`;
  const client = `"$MYSQL" ${mysqlConnectionFlags(user)} ${shq(database)}`;
  return gzipped
    ? `set -o pipefail; ${prelude} gunzip -c ${shq(source)} | ${client}`
    : `${prelude} ${client} < ${shq(source)}`;
}

export function mysqlCreateDatabaseQuery(database: string): string {
  return `CREATE DATABASE ${mysqlQuoteId(database)};`;
}

/**
 * Drop and recreate so a dump loads into a clean schema — mysqldump output is
 * only conditionally idempotent (`--routines` in particular emits bare CREATEs),
 * so restoring over a populated schema would collide.
 */
export function mysqlRecreateDatabaseQuery(database: string): string {
  const dbId = mysqlQuoteId(database);
  return `DROP DATABASE IF EXISTS ${dbId}; CREATE DATABASE ${dbId};`;
}

export function mysqlDropDatabaseQuery(database: string): string {
  return `DROP DATABASE IF EXISTS ${mysqlQuoteId(database)};`;
}

/**
 * Rename by copying, because neither engine can do it directly: MySQL removed
 * `RENAME DATABASE` in 5.1.23 (it could corrupt data) and MariaDB never shipped
 * it. The documented replacement is to move the contents into a fresh schema,
 * and dump-and-load is the variant that carries views, routines, triggers, and
 * events across — a `RENAME TABLE` loop moves only tables and silently leaves
 * the rest behind in the old schema.
 *
 * Returns an inner shell command rather than a query, since it spans three
 * client invocations. They are `&&`-chained so a failure at any step leaves the
 * source database intact and untouched — the run is then safe to retry.
 */
export function mysqlRenameDatabasePipeline(
  from: string,
  to: string,
  user: string,
  password: string
): string {
  const conn = mysqlConnectionFlags(user);
  // The preamble is `;`-separated because each resolve already exits on its own
  // failure; only the three database steps are `&&`-chained, so mixing the two
  // operators (which share a precedence level) can't reorder anything.
  const preamble = [
    MYSQL_CLIENT_RESOLVE,
    MYSQLDUMP_RESOLVE,
    mysqlPasswordExport(password),
    "set -o pipefail",
  ].join("; ");
  const create = `"$MYSQL" ${conn} -e ${shq(mysqlCreateDatabaseQuery(to))}`;
  const copy = `"$MYSQLDUMP" ${conn} ${MYSQLDUMP_FLAGS} ${shq(from)} | "$MYSQL" ${conn} ${shq(to)}`;
  const dropOld = `"$MYSQL" ${conn} -e ${shq(mysqlDropDatabaseQuery(from))}`;
  // Roll the destination back if the copy (or the final drop) fails, so a
  // failed rename leaves the server exactly as it was rather than stranding a
  // half-populated schema. Only reachable once CREATE succeeded, so this can
  // never drop a database that was already there.
  const rollback = `"$MYSQL" ${conn} -e ${shq(mysqlDropDatabaseQuery(to))}; exit 1`;
  return `${preamble}; ${create} && { ${copy} && ${dropOld} || { ${rollback}; }; }`;
}

// --- SQL Server ------------------------------------------------------------

/**
 * Back `database` up to `target`.
 *
 * The .bak format is the same regardless of compression — the COMPRESSION
 * option just toggles internal block-level compression. NO_COMPRESSION is the
 * explicit opt-out (also the engine default when omitted, but explicit is
 * clearer in the audit log).
 */
export function mssqlBackupQuery(
  database: string,
  target: string,
  compress: boolean
): string {
  const compressionClause = compress ? "COMPRESSION" : "NO_COMPRESSION";
  return (
    `BACKUP DATABASE [${sqlBracketId(database)}] ` +
    `TO DISK = N'${sqlQuoteString(target)}' ` +
    `WITH FORMAT, INIT, ${compressionClause}, STATS = 5`
  );
}

export function mssqlCreateDatabaseQuery(database: string): string {
  return `CREATE DATABASE [${sqlBracketId(database)}];`;
}

/**
 * Flip to SINGLE_USER WITH ROLLBACK IMMEDIATE to kill active connections, then
 * drop. The ALTER is guarded by an existence check so dropping a database that
 * isn't there is a no-op rather than a hard error.
 */
export function mssqlDropDatabaseQuery(database: string): string {
  const dbId = sqlBracketId(database);
  return (
    `IF DB_ID(N'${sqlQuoteString(database)}') IS NOT NULL\n` +
    `BEGIN\n` +
    `  ALTER DATABASE [${dbId}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n` +
    `  DROP DATABASE [${dbId}];\n` +
    `END;`
  );
}

/** Kill connections, rename, then hand the database back to MULTI_USER. */
export function mssqlRenameDatabaseQuery(from: string, to: string): string {
  const fromId = sqlBracketId(from);
  const toId = sqlBracketId(to);
  return (
    `ALTER DATABASE [${fromId}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n` +
    `ALTER DATABASE [${fromId}] MODIFY NAME = [${toId}];\n` +
    `ALTER DATABASE [${toId}] SET MULTI_USER;`
  );
}

export type MssqlBackupFile = {
  logical: string;
  physical: string;
  type: string;
};

/** Read the logical file layout of a backup, so we can build WITH MOVE clauses. */
export function mssqlFileListQuery(source: string): string {
  return `RESTORE FILELISTONLY FROM DISK = N'${sqlQuoteString(source)}';`;
}

/**
 * Column flags that make `RESTORE FILELISTONLY` output parseable: `-h -1` drops
 * headers, `-W` trims padding, `-s ~` separates columns with a character that
 * won't appear in a path or logical name.
 */
export const MSSQL_FILE_LIST_FLAGS = ["-h", "-1", "-W", "-s", "~"];

// The file types SQL Server reports. Anything else — notably sqlcmd's trailing
// "(N rows affected)" line — is not a file and is dropped.
const MSSQL_FILE_TYPES = new Set(["D", "L", "S", "F"]);

/** Parse the `~`-separated rows produced by mssqlFileListQuery. */
export function parseMssqlFileList(output: string): MssqlBackupFile[] {
  const files: MssqlBackupFile[] = [];
  for (const line of output.split("\n")) {
    const parts = line.split("~");
    if (parts.length < 3) continue;
    const type = parts[2]?.trim().toUpperCase();
    if (!type || !MSSQL_FILE_TYPES.has(type)) continue;
    // `parts.length < 3` was skipped above, so 0 and 1 are present.
    files.push({
      logical: parts[0]?.trim() ?? "",
      physical: parts[1]?.trim() ?? "",
      type,
    });
  }
  return files;
}

/**
 * Map each logical file in the backup to a fresh physical path named after the
 * TARGET database. Without this, restoring one DB's backup into a differently
 * named DB (e.g. car2's .bak into car3) fails with Msg 1834/3156, because the
 * backup's stored paths point at the source DB's live, in-use files. First data
 * file → .mdf, extra data files → .ndf, logs → .ldf, all kept in their original
 * directory.
 */
export function buildMssqlMoveClauses(
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

/**
 * Restore a .bak into `database`, relocating its files onto the target's own
 * paths (see buildMssqlMoveClauses).
 *
 * TRY/CATCH so a failed restore still flips back to MULTI_USER instead of
 * leaving the database wedged in single-user mode. The DB_ID guards handle a
 * target that doesn't exist yet (a fresh restore). THROW surfaces the real SQL
 * error number and message through sqlcmd's non-zero exit, instead of the
 * generic "terminating abnormally".
 */
export function mssqlRestoreQuery(
  database: string,
  source: string,
  moves: string[]
): string {
  const dbId = sqlBracketId(database);
  const dbLit = sqlQuoteString(database);
  const restoreOptions = ["REPLACE", ...moves].join(",\n  ");
  return (
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
    `  ALTER DATABASE [${dbId}] SET MULTI_USER;`
  );
}

// --- Cross-server restore transfer -----------------------------------------
//
// When the source backup lives on a different DB server/service than the
// restore target (only the dbType matches), the file must be physically copied
// into the target's backup dir before the normal restore can read it. The move
// hops through the panel: extract the source file into an SSH-owned temp on the
// source host, SFTP it down to the panel, SFTP it up to the target host, then
// place it into the target's backup dir with the DB user's ownership. Streaming
// host-to-host directly isn't possible (SFTP is per-connection), and passing
// the bytes through a shell would collide with `sudo -S`'s stdin.

/**
 * The slice of an environment the three builders below actually read.
 *
 * Structural rather than `EnvironmentWithServers` so a test can hand them a
 * literal instead of a full row with its 30 unrelated columns —
 * `EnvironmentWithServers` still satisfies it, so call sites are unchanged.
 */
export type CommandTargetEnvironment = {
  id: string;
  services: {
    role: string;
    serviceType: ServiceType;
    serviceName: string;
    dbType: DatabaseType | null;
    dbName: string | null;
    dbBackupPath: string | null;
    server: { host: string; username: string; password: string };
  }[];
};

/**
 * Command (run on the SOURCE host as the SSH user) that writes the backup file
 * to `hostTmp`, an SSH-owned path. The db-shell wrapper `cat`s the file from
 * inside the container / as the DB OS user; the `> hostTmp` redirect runs in
 * the outer SSH-user shell so the temp ends up SSH-readable for SFTP.
 */
export function buildExtractCommand(
  environment: CommandTargetEnvironment,
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

/**
 * Command (run on the TARGET host) that moves the SSH-owned `hostTmp` into the
 * target's backup dir as `dst`, owned/readable by the DB process.
 */
export function buildPlaceCommand(
  environment: CommandTargetEnvironment,
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

/**
 * Command (run on the TARGET host) removing the staged copy from the backup dir
 * once the restore has consumed it, so foreign backups don't linger.
 */
export function buildRemovePlacedCommand(
  environment: CommandTargetEnvironment,
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

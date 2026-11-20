import { createHash, randomInt } from "node:crypto";
import { assistantDbUnavailableReason } from "@/lib/assistant-db/availability";
import { scramSha256Verifier } from "@/lib/assistant-db/scram";
import {
  mysqlQuoteId,
  mysqlStdinCommand,
  pgQuoteId,
  pgQuoteLiteral,
  sqlcmdStdinCommand,
  sqlQuoteString,
} from "@/lib/jobs/commands";
import { privilegedWithStdin } from "@/lib/privileged";
import { provisionedRoleMarker } from "@/lib/provisioning/database";
import {
  buildDbShellCommand,
  type DatabaseType,
  dbAdminUser,
  type ServiceType,
} from "@/lib/services";
import { shq } from "@/lib/sh";
import { executeRemoteCommand, redactSecrets } from "@/lib/ssh";
import {
  HostKeyMismatchError,
  type SshTarget,
  sshTarget,
} from "@/lib/ssh-connect";

// The Assistant's dedicated read-only login per environment (Stage 9 spec
// F.2). Enabling creates, through Menara's admin path, a login that reads
// only that environment's database; disabling drops it. Server-only (SSH).
//
// - Postgres: role `menara_ro_<db>` with LOGIN, CONNECT on this
//   database, USAGE + SELECT on its non-system schemas and tables, default
//   privileges so new tables stay readable, `default_transaction_read_only`
//   and a 10 s statement timeout. No predefined pg_* role, no
//   pg_read_all_data: PUBLIC keeps CONNECT on a shared host's other
//   databases (lib/provisioning/database), but without grants their tables
//   stay unreadable. Marked like every role Menara makes for the
//   environment, so the teardown of a shared database drops it too.
//   In a container (or on a shared host) it has no password: Menara
//   connects over the container's trusted local socket. Run by systemd,
//   where the socket only admits `postgres` (peer), it gets a generated
//   password, set as a pre-computed SCRAM-SHA-256 verifier so Postgres and
//   its log never see the plaintext, and logs in over 127.0.0.1.
// - SQL Server: a login plus a user in this database, member of
//   db_datareader only.
// - MySQL/MariaDB: a user on 127.0.0.1 with SELECT on this database only.
//   Neither engine stores a per-user statement timeout, so the query path
//   sets MAX_EXECUTION_TIME (MySQL) / max_statement_time (MariaDB) itself.
//
// External databases are provisioned the same way: the engine and service
// type pick the path, never `dbKind`.
//
// The MSSQL/MySQL/systemd-Postgres password is generated here, stored
// encrypted by the caller, and only ever travels on stdin
// (lib/jobs/commands#sqlcmdStdinCommand).

export const ASSISTANT_DB_LOGIN_PREFIX = "menara_ro_";
export const ASSISTANT_DB_STATEMENT_TIMEOUT = "10s";
// Postgres identifiers are 63 bytes; SQL Server allows 128, kept at 63 too;
// MySQL user names are 32 characters.
const NAME_LIMITS: Record<DatabaseType, number> = {
  postgres: 63,
  mssql: 63,
  mysql: 32,
};

/**
 * `menara_ro_<db name>`, lowercased to `[a-z0-9_]`. A name that had to be
 * changed or cut gets `_<8 hex of sha256(db name)>`, so two databases never
 * share a login.
 */
export function assistantDbLoginName(
  engine: DatabaseType,
  dbName: string
): string {
  const limit = NAME_LIMITS[engine];
  const clean = dbName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const plain = `${ASSISTANT_DB_LOGIN_PREFIX}${clean}`;
  if (clean === dbName && plain.length <= limit) return plain;
  const hash = createHash("sha256").update(dbName).digest("hex").slice(0, 8);
  const room = limit - ASSISTANT_DB_LOGIN_PREFIX.length - hash.length - 1;
  return `${ASSISTANT_DB_LOGIN_PREFIX}${clean.slice(0, room)}_${hash}`;
}

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * 32 random alphanumerics (about 190 bits) with at least one upper, lower
 * and digit, which SQL Server's password policy asks for. Nothing to escape.
 */
export function generateAssistantDbPassword(): string {
  for (;;) {
    let pw = "";
    for (let i = 0; i < 32; i++) pw += ALPHABET[randomInt(ALPHABET.length)];
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw)) return pw;
  }
}

// Raised inside the provisioning scripts, recognised in their error output.
const LOGIN_EXISTS = "menara-assistant-login-exists";
const LOGIN_MAPPED = "menara-assistant-login-mapped";

/**
 * Enabling refused before anything changed: a login of that name exists on
 * the server and the environment doesn't record it as its own ("exists"), or
 * the SQL Server login also has a user in another database ("mapped").
 * Never taken over, never dropped.
 */
export class AssistantDbLoginRefused extends Error {
  constructor(
    readonly reason: "exists" | "mapped",
    readonly login: string
  ) {
    super(
      reason === "exists"
        ? `A login named ${login} already exists on the database server`
        : `The login ${login} has a user in another database`
    );
    this.name = "AssistantDbLoginRefused";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NON_SYSTEM_SCHEMA =
  "nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'";
const TABLE_KINDS = "('r', 'v', 'm', 'p', 'f')";
const SEARCH_PATH = "SET search_path = pg_catalog, pg_temp;";
// What lib/assistant-db/scram produces: nothing a literal must escape.
const SCRAM_VERIFIER =
  /^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

// --- Postgres ------------------------------------------------------------------

/**
 * The script that creates (or refreshes) the read-only role, run with
 * `psql -X -q -1 -v ON_ERROR_STOP=on` as postgres connected to `database`,
 * so it is one transaction: any refusal rolls everything back. The search
 * path is pinned first, so a database setting made by its owner can't
 * shadow a catalog function. Refuses an existing role unless `adopt` (the
 * environment records it as its own) and it carries this environment's
 * marker: a hand-made or foreign role is never taken over. After
 * granting verifies the role is unprivileged, a member of no role, and can't
 * create in the database or any of its schemas nor write any of its tables
 * (a privilege granted to PUBLIC would give it that).
 *
 * Default privileges are set for the database owner, the owners of its
 * schemas and tables, and `appRoles` (the shared binding's role): whoever
 * creates the next table, it stays readable. They live in this database only.
 *
 * `passwordVerifier` (lib/assistant-db/scram) becomes the role's password,
 * on create and on every refresh; without it the role has none. Only a
 * verifier is accepted, never a plaintext password.
 */
export function pgEnableAssistantDbSql(input: {
  database: string;
  role: string;
  environmentId: string;
  appRoles: string[];
  adopt: boolean;
  passwordVerifier?: string;
}): string {
  if (!UUID.test(input.environmentId)) {
    throw new Error("environmentId must be a uuid");
  }
  const verifier = input.passwordVerifier;
  if (verifier !== undefined && !SCRAM_VERIFIER.test(verifier)) {
    throw new Error("passwordVerifier must be a SCRAM-SHA-256 verifier");
  }
  const verifierLit = verifier === undefined ? null : pgQuoteLiteral(verifier);
  const db = pgQuoteId(input.database);
  const role = pgQuoteId(input.role);
  const dbLit = pgQuoteLiteral(input.database);
  const roleLit = pgQuoteLiteral(input.role);
  const markerLit = pgQuoteLiteral(provisionedRoleMarker(input.environmentId));
  const appRoles = input.appRoles.length
    ? `UNION SELECT oid FROM pg_roles WHERE ${input.appRoles
        .map((r) => `rolname = ${pgQuoteLiteral(r)}`)
        .join(" OR ")}`
    : "";
  // DO bodies are ordinary string literals (pgQuoteLiteral), as in
  // lib/provisioning/database: a quoted name inside can never end one early.
  const guard = [
    "DECLARE role_oid oid;",
    "BEGIN",
    `  IF current_database() <> ${dbLit} THEN`,
    `    RAISE EXCEPTION 'connected to % instead of %', current_database(), ${dbLit};`,
    "  END IF;",
    `  SELECT oid INTO role_oid FROM pg_roles WHERE rolname = ${roleLit};`,
    "  IF role_oid IS NULL THEN",
    verifierLit === null
      ? `    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', ${roleLit});`
      : `    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', ${roleLit}, ${verifierLit});`,
    `    EXECUTE format('COMMENT ON ROLE %I IS %L', ${roleLit}, ${markerLit});`,
    // Not recorded as the environment's own: never taken over, even when
    // it carries the marker (a leftover nobody tracks any more).
    ...(input.adopt
      ? [
          `  ELSIF shobj_description(role_oid, 'pg_authid') IS DISTINCT FROM ${markerLit} THEN`,
          `    RAISE EXCEPTION 'role % was not created by Menara for this environment', ${roleLit};`,
        ]
      : [
          "  ELSE",
          `    RAISE EXCEPTION '${LOGIN_EXISTS}: role % already exists', ${roleLit};`,
        ]),
    "  END IF;",
    "END",
  ].join("\n");
  const grants = [
    "DECLARE s record; o record;",
    "BEGIN",
    `  FOR s IN SELECT nspname FROM pg_namespace WHERE ${NON_SYSTEM_SCHEMA} LOOP`,
    `    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s.nspname, ${roleLit});`,
    `    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', s.nspname, ${roleLit});`,
    "  END LOOP;",
    "  FOR o IN SELECT rolname FROM pg_roles WHERE oid IN (",
    "      SELECT datdba FROM pg_database WHERE datname = current_database()",
    `      UNION SELECT nspowner FROM pg_namespace WHERE ${NON_SYSTEM_SCHEMA}`,
    "      UNION SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace",
    `        WHERE n.${NON_SYSTEM_SCHEMA} AND c.relkind IN ${TABLE_KINDS}`,
    `      ${appRoles}`,
    `    ) AND rolname <> ${roleLit}`,
    "  LOOP",
    `    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT SELECT ON TABLES TO %I', o.rolname, ${roleLit});`,
    `    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT USAGE ON SCHEMAS TO %I', o.rolname, ${roleLit});`,
    "  END LOOP;",
    "END",
  ].join("\n");
  const verify = [
    "DECLARE role_oid oid; bad text;",
    "BEGIN",
    `  SELECT oid INTO role_oid FROM pg_roles WHERE rolname = ${roleLit};`,
    "  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid = role_oid AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) THEN",
    `    RAISE EXCEPTION 'role % is privileged', ${roleLit};`,
    "  END IF;",
    "  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = role_oid) THEN",
    `    RAISE EXCEPTION 'role % is a member of another role', ${roleLit};`,
    "  END IF;",
    "  IF has_database_privilege(role_oid, current_database(), 'CREATE') THEN",
    `    RAISE EXCEPTION 'role % could create schemas in %', ${roleLit}, current_database();`,
    "  END IF;",
    `  SELECT string_agg(nspname, ', ') INTO bad FROM pg_namespace WHERE ${NON_SYSTEM_SCHEMA} AND has_schema_privilege(role_oid, oid, 'CREATE');`,
    "  IF bad IS NOT NULL THEN",
    `    RAISE EXCEPTION 'role % could create objects in schema %; revoke CREATE from PUBLIC there first', ${roleLit}, left(bad, 300);`,
    "  END IF;",
    "  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') INTO bad FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace",
    `    WHERE n.${NON_SYSTEM_SCHEMA} AND c.relkind IN ${TABLE_KINDS}`,
    "    AND has_table_privilege(role_oid, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');",
    "  IF bad IS NOT NULL THEN",
    `    RAISE EXCEPTION 'role % could write table %; revoke the privilege from PUBLIC first', ${roleLit}, left(bad, 300);`,
    "  END IF;",
    "END",
  ].join("\n");
  return [
    SEARCH_PATH,
    `DO ${pgQuoteLiteral(guard)};`,
    `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD ${verifierLit ?? "NULL"};`,
    `ALTER ROLE ${role} SET default_transaction_read_only = on;`,
    `ALTER ROLE ${role} SET statement_timeout = ${pgQuoteLiteral(ASSISTANT_DB_STATEMENT_TIMEOUT)};`,
    `GRANT CONNECT ON DATABASE ${db} TO ${role};`,
    `DO ${pgQuoteLiteral(grants)};`,
    `DO ${pgQuoteLiteral(verify)};`,
    "",
  ].join("\n");
}

/**
 * Drops the role: its privileges and default privileges in the connected
 * database first (DROP OWNED also revokes CONNECT, a shared object), then the
 * role. A role that is already gone is fine; one without this environment's
 * marker is refused.
 */
export function pgDisableAssistantDbSql(input: {
  role: string;
  environmentId: string;
}): string {
  if (!UUID.test(input.environmentId)) {
    throw new Error("environmentId must be a uuid");
  }
  const roleLit = pgQuoteLiteral(input.role);
  const markerLit = pgQuoteLiteral(provisionedRoleMarker(input.environmentId));
  const drop = [
    "DECLARE role_oid oid;",
    "BEGIN",
    `  SELECT oid INTO role_oid FROM pg_roles WHERE rolname = ${roleLit};`,
    "  IF role_oid IS NULL THEN RETURN; END IF;",
    `  IF shobj_description(role_oid, 'pg_authid') IS DISTINCT FROM ${markerLit} THEN`,
    `    RAISE EXCEPTION 'role % was not created by Menara for this environment', ${roleLit};`,
    "  END IF;",
    `  EXECUTE format('DROP OWNED BY %I', ${roleLit});`,
    `  EXECUTE format('DROP ROLE %I', ${roleLit});`,
    "END",
  ].join("\n");
  return [SEARCH_PATH, `DO ${pgQuoteLiteral(drop)};`, ""].join("\n");
}

const PSQL_ADMIN = "psql -X -q -1 -v ON_ERROR_STOP=on -U postgres";

/**
 * The inner shell command that runs pgEnableAssistantDbSql as postgres in the
 * environment's database, the SQL in the command (container/shared Postgres:
 * it carries no secret, so no verifier is accepted here).
 */
export function pgEnableAssistantDbPipeline(
  input: Omit<Parameters<typeof pgEnableAssistantDbSql>[0], "passwordVerifier">
): string {
  const sql = pgEnableAssistantDbSql(input);
  return `printf '%s\\n' ${shq(sql)} | ${pgAssistantDbAdminPsql(input.database)}`;
}

/**
 * psql as postgres in `database`, one transaction, reading its script from
 * stdin: how systemd Postgres gets pgEnableAssistantDbSql with a verifier.
 */
export function pgAssistantDbAdminPsql(database: string): string {
  return `${PSQL_ADMIN} -d ${shq(database)}`;
}

/**
 * Logs in as the role the way the query path will: over the local socket
 * (container), or with `tcp` over 127.0.0.1 with its password, which the
 * shell reads from the first stdin line into PGPASSWORD (never argv). Feed
 * it `${password}\n` and run it as the SSH user (no runAsUser).
 */
export function pgAssistantDbCheckCommand(
  role: string,
  database: string,
  opts: { tcp?: boolean } = {}
) {
  if (opts.tcp) {
    return `IFS= read -r PGPASSWORD; export PGPASSWORD; psql -X -q -v ON_ERROR_STOP=on -h 127.0.0.1 -U ${shq(role)} -d ${shq(database)} -Atc 'select 1'`;
  }
  return `psql -X -q -v ON_ERROR_STOP=on -U ${shq(role)} -d ${shq(database)} -Atc 'select 1'`;
}

/**
 * The inner shell command that runs pgDisableAssistantDbSql against the
 * environment's database when it still exists (its grants live there),
 * else against `postgres`.
 */
export function pgDisableAssistantDbPipeline(input: {
  database: string;
  role: string;
  environmentId: string;
}): string {
  const { database } = input;
  const sql = pgDisableAssistantDbSql(input);
  const exists =
    `exists=$(psql -X -At -v ON_ERROR_STOP=on -U postgres -d postgres ` +
    `-c ${shq(`SELECT 1 FROM pg_database WHERE datname = ${pgQuoteLiteral(database)}`)}) || exit 1`;
  return (
    `${exists}; if [ "$exists" = 1 ]; then target=${shq(database)}; else target=postgres; fi; ` +
    `printf '%s\\n' ${shq(sql)} | ${PSQL_ADMIN} -d "$target"`
  );
}

// --- SQL Server ----------------------------------------------------------------

// Values reach T-SQL only as N'…' literals in DECLAREs; identifiers and the
// password are bracketed/quoted by QUOTENAME at run time.
function mssqlDeclares(values: {
  database: string;
  login: string;
  password?: string;
}): string[] {
  return [
    "SET NOCOUNT ON;",
    "SET XACT_ABORT ON;",
    `DECLARE @db sysname = N'${sqlQuoteString(values.database)}';`,
    `DECLARE @login sysname = N'${sqlQuoteString(values.login)}';`,
    ...(values.password === undefined
      ? []
      : [`DECLARE @pw nvarchar(128) = N'${sqlQuoteString(values.password)}';`]),
    "DECLARE @sql nvarchar(max);",
  ];
}

/**
 * Creates (or re-passwords) the login and its user in `database`, member of
 * db_datareader only. Refuses an existing login that holds a server role or
 * any server permission besides CONNECT SQL, and a database user that
 * belongs to another login or holds anything besides db_datareader.
 */
export function mssqlEnableAssistantDbSql(input: {
  database: string;
  login: string;
  password: string;
  adopt: boolean;
}): string {
  // Runs inside the database (sp_executesql after USE), @login a parameter.
  const inDatabase = [
    "DECLARE @q nvarchar(max);",
    "IF @adopt = 0 AND DATABASE_PRINCIPAL_ID(@login) IS NOT NULL",
    `  THROW 50000, N'${LOGIN_EXISTS}: a database user with that name exists', 1;`,
    "IF DATABASE_PRINCIPAL_ID(@login) IS NULL",
    "BEGIN",
    "  SET @q = N'CREATE USER ' + QUOTENAME(@login) + N' FOR LOGIN ' + QUOTENAME(@login);",
    "  EXEC (@q);",
    "END",
    "ELSE IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @login AND (sid IS NULL OR sid <> SUSER_SID(@login)))",
    "  THROW 50000, N'a database user with that name belongs to another login', 1;",
    "IF EXISTS (SELECT 1 FROM sys.database_role_members rm JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id",
    "  WHERE rm.member_principal_id = DATABASE_PRINCIPAL_ID(@login) AND r.name <> N'db_datareader')",
    "  THROW 50000, N'the database user holds roles besides db_datareader', 1;",
    "IF EXISTS (SELECT 1 FROM sys.database_permissions WHERE grantee_principal_id = DATABASE_PRINCIPAL_ID(@login)",
    "  AND permission_name <> N'CONNECT' AND state IN ('G', 'W'))",
    "  THROW 50000, N'the database user holds permissions besides CONNECT', 1;",
    "SET @q = N'ALTER ROLE db_datareader ADD MEMBER ' + QUOTENAME(@login);",
    "EXEC (@q);",
  ].join("\n");
  return [
    ...mssqlDeclares(input),
    `DECLARE @adopt bit = ${input.adopt ? 1 : 0};`,
    "IF DB_ID(@db) IS NULL THROW 50000, N'database not found', 1;",
    // A login the environment doesn't record as its own is never taken over.
    "IF @adopt = 0 AND SUSER_ID(@login) IS NOT NULL",
    `  THROW 50000, N'${LOGIN_EXISTS}: a login with that name exists', 1;`,
    // A database user of that name: refused now, before any change (a
    // foreign one always, any one unless adopting).
    "DECLARE @users int, @foreign int;",
    "SET @sql = N'SELECT @users = COUNT(*), @foreign = COUNT(CASE WHEN sid IS NULL OR sid <> SUSER_SID(@login) THEN 1 END) FROM '",
    "  + QUOTENAME(@db) + N'.sys.database_principals WHERE name = @login';",
    "EXEC sp_executesql @sql, N'@login sysname, @users int OUTPUT, @foreign int OUTPUT', @login = @login, @users = @users OUTPUT, @foreign = @foreign OUTPUT;",
    "IF @foreign > 0 OR (@adopt = 0 AND @users > 0)",
    `  THROW 50000, N'${LOGIN_EXISTS}: a database user with that name exists', 1;`,
    // An existing login must not reach any other database (three-part
    // names would let a SELECT read it): no user for its SID elsewhere.
    "IF SUSER_ID(@login) IS NOT NULL",
    "BEGIN",
    "  DECLARE @sid varbinary(85) = SUSER_SID(@login);",
    "  DECLARE @other sysname, @n int, @found nvarchar(max) = N'', @q nvarchar(max);",
    "  DECLARE dbs CURSOR LOCAL FAST_FORWARD FOR",
    // Online databases only: one offline or restoring can't be read here
    // (accepted; it can't be queried either until it comes back).
    "    SELECT name FROM sys.databases WHERE name <> @db AND state = 0;",
    "  OPEN dbs;",
    "  FETCH NEXT FROM dbs INTO @other;",
    "  WHILE @@FETCH_STATUS = 0",
    "  BEGIN",
    "    SET @q = N'SELECT @n = COUNT(*) FROM ' + QUOTENAME(@other) + N'.sys.database_principals WHERE sid = @sid';",
    "    EXEC sp_executesql @q, N'@sid varbinary(85), @n int OUTPUT', @sid = @sid, @n = @n OUTPUT;",
    "    IF @n > 0 SET @found = @found + QUOTENAME(@other) + N' ';",
    "    FETCH NEXT FROM dbs INTO @other;",
    "  END",
    "  CLOSE dbs;",
    "  DEALLOCATE dbs;",
    "  IF @found <> N''",
    "  BEGIN",
    `    DECLARE @mapped nvarchar(2048) = N'${LOGIN_MAPPED}: ' + @found;`,
    "    THROW 50000, @mapped, 1;",
    "  END",
    "END",
    "IF EXISTS (SELECT 1 FROM sys.server_role_members WHERE member_principal_id = SUSER_ID(@login))",
    "  OR EXISTS (SELECT 1 FROM sys.server_permissions WHERE grantee_principal_id = SUSER_ID(@login) AND permission_name <> N'CONNECT SQL')",
    "  THROW 50000, N'the existing login holds server roles or permissions', 1;",
    "IF SUSER_ID(@login) IS NULL",
    "BEGIN",
    "  SET @sql = N'CREATE LOGIN ' + QUOTENAME(@login) + N' WITH PASSWORD = ' + QUOTENAME(@pw, '''')",
    "    + N', DEFAULT_DATABASE = ' + QUOTENAME(@db) + N', CHECK_EXPIRATION = OFF, CHECK_POLICY = ON';",
    "  EXEC (@sql);",
    "END",
    "ELSE",
    "BEGIN",
    "  SET @sql = N'ALTER LOGIN ' + QUOTENAME(@login) + N' WITH PASSWORD = ' + QUOTENAME(@pw, '''')",
    "    + N', DEFAULT_DATABASE = ' + QUOTENAME(@db);",
    "  EXEC (@sql);",
    "  SET @sql = N'ALTER LOGIN ' + QUOTENAME(@login) + N' ENABLE';",
    "  EXEC (@sql);",
    "END",
    `SET @sql = N'USE ' + QUOTENAME(@db) + N';' + NCHAR(10) + N'${sqlQuoteString(inDatabase)}';`,
    "EXEC sp_executesql @sql, N'@login sysname, @adopt bit', @login = @login, @adopt = @adopt;",
    "",
  ].join("\n");
}

/** Drops the user (when the database exists), ends the login's sessions, drops the login. */
export function mssqlDisableAssistantDbSql(input: {
  database: string;
  login: string;
}): string {
  const inDatabase = [
    "DECLARE @q nvarchar(max);",
    "IF DATABASE_PRINCIPAL_ID(@login) IS NOT NULL",
    "BEGIN",
    "  SET @q = N'DROP USER ' + QUOTENAME(@login);",
    "  EXEC (@q);",
    "END",
  ].join("\n");
  return [
    ...mssqlDeclares(input),
    "IF DB_ID(@db) IS NOT NULL",
    "BEGIN",
    `  SET @sql = N'USE ' + QUOTENAME(@db) + N';' + NCHAR(10) + N'${sqlQuoteString(inDatabase)}';`,
    "  EXEC sp_executesql @sql, N'@login sysname', @login = @login;",
    "END",
    "IF SUSER_ID(@login) IS NOT NULL",
    "BEGIN",
    "  SET @sql = N'';",
    "  SELECT @sql = @sql + N'KILL ' + CAST(session_id AS nvarchar(10)) + N';' FROM sys.dm_exec_sessions WHERE login_name = @login;",
    "  EXEC (@sql);",
    "  SET @sql = N'DROP LOGIN ' + QUOTENAME(@login);",
    "  EXEC (@sql);",
    "END",
    "",
  ].join("\n");
}

// --- MySQL / MariaDB -----------------------------------------------------------

// Generated names and passwords only: nothing a string literal must escape,
// whatever the server's NO_BACKSLASH_ESCAPES setting.
const MYSQL_SAFE = /^[A-Za-z0-9_]+$/;

function mysqlAccount(user: string): string {
  if (!MYSQL_SAFE.test(user)) throw new Error("unexpected MySQL user name");
  return `'${user}'@'127.0.0.1'`;
}

/**
 * A database name as a GRANT target: `_` and `%` are wildcards there (even
 * backquoted), so they are escaped, else `kestrel_qa` would also match
 * `kestrelXqa`.
 */
function mysqlGrantDatabase(database: string): string {
  return mysqlQuoteId(database.replace(/[\\_%]/g, (c) => `\\${c}`));
}

/**
 * Creates (or re-passwords) the user on 127.0.0.1 only (the query path
 * connects over the container's loopback), strips any privilege it holds,
 * then grants SELECT on `database` alone.
 */
export function mysqlEnableAssistantDbSql(input: {
  database: string;
  user: string;
  password: string;
  // The environment's own recorded user: refreshed. Otherwise a plain
  // CREATE USER, which fails if the user appeared since the probe.
  adopt: boolean;
}): string {
  const account = mysqlAccount(input.user);
  if (!MYSQL_SAFE.test(input.password)) {
    throw new Error("unexpected MySQL password characters");
  }
  const pw = `'${input.password}'`;
  return [
    ...(input.adopt
      ? [
          `CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${pw} WITH MAX_USER_CONNECTIONS 5;`,
          `ALTER USER ${account} IDENTIFIED BY ${pw} WITH MAX_USER_CONNECTIONS 5;`,
        ]
      : [
          `CREATE USER ${account} IDENTIFIED BY ${pw} WITH MAX_USER_CONNECTIONS 5;`,
        ]),
    `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account};`,
    `GRANT SELECT ON ${mysqlGrantDatabase(input.database)}.* TO ${account};`,
  ].join("\n");
}

/** Counts the accounts of that user name on any host (`-N -B` output). */
export function mysqlAssistantDbProbeSql(user: string): string {
  mysqlAccount(user);
  return `SELECT COUNT(*) FROM mysql.user WHERE User = '${user}';`;
}

export function mysqlDisableAssistantDbSql(input: { user: string }): string {
  return `DROP USER IF EXISTS ${mysqlAccount(input.user)};`;
}

// --- Runners -------------------------------------------------------------------

/** The decrypted db service fields provisioning reads. */
export type AssistantDbService = {
  serviceType: ServiceType;
  serviceName: string;
  dbType: DatabaseType | null;
  dbName: string | null;
  dbUser: string | null;
  // Decrypted admin password (mssql, mysql).
  dbPassword: string | null;
  dbKind: "shared" | "container" | "external" | null;
  // The shared binding's app role.
  dbRole: string | null;
  server: {
    id: string;
    host: string;
    username: string;
    password: string | null;
    auth: "password" | "key";
  };
};

const PROVISION_TIMEOUT_MS = 60_000;

type Ready = AssistantDbService & { dbType: DatabaseType; dbName: string };

function ready(service: AssistantDbService): Ready {
  const reason = assistantDbUnavailableReason({
    dbKind: service.dbKind,
    serviceType: service.serviceType,
    dbType: service.dbType,
    dbName: service.dbName,
    hasAdminPassword: Boolean(service.dbPassword),
  });
  if (reason)
    throw new Error(`Assistant database login unavailable: ${reason}`);
  return service as Ready;
}

async function run(
  creds: SshTarget,
  command: string,
  secrets: string[],
  stdin?: string
): Promise<string> {
  try {
    return await executeRemoteCommand(creds, command, {
      timeoutMs: PROVISION_TIMEOUT_MS,
      secrets,
      ...(stdin === undefined ? {} : { stdin }),
    });
  } catch (error) {
    // Carries no secret; teardown reports it as such.
    if (error instanceof HostKeyMismatchError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(message, secrets));
  }
}

/** The refusal a script raised, else the error itself. */
function refusalOf(error: unknown, login: string): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(LOGIN_MAPPED)) {
    return new AssistantDbLoginRefused("mapped", login);
  }
  // MySQL's plain CREATE USER on a user that appeared since the probe.
  if (
    message.includes(LOGIN_EXISTS) ||
    /ERROR 1396|Operation CREATE USER failed/.test(message)
  ) {
    return new AssistantDbLoginRefused("exists", login);
  }
  return error;
}

function secretsOf(service: AssistantDbService, password: string | null) {
  return [service.dbPassword, password, service.server.password].filter(
    (s): s is string => Boolean(s)
  );
}

/**
 * Creates or refreshes the environment's read-only login, then proves it can
 * log in the way the query path will (as the login, on the database host's
 * local socket or loopback). A login that can't log in is dropped again and
 * the error names the cause.
 *
 * `ownLogin` is the login the environment row records. Only that one is
 * refreshed (and keeps `password`, the stored one); any other existing
 * login, role or user of that name is refused with AssistantDbLoginRefused
 * before anything changes, as is a SQL Server login with a user in another
 * database. A first enable that fails halfway drops what it created.
 * Returns the login and, for mssql/mysql and systemd Postgres, its password
 * (container/shared Postgres: null). Refuses incomplete config or a missing
 * admin password before any SSH. Errors never carry a password.
 */
export async function enableAssistantDbLogin(
  input: AssistantDbService,
  opts: {
    environmentId: string;
    ownLogin: string | null;
    password: string | null;
  }
): Promise<{ login: string; password: string | null }> {
  const service = ready(input);
  const login = assistantDbLoginName(service.dbType, service.dbName);
  const adopt = opts.ownLogin === login;
  const creds = sshTarget(service.server);
  const dropAgain = () =>
    disableAssistantDbLogin(input, {
      environmentId: opts.environmentId,
      login,
    }).catch(() => {});
  // The environment's own login keeps its stored password; a new one, or
  // one recorded before it had a password, gets a fresh one.
  const storedOrNew = () =>
    (adopt ? opts.password : null) ?? generateAssistantDbPassword();
  if (service.dbType === "postgres" && service.serviceType === "systemd") {
    return enableSystemdPg(service, {
      environmentId: opts.environmentId,
      login,
      adopt,
      password: storedOrNew(),
      dropAgain,
    });
  }
  if (service.dbType === "postgres") {
    const pipeline = pgEnableAssistantDbPipeline({
      database: service.dbName,
      role: login,
      environmentId: opts.environmentId,
      appRoles: service.dbRole ? [service.dbRole] : [],
      adopt,
    });
    const secrets = secretsOf(service, null);
    // One transaction: a refusal or failure leaves nothing behind.
    try {
      await run(creds, pgShell(service, pipeline), secrets);
    } catch (error) {
      throw refusalOf(error, login);
    }
    try {
      await run(
        creds,
        pgShell(service, pgAssistantDbCheckCommand(login, service.dbName)),
        secrets
      );
    } catch (error) {
      // The environment's own login stays recorded; only a new one goes.
      if (!adopt) await dropAgain();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Role ${login} cannot connect to ${service.dbName} over the database host's local socket; its pg_hba must trust local connections: ${message}`
      );
    }
    return { login, password: null };
  }

  const password = storedOrNew();
  const secrets = secretsOf(service, password);
  const admin = dbAdminUser(service.dbType, service.dbUser);
  const adminPassword = service.dbPassword as string;
  if (service.dbType === "mysql" && !adopt) {
    const count = await run(
      creds,
      mysqlStdinCommand(admin, service.serviceType, service.serviceName, [
        "-N",
        "-B",
      ]),
      secrets,
      `${adminPassword}\n${mysqlAssistantDbProbeSql(login)}\n`
    );
    if (count.trim() !== "0") {
      throw new AssistantDbLoginRefused("exists", login);
    }
  }
  try {
    if (service.dbType === "mssql") {
      const sql = mssqlEnableAssistantDbSql({
        database: service.dbName,
        login,
        password,
        adopt,
      });
      await run(
        creds,
        sqlcmdStdinCommand(admin, service.serviceType, service.serviceName),
        secrets,
        `${adminPassword}\n${sql}`
      );
    } else {
      const sql = mysqlEnableAssistantDbSql({
        database: service.dbName,
        user: login,
        password,
        adopt,
      });
      await run(
        creds,
        mysqlStdinCommand(admin, service.serviceType, service.serviceName),
        secrets,
        `${adminPassword}\n${sql}\n`
      );
    }
  } catch (error) {
    const refused = refusalOf(error, login);
    // A first enable may have created the login before failing; a refusal
    // changed nothing and must never drop someone else's login.
    if (!(refused instanceof AssistantDbLoginRefused) && !adopt) {
      await dropAgain();
    }
    throw refused;
  }
  try {
    const check =
      service.dbType === "mssql"
        ? sqlcmdStdinCommand(login, service.serviceType, service.serviceName, [
            "-d",
            service.dbName,
            "-Q",
            "SELECT 1",
          ])
        : mysqlStdinCommand(login, service.serviceType, service.serviceName, [
            "-e",
            "SELECT 1",
            service.dbName,
          ]);
    await run(creds, check, secrets, `${password}\n`);
  } catch (error) {
    if (!adopt) await dropAgain();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Login ${login} cannot log in to ${service.dbName}: ${message}`
    );
  }
  return { login, password };
}

/**
 * Postgres run by systemd: the admin script runs as `postgres` on the socket
 * (peer), its SQL, which carries the role's SCRAM verifier, on stdin; then
 * the role logs in over 127.0.0.1 with its password on stdin, as the query
 * path will.
 */
async function enableSystemdPg(
  service: Ready,
  opts: {
    environmentId: string;
    login: string;
    adopt: boolean;
    password: string;
    dropAgain: () => Promise<void>;
  }
): Promise<{ login: string; password: string }> {
  const { login, adopt, password } = opts;
  const creds = sshTarget(service.server);
  const verifier = await scramSha256Verifier(password);
  const secrets = [...secretsOf(service, password), verifier];
  const sql = pgEnableAssistantDbSql({
    database: service.dbName,
    role: login,
    environmentId: opts.environmentId,
    appRoles: service.dbRole ? [service.dbRole] : [],
    adopt,
    passwordVerifier: verifier,
  });
  const admin = privilegedWithStdin(
    pgAssistantDbAdminPsql(service.dbName),
    service.server,
    { runAsUser: "postgres", stdin: sql }
  );
  // One transaction: a refusal or failure leaves nothing behind.
  try {
    await run(creds, admin.command, secrets, admin.stdin);
  } catch (error) {
    throw refusalOf(error, login);
  }
  try {
    await run(
      creds,
      pgShell(
        service,
        pgAssistantDbCheckCommand(login, service.dbName, { tcp: true }),
        { asSshUser: true }
      ),
      secrets,
      `${password}\n`
    );
  } catch (error) {
    // Deliberate: an adopted role given a fresh password here keeps it,
    // unstored; the next enable sets a new one.
    if (!adopt) await opts.dropAgain();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Role ${login} cannot log in to ${service.dbName} over 127.0.0.1 with its password; its pg_hba must allow scram-sha-256 from 127.0.0.1: ${message}`
    );
  }
  return { login, password };
}

/**
 * Drops the login/role. Idempotent: a login that is already gone is fine.
 * Postgres refuses a role without this environment's marker. Refuses
 * incomplete config or a missing admin password before any SSH.
 */
export async function disableAssistantDbLogin(
  input: AssistantDbService,
  opts: { environmentId: string; login: string }
): Promise<void> {
  const service = ready(input);
  const creds = sshTarget(service.server);
  if (service.dbType === "postgres") {
    const pipeline = pgDisableAssistantDbPipeline({
      database: service.dbName,
      role: opts.login,
      environmentId: opts.environmentId,
    });
    await run(creds, pgShell(service, pipeline), secretsOf(service, null));
    return;
  }
  const admin = dbAdminUser(service.dbType, service.dbUser);
  const secrets = secretsOf(service, null);
  if (service.dbType === "mssql") {
    await run(
      creds,
      sqlcmdStdinCommand(admin, service.serviceType, service.serviceName),
      secrets,
      `${service.dbPassword}\n${mssqlDisableAssistantDbSql({ database: service.dbName, login: opts.login })}`
    );
    return;
  }
  await run(
    creds,
    mysqlStdinCommand(admin, service.serviceType, service.serviceName),
    secrets,
    `${service.dbPassword}\n${mysqlDisableAssistantDbSql({ user: opts.login })}\n`
  );
}

// Postgres admin work runs as its OS user on systemd (peer auth); inside a
// container the exec already lands on the trusted local socket. `asSshUser`:
// no user switch (systemd's login check over 127.0.0.1 with a password).
function pgShell(
  service: Ready,
  inner: string,
  opts: { asSshUser?: boolean } = {}
): string {
  return buildDbShellCommand(
    service.serviceType,
    service.serviceName,
    inner,
    opts.asSshUser ? {} : { runAsUser: "postgres", server: service.server }
  );
}

/**
 * Connection options for the query path's psql (`PGOPTIONS`): they take
 * precedence over the role's own defaults, which Postgres lets an ordinary
 * role change for itself (ALTER ROLE <self> SET …).
 */
export const ASSISTANT_DB_PGOPTIONS = `-c default_transaction_read_only=on -c statement_timeout=${ASSISTANT_DB_STATEMENT_TIMEOUT}`;

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type { Server } from "@/lib/db/schema";
import { pgQuoteId, pgQuoteLiteral } from "@/lib/jobs/commands";
import { shq } from "@/lib/sh";
import { executeRemoteCommand, redactSecrets } from "@/lib/ssh";

// Re-exported so the provisioning code has one import site.
export { redactSecrets } from "@/lib/ssh";
export { sharedDatabaseNameSchema } from "@/lib/validation";

// Shared databases: a database and its owner role inside a registered
// Postgres container (a database host) that several environments use. The
// Panel never sends a plaintext password to the server: it computes the
// SCRAM-SHA-256 verifier itself and the SQL travels on psql's stdin.
// Server-only (node:crypto, SSH); the client-safe name schema lives in
// lib/validation.

/**
 * A SCRAM-SHA-256 verifier in the RFC 5803 form Postgres stores in
 * pg_authid.rolpassword: `SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey>`
 * (RFC 7677 keys). Postgres accepts it as `PASSWORD '<verifier>'` and stores
 * it as is, so the plaintext never reaches the server.
 *
 * The password is used as UTF-8 bytes without SASLprep. That equals what
 * Postgres computes for every ASCII password (the generated ones are ASCII);
 * a non-ASCII password may need SASLprep normalization to match.
 */
export function scramSha256Verifier(
  password: string,
  opts: { salt?: Uint8Array; iterations?: number } = {}
): string {
  const iterations = opts.iterations ?? 4096;
  const salt = Buffer.from(opts.salt ?? randomBytes(16));
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** The comment the Panel puts on every role it creates for an environment. */
export function provisionedRoleMarker(environmentId: string): string {
  return `opsdeck:${environmentId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The psql script that provisions `database` owned by `role` with the given
 * SCRAM verifier, for environment `environmentId`. Idempotent: a rerun only
 * sets the new password. A role it creates is marked with
 * `COMMENT ON ROLE … IS 'opsdeck:<environmentId>'` in the same statement
 * (one DO block, so one transaction) as CREATE ROLE. Before changing
 * anything it refuses
 * - a database that exists with another owner, or whose owner doesn't carry
 *   this environment's marker (a hand-made database);
 * - an existing role that is privileged (superuser, createrole, createdb,
 *   replication, bypassrls);
 * - an existing role that is in use anywhere but this database: a member of
 *   or granted any role (pg_auth_members), owning or granted anything outside
 *   it (pg_shdepend), or carrying settings outside it (pg_db_role_setting);
 * - an existing role whose comment isn't exactly this environment's marker
 *   (a hand-made role, even one that owns just this database: the typical
 *   app role an operator made by hand).
 *
 * So the only existing role it reuses is one the Panel created for this
 * environment that owns this exact database and nothing else (a rerun), or
 * the marked bare role a half-finished run left behind; it never takes over
 * a role made for something else and resets its password. CONNECT and
 * TEMPORARY on the database are revoked from PUBLIC, so the other roles on
 * the host can't connect to it.
 *
 * Residual risk, by design: the Panel does not revoke PUBLIC's CONNECT on the
 * host's other databases, so the role can connect to any database that
 * still grants it to PUBLIC (Postgres' default). It gets no rights on their
 * objects beyond what PUBLIC has; Postgres 15+ (required by
 * createDatabaseHost) no longer grants PUBLIC CREATE on the public schema.
 *
 * Run with `psql -X -q` as the superuser, on stdin.
 */
export function pgProvisionDatabaseSql(input: {
  database: string;
  role: string;
  verifier: string;
  environmentId: string;
}): string {
  if (!UUID.test(input.environmentId)) {
    throw new Error("environmentId must be a uuid");
  }
  const db = pgQuoteId(input.database);
  const role = pgQuoteId(input.role);
  const dbLit = pgQuoteLiteral(input.database);
  const roleLit = pgQuoteLiteral(input.role);
  const markerLit = pgQuoteLiteral(provisionedRoleMarker(input.environmentId));
  // The guard is a DO body in an ordinary string literal (not dollar
  // quoting), so the quoted names inside it can never end it early. db_oid is
  // null while the database doesn't exist yet: then every dependency counts
  // as "outside", hence IS [NOT] DISTINCT FROM rather than = / <>.
  const guard = [
    "DECLARE",
    "  current_owner name;",
    "  owner_oid oid;",
    "  db_oid oid;",
    "  role_oid oid;",
    "BEGIN",
    `  SELECT oid, datdba, pg_get_userbyid(datdba) INTO db_oid, owner_oid, current_owner FROM pg_database WHERE datname = ${dbLit};`,
    `  IF current_owner IS NOT NULL AND current_owner <> ${roleLit} THEN`,
    `    RAISE EXCEPTION 'database % exists with owner %', ${dbLit}, current_owner;`,
    "  END IF;",
    `  IF db_oid IS NOT NULL AND shobj_description(owner_oid, 'pg_authid') IS DISTINCT FROM ${markerLit} THEN`,
    `    RAISE EXCEPTION 'database % was not created by the Panel for this environment', ${dbLit};`,
    "  END IF;",
    `  SELECT oid INTO role_oid FROM pg_roles WHERE rolname = ${roleLit};`,
    "  IF role_oid IS NULL THEN",
    // Created and marked together: the DO block is one transaction.
    `    EXECUTE format('CREATE ROLE %I LOGIN', ${roleLit});`,
    `    EXECUTE format('COMMENT ON ROLE %I IS %L', ${roleLit}, ${markerLit});`,
    "    RETURN;",
    "  END IF;",
    "  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid = role_oid AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) THEN",
    `    RAISE EXCEPTION 'role % is privileged', ${roleLit};`,
    "  END IF;",
    "  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = role_oid OR roleid = role_oid)",
    "    OR EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = role_oid",
    "      AND dbid IS DISTINCT FROM db_oid",
    "      AND NOT (classid = 'pg_database'::regclass AND objid IS NOT DISTINCT FROM db_oid))",
    "    OR EXISTS (SELECT 1 FROM pg_db_role_setting WHERE setrole = role_oid AND setdatabase IS DISTINCT FROM db_oid) THEN",
    `    RAISE EXCEPTION 'role % is in use outside database %', ${roleLit}, ${dbLit};`,
    "  END IF;",
    `  IF shobj_description(role_oid, 'pg_authid') IS DISTINCT FROM ${markerLit} THEN`,
    `    RAISE EXCEPTION 'role % was not created by the Panel for this environment', ${roleLit};`,
    "  END IF;",
    "END",
  ].join("\n");
  return [
    "\\set ON_ERROR_STOP on",
    `DO ${pgQuoteLiteral(guard)};`,
    `ALTER ROLE ${role} WITH LOGIN PASSWORD ${pgQuoteLiteral(input.verifier)};`,
    // \gexec runs the returned row as a statement: none when the database
    // already exists. CREATE DATABASE can't run inside DO.
    `SELECT ${pgQuoteLiteral(`CREATE DATABASE ${db} OWNER ${role};`)} WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${dbLit}) \\gexec`,
    `REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC;`,
    "",
  ].join("\n");
}

const PROVISION_TIMEOUT_MS = 60_000;

/**
 * Creates (or updates the password of) the role and database inside the
 * host's container, then checks the role can reach its database as the
 * backups and restores will (`psql -U <role>` over the container's local
 * socket, which the host's pg_hba must trust). `server` carries the decrypted
 * SSH password, as on EnvironmentWithServers. The SQL, verifier included,
 * goes on stdin; argv holds only names. Errors never carry the password or
 * the verifier. A non-ASCII password is refused: the verifier skips SASLprep
 * (see scramSha256Verifier), so Postgres could compute a different one.
 */
export async function provisionSharedDatabase(
  host: {
    server: Pick<Server, "host" | "username" | "password">;
    containerName: string;
  },
  input: {
    database: string;
    role: string;
    password: string;
    environmentId: string;
  }
): Promise<void> {
  if (!/^[\x20-\x7e]+$/.test(input.password)) {
    throw new Error(
      "The database password must be printable ASCII (no SASLprep); regenerate it"
    );
  }
  const verifier = scramSha256Verifier(input.password);
  const sql = pgProvisionDatabaseSql({
    database: input.database,
    role: input.role,
    verifier,
    environmentId: input.environmentId,
  });
  const creds = {
    host: host.server.host,
    username: host.server.username,
    password: host.server.password ?? "",
  };
  const container = shq(host.containerName);
  const secrets = [input.password, verifier];
  try {
    await executeRemoteCommand(
      creds,
      `docker exec -i ${container} psql -U postgres -X -q -v ON_ERROR_STOP=1`,
      { timeoutMs: PROVISION_TIMEOUT_MS, stdin: sql, secrets }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(message, secrets));
  }
  try {
    await executeRemoteCommand(
      creds,
      `docker exec ${container} psql -X -U ${shq(input.role)} -d ${shq(input.database)} -Atc 'select 1'`,
      { timeoutMs: PROVISION_TIMEOUT_MS, secrets }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Role ${input.role} cannot connect to ${input.database} over the container's local socket; the host's pg_hba must trust local connections (backups and restores run as this role): ${redactSecrets(message, secrets)}`
    );
  }
}

/** The db binding fields confinement looks at. */
export type DatabaseBinding = {
  dbKind: "shared" | "container" | "external" | null;
  dbName: string;
};

/**
 * Whether a caller may back up or restore database `name` of an environment.
 * A shared binding lives in a container other environments use too, so a
 * caller without org server:manage is confined to the binding's own database
 * (creating, dropping and renaming are refused outright; see
 * server/services/database-hosts#requireUnconfined). Every other binding,
 * and every caller with server:manage, is unrestricted.
 */
export function allowedDatabaseName(
  binding: DatabaseBinding,
  name: string,
  canManageServers: boolean
): boolean {
  if (binding.dbKind !== "shared" || canManageServers) return true;
  return name === binding.dbName;
}

/**
 * Whether a caller may see or restore backup file `filename` of an
 * environment. Backups are named `<database>_<timestamp>.<ext>` and a shared
 * host has one backup directory for every environment on it, so a confined
 * caller (see allowedDatabaseName) only reaches the files of its own
 * databases.
 */
export function allowedBackupFilename(
  binding: DatabaseBinding,
  filename: string,
  canManageServers: boolean
): boolean {
  if (binding.dbKind !== "shared" || canManageServers) return true;
  return filename.startsWith(`${binding.dbName}_`);
}

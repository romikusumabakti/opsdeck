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

/**
 * The psql script that provisions `database` owned by `role` with the given
 * SCRAM verifier. Idempotent: a rerun only sets the new password. It refuses,
 * before changing anything, a database that exists with another owner and an
 * existing role that is privileged or owns another database, so a binding
 * can't take over a role or database it was not created for. CONNECT on the
 * database is revoked from PUBLIC, so the other roles on the host can't
 * connect to it. Run with `psql -X -q` as the superuser, on stdin.
 */
export function pgProvisionDatabaseSql(input: {
  database: string;
  role: string;
  verifier: string;
}): string {
  const db = pgQuoteId(input.database);
  const role = pgQuoteId(input.role);
  const dbLit = pgQuoteLiteral(input.database);
  const roleLit = pgQuoteLiteral(input.role);
  // The guard is a DO body in an ordinary string literal (not dollar
  // quoting), so the quoted names inside it can never end it early.
  const guard = [
    "DECLARE",
    "  current_owner name;",
    "  other name;",
    "BEGIN",
    `  SELECT pg_get_userbyid(datdba) INTO current_owner FROM pg_database WHERE datname = ${dbLit};`,
    `  IF current_owner IS NOT NULL AND current_owner <> ${roleLit} THEN`,
    `    RAISE EXCEPTION 'database % exists with owner %', ${dbLit}, current_owner;`,
    "  END IF;",
    `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleLit} AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) THEN`,
    `    RAISE EXCEPTION 'role % is privileged', ${roleLit};`,
    "  END IF;",
    `  SELECT d.datname INTO other FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE r.rolname = ${roleLit} AND d.datname <> ${dbLit} LIMIT 1;`,
    "  IF other IS NOT NULL THEN",
    `    RAISE EXCEPTION 'role % owns database %', ${roleLit}, other;`,
    "  END IF;",
    "END",
  ].join("\n");
  return [
    "\\set ON_ERROR_STOP on",
    `DO ${pgQuoteLiteral(guard)};`,
    // \gexec runs each returned row as a statement: none when the role or
    // database already exists. CREATE DATABASE can't run inside DO.
    `SELECT ${pgQuoteLiteral(`CREATE ROLE ${role} LOGIN;`)} WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleLit}) \\gexec`,
    `ALTER ROLE ${role} WITH LOGIN PASSWORD ${pgQuoteLiteral(input.verifier)};`,
    `SELECT ${pgQuoteLiteral(`CREATE DATABASE ${db} OWNER ${role};`)} WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${dbLit}) \\gexec`,
    `REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC;`,
    "",
  ].join("\n");
}

const PROVISION_TIMEOUT_MS = 60_000;

/**
 * Creates (or updates the password of) the role and database inside the
 * host's container. `server` carries the decrypted SSH password, as on
 * EnvironmentWithServers. The SQL, verifier included, goes on stdin; argv
 * holds only the container name. Errors never carry the password or the
 * verifier.
 */
export async function provisionSharedDatabase(
  host: {
    server: Pick<Server, "host" | "username" | "password">;
    containerName: string;
  },
  input: { database: string; role: string; password: string }
): Promise<void> {
  const verifier = scramSha256Verifier(input.password);
  const sql = pgProvisionDatabaseSql({
    database: input.database,
    role: input.role,
    verifier,
  });
  const command = `docker exec -i ${shq(host.containerName)} psql -U postgres -X -q -v ON_ERROR_STOP=1`;
  try {
    await executeRemoteCommand(
      {
        host: host.server.host,
        username: host.server.username,
        password: host.server.password,
      },
      command,
      {
        timeoutMs: PROVISION_TIMEOUT_MS,
        stdin: sql,
        secrets: [input.password, verifier],
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(message, [input.password, verifier]));
  }
}

/** The db binding fields confinement looks at. */
export type DatabaseBinding = {
  dbKind: "shared" | "container" | "external" | null;
  dbName: string;
};

/**
 * Whether a caller may act on database `name` of an environment. A shared
 * binding lives in a container other environments use too, so a caller
 * without org server:manage is confined to the binding's own database and
 * the ones named `<dbName>_…` (copies made from it). Every other binding,
 * and every caller with server:manage, is unrestricted.
 */
export function allowedDatabaseName(
  binding: DatabaseBinding,
  name: string,
  canManageServers: boolean
): boolean {
  if (binding.dbKind !== "shared" || canManageServers) return true;
  return name === binding.dbName || name.startsWith(`${binding.dbName}_`);
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

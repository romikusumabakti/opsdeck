import { databaseBindingPayload } from "@/lib/environment-database-binding";

// Engines the panel logs into over TCP, so they need a user + password. Postgres
// instead authenticates as its own OS user inside the container/unit.
const TCP_AUTH_DB_TYPES = new Set(["mssql", "mysql"]);

type ServiceType = "docker" | "systemd" | "kubernetes";
type DbType = "postgres" | "mssql" | "mysql";

type DbFields = {
  dbPassword: string;
  dbServerId: string;
  dbServiceType: ServiceType;
  dbServiceName: string;
  dbType: DbType;
  dbName: string;
  dbUser: string;
  dbBackupPath: string;
  dbKind: "shared" | "container" | "external" | "";
  databaseHostId: string;
  dbRole: string;
  dbPasswordVariable: string;
};

type FrontendFields = {
  frontendServerId: string;
  frontendServiceType: ServiceType;
  frontendServiceName: string;
};

export type EnvironmentSubmitValues = DbFields &
  FrontendFields & {
    hasDatabase: boolean;
    hasFrontend: boolean;
    kind: "qa" | "dev" | "release" | "sandbox" | "prod" | "";
    ownerId: string;
    url: string;
    backendMockTimeApiUrl: string;
    backendMockTimeApiKey: string;
  };

/**
 * The create/update payload of the environment form's infrastructure path.
 *
 * - A switched-off service sends only its flag; a switched-on one its fields.
 * - A shared database sends its host, names and password variable; the server
 *   derives server, container, engine and backup path from the host, so those
 *   and the admin password are left out. Container and external send just
 *   their kind (it clears a former shared host); the host, role and variable
 *   are omitted.
 * - On create the database password is persisted (null for postgres); on edit
 *   it is sent only when typed. The mock-time key follows the same rule.
 */
export function buildEnvironmentPayload<V extends EnvironmentSubmitValues>(
  values: V,
  modeType: "create" | "edit"
) {
  const {
    dbPassword,
    backendMockTimeApiKey,
    dbServerId,
    dbServiceType,
    dbServiceName,
    dbType,
    dbName,
    dbUser,
    dbBackupPath,
    dbKind,
    databaseHostId,
    dbRole,
    dbPasswordVariable,
    frontendServerId,
    frontendServiceType,
    frontendServiceName,
    kind,
    ownerId,
    url,
    backendMockTimeApiUrl,
    ...rest
  } = values;
  const sharedDb = values.hasDatabase && dbKind === "shared";
  const binding = databaseBindingPayload({
    dbKind,
    databaseHostId,
    dbRole,
    dbPasswordVariable,
  });
  const database = sharedDb
    ? { dbName, ...binding }
    : values.hasDatabase
      ? {
          ...binding,
          dbServerId,
          dbServiceType,
          dbServiceName,
          dbType,
          dbName,
          dbUser: dbUser.trim() ? dbUser.trim() : null,
          dbBackupPath,
        }
      : {};
  const frontend = values.hasFrontend
    ? { frontendServerId, frontendServiceType, frontendServiceName }
    : {};
  const base = {
    ...rest,
    ...database,
    ...frontend,
    backendMockTimeApiUrl: backendMockTimeApiUrl ? backendMockTimeApiUrl : null,
    // "" from the picker/input means "unset".
    kind: kind ? kind : null,
    ownerId: ownerId || null,
    url: url.trim() ? url.trim() : null,
  };
  const withPassword =
    !values.hasDatabase || sharedDb
      ? base
      : modeType === "create"
        ? {
            ...base,
            dbPassword: TCP_AUTH_DB_TYPES.has(dbType) ? dbPassword : null,
          }
        : dbPassword
          ? { ...base, dbPassword }
          : base;
  return modeType === "create"
    ? {
        ...withPassword,
        backendMockTimeApiKey: backendMockTimeApiKey || null,
      }
    : backendMockTimeApiKey
      ? { ...withPassword, backendMockTimeApiKey }
      : withPassword;
}

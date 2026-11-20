import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// getAssistantDbLogin against a real Menara database: a throwaway database in
// the local menara-postgres container (superuser password read from the
// container, never printed), migrated with `menara migrate`, dropped after.
//
//   ASSISTANT_DB_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/assistant-db-login.test.ts
const enabled = process.env.ASSISTANT_DB_SCRATCH === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = `assistant_db_login_${randomBytes(4).toString("hex")}`;
process.env.SECRETS_KEY ??= randomBytes(32).toString("base64");

const PROJECT = "00000000-0000-7000-8000-00000000e0a1";
const SERVER = "00000000-0000-7000-8000-00000000e0b1";
const ENV_MS = "00000000-0000-7000-8000-00000000e0e1";
const ENV_PG_SYSTEMD = "00000000-0000-7000-8000-00000000e0e2";
const ENV_PG_DOCKER = "00000000-0000-7000-8000-00000000e0e3";
const ENV_PG_BROKEN = "00000000-0000-7000-8000-00000000e0e4";
const SVC_PG_SYSTEMD = "00000000-0000-7000-8000-00000000e0f2";
// Fictional credentials.
const MSSQL_PW = "fictional-mssql-Pw-31";
const PG_PW = "fictional-pg-Pw-32";

describe.skipIf(!enabled)("getAssistantDbLogin", () => {
  let sql: ReturnType<typeof postgres>;
  let previousUrl: string | undefined;
  let getAssistantDbLogin: typeof import("@/lib/assistant-db/login")["getAssistantDbLogin"];

  const rootUrl = () => {
    const password = encodeURIComponent(
      execFileSync("podman", [
        "exec",
        CONTAINER,
        "printenv",
        "POSTGRES_PASSWORD",
      ])
        .toString()
        .trim()
    );
    return `postgres://postgres:${password}@127.0.0.1:5432`;
  };

  beforeAll(async () => {
    const base = rootUrl();
    const root = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
    await root.unsafe(`create database ${DB_NAME}`);
    await root.end();
    const url = `${base}/${DB_NAME}`;
    const result = spawnSync("bun", ["scripts/cli.ts", "migrate"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: url,
      },
    });
    if (result.status !== 0)
      throw new Error(`migrate failed: ${result.stderr}`);
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const { encryptSecret } = await import("@/lib/secrets");
    await sql`insert into projects (id, name, key) values (${PROJECT}, 'Kestrel', 'KES')`;
    await sql`insert into servers (id, name, host, username, password, auth) values
      (${SERVER}, 'Kestrel box', 'db.example.invalid', 'deploy', ${encryptSecret("fictional-ssh-Pw-33")}, 'password')`;
    await sql`insert into environments (id, project_id, name, slug) values
      (${ENV_MS}, ${PROJECT}, 'Ext SQL', 'sql'),
      (${ENV_PG_SYSTEMD}, ${PROJECT}, 'Systemd PG', 'pgs'),
      (${ENV_PG_DOCKER}, ${PROJECT}, 'Docker PG', 'pgd'),
      (${ENV_PG_BROKEN}, ${PROJECT}, 'Broken PG', 'pgb')`;
    await sql`insert into environment_services
      (environment_id, role, server_id, service_type, service_name, db_type,
       db_name, db_backup_path, db_kind, assistant_db_enabled,
       assistant_db_login, assistant_db_password) values
      (${ENV_MS}, 'db', ${SERVER}, 'systemd', 'mssql-server', 'mssql',
       'kestrel_sql', '/backups', 'external', true, 'menara_ro_sql',
       ${encryptSecret(MSSQL_PW)}),
      (${ENV_PG_DOCKER}, 'db', ${SERVER}, 'docker', 'kestrel-pg', 'postgres',
       'kestrel_pgd', '/backups', 'container', true, 'menara_ro_pgd', null),
      (${ENV_PG_BROKEN}, 'db', ${SERVER}, 'systemd', 'postgresql', 'postgres',
       'kestrel_pgb', '/backups', 'external', true, 'menara_ro_pgb',
       'enc:v1:bm90LWEtdmFsaWQtY2lwaGVydGV4dC1hdC1hbGw=')`;
    await sql`insert into environment_services
      (id, environment_id, role, server_id, service_type, service_name,
       db_type, db_name, db_backup_path, db_kind, assistant_db_enabled,
       assistant_db_login, assistant_db_password) values
      (${SVC_PG_SYSTEMD}, ${ENV_PG_SYSTEMD}, 'db', ${SERVER}, 'systemd',
       'postgresql', 'postgres', 'kestrel_pgs', '/backups', 'external', true,
       'menara_ro_pgs', ${encryptSecret(PG_PW)})`;
    ({ getAssistantDbLogin } = await import("@/lib/assistant-db/login"));
  });

  afterAll(async () => {
    await sql?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    const root = postgres(`${rootUrl()}/postgres`, {
      max: 1,
      onnotice: () => {},
    });
    await root.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await root.end();
  });

  it("returns an enabled external service's login", async () => {
    expect(await getAssistantDbLogin(ENV_MS)).toEqual({
      engine: "mssql",
      serviceId: expect.any(String),
      login: "menara_ro_sql",
      password: MSSQL_PW,
      database: "kestrel_sql",
    });
  });

  it("returns the password for systemd postgres, none for container postgres", async () => {
    expect(await getAssistantDbLogin(ENV_PG_SYSTEMD)).toEqual({
      engine: "postgres",
      serviceId: SVC_PG_SYSTEMD,
      login: "menara_ro_pgs",
      password: PG_PW,
      database: "kestrel_pgs",
    });
    expect(await getAssistantDbLogin(ENV_PG_DOCKER)).toEqual({
      engine: "postgres",
      serviceId: expect.any(String),
      login: "menara_ro_pgd",
      database: "kestrel_pgd",
    });
  });

  it("is null when a systemd postgres password can't be decrypted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getAssistantDbLogin(ENV_PG_BROKEN)).toBeNull();
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]?.[0])).not.toContain(
      "bm90LWEtdmFsaWQtY2lwaGVydGV4dC1hdC1hbGw"
    );
    error.mockRestore();
  });
});

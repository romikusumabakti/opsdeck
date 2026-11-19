import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Turning the Assistant's read-only database login on and off (Stage 9 spec
// F.1/F.2) against a real Panel database: a throwaway database in the local
// menara-postgres container (superuser password read from the container,
// never printed), migrated with `menara migrate` and dropped afterwards. The
// database servers are faked at the SSH session: every command is recorded
// and answered. Covers who may switch it (admin/infra only), the stored row
// and the encrypted password, that the password never reaches an API
// response, the activity log or a log line, idempotent enabling, disabling
// (the row goes off first, then the login is dropped), refusals for
// databases the Panel can't administer, the rebind guard, and
// getAssistantDbLogin.
//
//   ASSISTANT_DB_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/environment-assistant-db-scratch.test.ts
const enabled = process.env.ASSISTANT_DB_SCRATCH === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = `environment_assistant_db_${randomBytes(4).toString("hex")}`;
process.env.SECRETS_KEY ??= randomBytes(32).toString("base64");

const session = vi.hoisted(() => ({
  user: { id: "", role: "admin", name: "Admin" },
  signInMethod: "passkey",
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => {
  const current = async () => ({
    user: session.user,
    session: { signInMethod: session.signInMethod },
  });
  return { requireSession: current, getServerSession: current };
});
vi.mock("@/lib/queue", () => ({
  enqueue: vi.fn(),
  scheduleInstanceBackup: vi.fn(async () => {}),
  INSTANCE_BACKUP_MANUAL_JOB_ID: "instance-backup-manual",
}));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

type ExecCall = { command: string; stdin?: string };
const ssh = vi.hoisted(() => ({
  calls: [] as ExecCall[],
  results: [] as { code: number; stdout: string; stderr: string }[],
}));
vi.mock("@/lib/ssh-session", () => ({
  openSsh: async () => ({
    async execCommand(command: string, options?: { stdin?: string }) {
      ssh.calls.push({ command, stdin: options?.stdin });
      return ssh.results.shift() ?? { code: 0, stdout: "", stderr: "" };
    },
    dispose() {},
  }),
}));

const ADMIN = "00000000-0000-7000-8000-00000000d001";
const INFRA = "00000000-0000-7000-8000-00000000d002";
const ENGINEER = "00000000-0000-7000-8000-00000000d003";
const QA = "00000000-0000-7000-8000-00000000d004";
const PROJECT = "00000000-0000-7000-8000-00000000d0a1";
const SERVER = "00000000-0000-7000-8000-00000000d0b1";
const ENV_PG = "00000000-0000-7000-8000-00000000d0e1";
const ENV_MY = "00000000-0000-7000-8000-00000000d0e2";
const ENV_EXT = "00000000-0000-7000-8000-00000000d0e3";
const ENV_NODB = "00000000-0000-7000-8000-00000000d0e4";
const SVC_PG = "00000000-0000-7000-8000-00000000d0f1";
const SVC_MY = "00000000-0000-7000-8000-00000000d0f2";
// Fictional credentials.
const ADMIN_DB_PW = "fictional-root-Pw-81";
const SSH_PW = "fictional-ssh-Pw-82";

const as = (id: string, role: string, signInMethod = "passkey") => {
  session.user = { id, role, name: role };
  session.signInMethod = signInMethod;
};

describe.skipIf(!enabled)("assistant database access on Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let previousUrl: string | undefined;
  let app: typeof import("@/server/app")["app"];
  let svc: typeof import("@/server/services/environment-assistant-db");
  let getAssistantDbLogin: typeof import("@/lib/assistant-db/login")["getAssistantDbLogin"];
  let decryptSecret: typeof import("@/lib/secrets")["decryptSecret"];
  let logged: string[];

  const post = (environmentId: string, on: boolean) =>
    app.request(`/api/environments/${environmentId}/assistant-db-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: on }),
    });
  const row = async (id: string) => {
    const [r] = await sql<
      {
        assistant_db_enabled: boolean;
        assistant_db_login: string | null;
        assistant_db_password: string | null;
        assistant_db_enabled_at: Date | null;
        assistant_db_enabled_by: string | null;
      }[]
    >`select assistant_db_enabled, assistant_db_login, assistant_db_password,
        assistant_db_enabled_at, assistant_db_enabled_by
      from environment_services where id = ${id}`;
    return r;
  };
  const activity = () =>
    sql<{ entity_id: string; data: Record<string, string> }[]>`
      select entity_id, data from activity_log
      where action = 'environment.assistantDbAccess' order by created_at`;
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
    for (const [id, role] of [
      [ADMIN, "admin"],
      [INFRA, "infra"],
      [ENGINEER, "engineer"],
      [QA, "qa"],
    ] as const) {
      await sql`insert into users (id, name, email, role)
        values (${id}, ${role}, ${`${role}@example.invalid`}, ${role})`;
    }
    await sql`insert into projects (id, name, key) values (${PROJECT}, 'Kestrel', 'KES')`;
    await sql`insert into project_members (project_id, user_id) values
      (${PROJECT}, ${ENGINEER}), (${PROJECT}, ${QA})`;
    const { encryptSecret } = await import("@/lib/secrets");
    ({ decryptSecret } = await import("@/lib/secrets"));
    await sql`insert into servers (id, name, host, username, password, auth) values
      (${SERVER}, 'Kestrel box', 'db.example.invalid', 'deploy', ${encryptSecret(SSH_PW)}, 'password')`;
    await sql`insert into environments (id, project_id, name, slug) values
      (${ENV_PG}, ${PROJECT}, 'Kestrel QA', 'qa'),
      (${ENV_MY}, ${PROJECT}, 'Kestrel UAT', 'uat'),
      (${ENV_EXT}, ${PROJECT}, 'Kestrel Ext', 'ext'),
      (${ENV_NODB}, ${PROJECT}, 'Kestrel Bare', 'bare')`;
    await sql`insert into environment_services
      (id, environment_id, role, server_id, service_type, service_name,
       db_type, db_name, db_user, db_password, db_backup_path, db_kind) values
      (${SVC_PG}, ${ENV_PG}, 'db', ${SERVER}, 'docker', 'kestrel-qa-db',
       'postgres', 'kestrel_qa', null, null, '/backups', 'container'),
      (${SVC_MY}, ${ENV_MY}, 'db', ${SERVER}, 'docker', 'kestrel-uat-db',
       'mysql', 'kestrel_uat', null, ${encryptSecret(ADMIN_DB_PW)}, '/backups', null),
      (gen_random_uuid(), ${ENV_EXT}, 'db', ${SERVER}, 'systemd', 'postgresql',
       'postgres', 'kestrel_ext', null, null, '/backups', 'external')`;
    for (const env of [ENV_PG, ENV_MY, ENV_EXT, ENV_NODB]) {
      await sql`insert into environment_services
        (environment_id, role, server_id, service_type, service_name) values
        (${env}, 'backend', ${SERVER}, 'docker', ${`backend-${env.slice(-2)}`})`;
    }
    svc = await import("@/server/services/environment-assistant-db");
    ({ getAssistantDbLogin } = await import("@/lib/assistant-db/login"));
    ({ app } = await import("@/server/app"));
  });

  afterAll(async () => {
    await sql?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (!enabled) return;
    const root = postgres(`${rootUrl()}/postgres`, {
      max: 1,
      onnotice: () => {},
    });
    await root.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await root.end();
  });

  beforeEach(() => {
    ssh.calls = [];
    ssh.results = [];
    logged = [];
    for (const level of ["error", "warn", "log", "info"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => {
        logged.push(args.map(String).join(" "));
      });
    }
    as(ADMIN, "admin");
  });

  it("only admin and infra may switch it; engineer and QA get 403, a weak sign-in too", async () => {
    for (const [id, role] of [
      [ENGINEER, "engineer"],
      [QA, "qa"],
    ] as const) {
      as(id, role);
      expect((await post(ENV_PG, true)).status).toBe(403);
      expect((await post(ENV_PG, false)).status).toBe(403);
    }
    as(ADMIN, "admin", "password");
    expect((await post(ENV_PG, true)).status).toBe(403);
    expect(ssh.calls).toEqual([]);
    expect((await row(SVC_PG))?.assistant_db_enabled).toBe(false);
  });

  it("refuses an external database and an environment without one, before SSH", async () => {
    const external = await post(ENV_EXT, true);
    expect(external.status).toBe(409);
    expect(await external.json()).toMatchObject({
      code: "assistantDbUnavailable",
    });
    const bare = await post(ENV_NODB, true);
    expect(bare.status).toBe(409);
    expect(await bare.json()).toMatchObject({ code: "assistantDbNoDatabase" });
    expect(ssh.calls).toEqual([]);
  });

  it("a failed provisioning leaves it off and says why", async () => {
    ssh.results = [
      { code: 1, stdout: "", stderr: "ERROR:  could not connect" },
    ];
    const res = await post(ENV_PG, true);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: "assistantDbProvisionFailed",
    });
    expect(await row(SVC_PG)).toMatchObject({
      assistant_db_enabled: false,
      assistant_db_login: null,
    });
    expect(await activity()).toEqual([]);
  });

  it("enables postgres for an admin: role provisioned, row on, no password, activity", async () => {
    const res = await post(ENV_PG, true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      enabled: true,
      login: "menara_ro_kestrel_qa",
      enabledAt: expect.any(String),
    });
    expect(ssh.calls).toHaveLength(2);
    expect(ssh.calls[0]?.command).toContain("GRANT CONNECT ON DATABASE");
    expect(await row(SVC_PG)).toMatchObject({
      assistant_db_enabled: true,
      assistant_db_login: "menara_ro_kestrel_qa",
      assistant_db_password: null,
      assistant_db_enabled_by: ADMIN,
    });
    expect((await activity()).map((a) => [a.entity_id, a.data])).toEqual([
      [ENV_PG, { environment: "Kestrel · QA", enabled: "true" }],
    ]);
    expect(await getAssistantDbLogin(ENV_PG)).toEqual({
      engine: "postgres",
      serviceId: SVC_PG,
      login: "menara_ro_kestrel_qa",
      database: "kestrel_qa",
    });
  });

  it("enables mysql for infra: the generated password is stored encrypted and never sent back or logged", async () => {
    as(INFRA, "infra");
    const res = await post(ENV_MY, true);
    expect(res.status).toBe(200);
    const text = await res.text();
    const stored = await row(SVC_MY);
    expect(stored?.assistant_db_password).toMatch(/^enc:/);
    const password = decryptSecret(stored?.assistant_db_password as string);
    expect(password).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(ssh.calls[0]?.stdin).toContain(`IDENTIFIED BY '${password}'`);
    for (const call of ssh.calls) {
      expect(call.command).not.toContain(password);
      expect(call.command).not.toContain(ADMIN_DB_PW);
    }
    // Not in the toggle's answer, the environment the settings page reads,
    // the environment list, or the activity log.
    const page = await (
      await app.request(`/api/environments/get-environment-by-id?id=${ENV_MY}`)
    ).text();
    const list = await (
      await app.request("/api/environments/list-environments")
    ).text();
    const log = JSON.stringify(await activity());
    for (const out of [text, page, list, log, logged.join("\n")]) {
      expect(out).not.toContain(password);
      expect(out).not.toContain(stored?.assistant_db_password as string);
      expect(out).not.toContain("assistantDbPassword");
    }
    expect(page).toContain('"assistantDbEnabled":true');
    expect(await getAssistantDbLogin(ENV_MY)).toEqual({
      engine: "mysql",
      serviceId: SVC_MY,
      login: "menara_ro_kestrel_uat",
      password,
      database: "kestrel_uat",
    });
  });

  it("enabling again refreshes the login, keeps its password, records nothing new", async () => {
    const before = await row(SVC_MY);
    const password = decryptSecret(before?.assistant_db_password as string);
    const res = await post(ENV_MY, true);
    expect(res.status).toBe(200);
    expect(ssh.calls[0]?.stdin).toContain(`IDENTIFIED BY '${password}'`);
    const after = await row(SVC_MY);
    expect(decryptSecret(after?.assistant_db_password as string)).toBe(
      password
    );
    expect(after?.assistant_db_enabled_at).toEqual(
      before?.assistant_db_enabled_at
    );
    expect(after?.assistant_db_enabled_by).toBe(INFRA);
    expect(
      (await activity()).filter((a) => a.entity_id === ENV_MY)
    ).toHaveLength(1);
  });

  it("refuses moving or removing a database the Assistant has a login on", async () => {
    const update = (data: Record<string, unknown>) =>
      app.request("/api/environments/update-environment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ENV_PG, data }),
      });
    for (const data of [{ dbName: "kestrel_qa2" }, { hasDatabase: false }]) {
      const res = await update(data);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: "assistantDbAccessBlocksRebind",
      });
    }
    // Unrelated edits still save.
    expect((await update({ name: "Kestrel QA" })).status).toBe(200);
  });

  it("a drop that fails turns access off anyway and keeps the login to retry", async () => {
    ssh.results = [
      { code: 1, stdout: "", stderr: `access denied ${ADMIN_DB_PW}` },
    ];
    const res = await post(ENV_MY, false);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("assistantDbDropFailed");
    expect(body).not.toContain(ADMIN_DB_PW);
    expect(logged.join("\n")).not.toContain(ADMIN_DB_PW);
    expect(await row(SVC_MY)).toMatchObject({
      assistant_db_enabled: false,
      assistant_db_login: "menara_ro_kestrel_uat",
    });
    expect(await getAssistantDbLogin(ENV_MY)).toBeNull();
    // The retry drops it.
    ssh.calls = [];
    const retry = await post(ENV_MY, false);
    expect(retry.status).toBe(200);
    expect(ssh.calls[0]?.stdin).toBe(
      `${ADMIN_DB_PW}\nDROP USER IF EXISTS 'menara_ro_kestrel_uat'@'127.0.0.1';\n`
    );
    expect(await row(SVC_MY)).toMatchObject({
      assistant_db_enabled: false,
      assistant_db_login: null,
      assistant_db_password: null,
      assistant_db_enabled_at: null,
      assistant_db_enabled_by: null,
    });
    // One "off" entry for the two calls.
    expect(
      (await activity())
        .filter((a) => a.entity_id === ENV_MY)
        .map((a) => a.data.enabled)
    ).toEqual(["true", "false"]);
  });

  it("disable drops the postgres role and clears the row; again is a no-op", async () => {
    const res = await post(ENV_PG, false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      login: null,
      enabledAt: null,
    });
    expect(ssh.calls).toHaveLength(1);
    expect(ssh.calls[0]?.command).toContain("DROP ROLE");
    expect(await row(SVC_PG)).toMatchObject({
      assistant_db_enabled: false,
      assistant_db_login: null,
    });
    expect(await getAssistantDbLogin(ENV_PG)).toBeNull();
    ssh.calls = [];
    expect((await post(ENV_PG, false)).status).toBe(200);
    expect(ssh.calls).toEqual([]);
    expect(
      (await activity())
        .filter((a) => a.entity_id === ENV_PG)
        .map((a) => a.data.enabled)
    ).toEqual(["true", "false"]);
    // With the login gone the database may move again.
    const moved = await app.request("/api/environments/update-environment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: ENV_PG, data: { dbName: "kestrel_qa2" } }),
    });
    expect(moved.status).toBe(200);
    expect(svc).toBeDefined();
  });
});

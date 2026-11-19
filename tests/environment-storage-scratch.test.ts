import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { HTTPException } from "hono/http-exception";
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

// Storage per environment against a real Postgres: a throwaway database in the
// local menara-postgres container (superuser password read from the
// container, never printed), migrated with `menara migrate` and dropped
// afterwards. Covers who may list, add, edit, delete and test an
// environment's connections (view = sees the environment, manage = edits its
// settings), that an environment the caller can't see answers 404 however the
// ids are combined, that secrets never come back, the admin assignment of
// unassigned connections, the activity rows, and the explorer's access rule
// for a connection (its environment's rights; unassigned = admin only).
//
//   ENVIRONMENT_STORAGE_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/environment-storage-scratch.test.ts
const enabled = process.env.ENVIRONMENT_STORAGE_SCRATCH === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = `environment_storage_service_${randomBytes(4).toString("hex")}`;
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
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

// The S3 side: no network. createS3Backend records the connection it was
// opened with (resolveBackend's decrypted row); the probe records its input.
const s3 = vi.hoisted(() => ({
  opened: [] as Record<string, unknown>[],
  probes: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/explorer/s3", () => ({
  createS3Backend: (conn: Record<string, unknown>) => {
    s3.opened.push(conn);
    return {
      list: async () => [],
      remove: async () => {},
      writeStream: async () => {},
      readStream: async () => {
        const { Readable } = await import("node:stream");
        return Readable.from([]);
      },
    };
  },
  testS3Connection: async (probe: Record<string, unknown>) => {
    s3.probes.push(probe);
    return { ok: true };
  },
}));

const ADMIN = "00000000-0000-7000-8000-00000000e001";
const INFRA = "00000000-0000-7000-8000-00000000e002";
const ENGINEER = "00000000-0000-7000-8000-00000000e003";
const QA = "00000000-0000-7000-8000-00000000e004";
const STAFF = "00000000-0000-7000-8000-00000000e005";
const PROJECT_A = "00000000-0000-7000-8000-00000000a001";
const PROJECT_B = "00000000-0000-7000-8000-00000000b001";
const ENV_A = "00000000-0000-7000-8000-00000000a0e1";
const ENV_A2 = "00000000-0000-7000-8000-00000000a0e2";
const ENV_B = "00000000-0000-7000-8000-00000000b0e1";
const CONN_A = "00000000-0000-7000-8000-00000000a0c1";
const CONN_B = "00000000-0000-7000-8000-00000000b0c1";
const CONN_FREE = "00000000-0000-7000-8000-0000000000c1";
const CONN_BACKUP = "00000000-0000-7000-8000-0000000000c2";
const MISSING = "00000000-0000-7000-8000-0000000000ff";
// Fictional credentials; the secrets are what must never come back.
const SECRET_A = "fictional-secret-a-7f3c";
const SECRET_B = "fictional-secret-b-91de";

const as = (id: string, role: string, signInMethod = "passkey") => {
  session.user = { id, role, name: role };
  session.signInMethod = signInMethod;
};

async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    if (error instanceof HTTPException) {
      return { status: error.status, code: (error as { code?: string }).code };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

const input = (over: Record<string, unknown> = {}) => ({
  name: "Uploads",
  endpoint: "https://objects.example.test",
  region: "us-east-1",
  bucket: "fictional-app-bucket",
  accessKeyId: "AKFICTIONALNEW",
  secretKey: "fictional-secret-new-55aa",
  forcePathStyle: true,
  keyPrefix: null,
  ...over,
});

describe.skipIf(!enabled)("environment storage on Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let previousUrl: string | undefined;
  let svc: typeof import("@/server/services/environment-storage");
  let admin: typeof import("@/server/services/s3-connections");
  let explorer: typeof import("@/server/services/explorer");
  let app: typeof import("@/server/app")["app"];
  let decryptSecret: typeof import("@/lib/secrets")["decryptSecret"];
  let encryptSecret: typeof import("@/lib/secrets")["encryptSecret"];

  const activity = (action: string) =>
    sql<{ entity_id: string; data: Record<string, string> }[]>`
      select entity_id, data from activity_log where action = ${action}
      order by created_at`;
  const connection = async (id: string) => {
    const [row] = await sql<
      {
        name: string;
        environment_id: string | null;
        key_prefix: string | null;
        secret_key: string;
      }[]
    >`select name, environment_id, key_prefix, secret_key
      from s3_connections where id = ${id}`;
    return row;
  };

  beforeAll(async () => {
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
    const base = `postgres://postgres:${password}@127.0.0.1:5432`;
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
      [STAFF, "staff"],
    ] as const) {
      await sql`insert into users (id, name, email, role)
        values (${id}, ${role}, ${`${role}@example.com`}, ${role})`;
    }
    await sql`insert into projects (id, name, key) values
      (${PROJECT_A}, 'Kestrel', 'KES'), (${PROJECT_B}, 'Heron', 'HER')`;
    // The engineer and the QA work on Kestrel only; Heron is invisible.
    await sql`insert into project_members (project_id, user_id) values
      (${PROJECT_A}, ${ENGINEER}), (${PROJECT_A}, ${QA}), (${PROJECT_B}, ${STAFF})`;
    await sql`insert into environments (id, project_id, name, slug) values
      (${ENV_A}, ${PROJECT_A}, 'Kestrel QA', 'qa'),
      (${ENV_A2}, ${PROJECT_A}, 'Kestrel UAT', 'uat'),
      (${ENV_B}, ${PROJECT_B}, 'Heron QA', 'qa')`;
    ({ encryptSecret, decryptSecret } = await import("@/lib/secrets"));
    svc = await import("@/server/services/environment-storage");
    admin = await import("@/server/services/s3-connections");
    explorer = await import("@/server/services/explorer");
    ({ app } = await import("@/server/app"));
  });

  afterAll(async () => {
    await sql?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (!enabled) return;
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
    const root = postgres(
      `postgres://postgres:${password}@127.0.0.1:5432/postgres`,
      { max: 1, onnotice: () => {} }
    );
    await root.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await root.end();
  });

  beforeEach(async () => {
    await sql`delete from activity_log`;
    await sql`update instance_settings set backup_destination_id = null`;
    await sql`delete from s3_connections`;
    const row = (
      id: string,
      name: string,
      environmentId: string | null,
      keyPrefix: string | null,
      secret: string
    ) => ({
      id,
      name,
      environment_id: environmentId,
      endpoint: "https://objects.example.test",
      region: "us-east-1",
      bucket: "fictional-app-bucket",
      key_prefix: keyPrefix,
      access_key_id: `AK${name.replace(/\W/g, "").toUpperCase()}`,
      secret_key: encryptSecret(secret),
      force_path_style: true,
    });
    await sql`insert into s3_connections ${sql([
      row(CONN_A, "Kestrel files", ENV_A, "team-a/", SECRET_A),
      row(CONN_B, "Heron files", ENV_B, "team-b/", SECRET_B),
      row(CONN_FREE, "Old bucket", null, null, "fictional-secret-free"),
      row(CONN_BACKUP, "Panel backups", null, null, "fictional-secret-backup"),
    ])}`;
    await sql`insert into instance_settings (id, backup_destination_id)
      values (1, ${CONN_BACKUP})
      on conflict (id) do update set backup_destination_id = ${CONN_BACKUP}`;
    s3.opened = [];
    s3.probes = [];
    as(ENGINEER, "engineer");
  });

  describe("viewing an environment's storage", () => {
    it("lists the environment's connections without secrets", async () => {
      for (const [id, role] of [
        [ENGINEER, "engineer"],
        [QA, "qa"],
      ] as const) {
        as(id, role);
        const rows = await svc.listEnvironmentStorage(ENV_A);
        expect(rows.map((r) => r.id)).toEqual([CONN_A]);
        expect(rows[0]).toMatchObject({
          name: "Kestrel files",
          environmentId: ENV_A,
          keyPrefix: "team-a/",
          hasSecret: true,
          isBackupDestination: false,
        });
        expect(rows[0]).not.toHaveProperty("secretKey");
        expect(JSON.stringify(rows)).not.toContain(SECRET_A);
        expect(JSON.stringify(rows)).not.toContain("enc:v1:");
      }
      // A sibling environment of the same project has none of its own.
      expect(await svc.listEnvironmentStorage(ENV_A2)).toEqual([]);
    });

    it("answers 404 for an environment the caller can't see", async () => {
      expect(await refusal(svc.listEnvironmentStorage(ENV_B))).toMatchObject({
        status: 404,
      });
      expect(
        await refusal(svc.getEnvironmentStorage(ENV_B, CONN_B))
      ).toMatchObject({ status: 404 });
      expect(await refusal(svc.listEnvironmentStorage(MISSING))).toMatchObject({
        status: 404,
      });
      // staff is a member of Heron but sees no project at all.
      as(STAFF, "staff");
      expect(await refusal(svc.listEnvironmentStorage(ENV_B))).toMatchObject({
        status: 404,
      });
    });

    it("answers 404 for a connection of another environment under a visible one", async () => {
      expect(
        await refusal(svc.getEnvironmentStorage(ENV_A, CONN_B))
      ).toMatchObject({ status: 404 });
      expect(
        await refusal(svc.getEnvironmentStorage(ENV_A2, CONN_A))
      ).toMatchObject({ status: 404 });
      expect(
        await refusal(svc.getEnvironmentStorage(ENV_A, CONN_FREE))
      ).toMatchObject({ status: 404 });
      const got = await svc.getEnvironmentStorage(ENV_A, CONN_A);
      expect(got.id).toBe(CONN_A);
      expect(got).not.toHaveProperty("secretKey");
    });

    it("serves the list over the API with the same answers", async () => {
      const ok = await app.request(`/api/environments/${ENV_A}/storage`);
      expect(ok.status).toBe(200);
      const body = await ok.text();
      expect(body).toContain(CONN_A);
      expect(body).not.toContain(SECRET_A);
      expect(body).not.toContain("secretKey");
      const hidden = await app.request(`/api/environments/${ENV_B}/storage`);
      expect(hidden.status).toBe(404);
      const crossed = await app.request(
        `/api/environments/${ENV_A}/storage/${CONN_B}`
      );
      expect(crossed.status).toBe(404);
    });
  });

  describe("managing an environment's storage", () => {
    it("never moves a connection to another environment through an edit", async () => {
      const res = await app.request(
        `/api/environments/${ENV_A}/storage/${CONN_A}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Moved?", environmentId: ENV_A2 }),
        }
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(SECRET_A);
      expect(body).not.toContain("secretKey");
      expect(await connection(CONN_A)).toMatchObject({
        name: "Moved?",
        environment_id: ENV_A,
      });
      const created = await app.request(`/api/environments/${ENV_A}/storage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input(), environmentId: ENV_B }),
      });
      expect(created.status).toBe(200);
      const { id } = (await created.json()) as { id: string };
      expect((await connection(id))?.environment_id).toBe(ENV_A);
    });

    it("creates a connection with a normalised prefix and an encrypted secret", async () => {
      const created = await svc.createEnvironmentStorage(
        ENV_A,
        input({ keyPrefix: "  /uploads/2026 " })
      );
      expect(created).toMatchObject({
        name: "Uploads",
        environmentId: ENV_A,
        keyPrefix: "uploads/2026/",
        hasSecret: true,
      });
      expect(created).not.toHaveProperty("secretKey");
      expect(JSON.stringify(created)).not.toContain("fictional-secret-new");
      const stored = await connection(created.id);
      expect(stored?.secret_key.startsWith("enc:v1:")).toBe(true);
      expect(decryptSecret(stored?.secret_key ?? "")).toBe(
        "fictional-secret-new-55aa"
      );
      const rows = await activity("storage.created");
      expect(rows).toEqual([
        {
          entity_id: created.id,
          data: { name: "Uploads", environment: "Kestrel QA" },
        },
      ]);
    });

    it.each([
      "../team-b",
      "team-a/../../",
      "a//b",
      "a\\b",
      "%2e%2e/",
      "a%2Fb",
      "．．",
    ])("refuses the prefix %j with a coded 400", async (keyPrefix) => {
      expect(
        await refusal(svc.createEnvironmentStorage(ENV_A, input({ keyPrefix })))
      ).toEqual({ status: 400, code: "s3KeyPrefixInvalid" });
      expect(
        await refusal(
          svc.updateEnvironmentStorage(ENV_A, CONN_A, { keyPrefix })
        )
      ).toEqual({ status: 400, code: "s3KeyPrefixInvalid" });
      expect((await connection(CONN_A))?.key_prefix).toBe("team-a/");
      const [{ n } = { n: -1 }] = await sql<{ n: number }[]>`
        select count(*)::int as n from s3_connections`;
      expect(n).toBe(4);
    });

    it("updates a connection, keeping the stored secret when none is sent", async () => {
      const updated = await svc.updateEnvironmentStorage(ENV_A, CONN_A, {
        name: "Kestrel uploads",
        keyPrefix: "",
      });
      expect(updated).toMatchObject({
        name: "Kestrel uploads",
        keyPrefix: null,
      });
      expect(updated).not.toHaveProperty("secretKey");
      const stored = await connection(CONN_A);
      expect(decryptSecret(stored?.secret_key ?? "")).toBe(SECRET_A);
      expect(stored?.environment_id).toBe(ENV_A);
      await svc.updateEnvironmentStorage(ENV_A, CONN_A, {
        secretKey: "fictional-secret-rotated",
      });
      const rotated = await connection(CONN_A);
      expect(rotated?.secret_key.startsWith("enc:v1:")).toBe(true);
      expect(decryptSecret(rotated?.secret_key ?? "")).toBe(
        "fictional-secret-rotated"
      );
      const rows = await activity("storage.updated");
      expect(rows.map((r) => r.data)).toEqual([
        { name: "Kestrel uploads", environment: "Kestrel QA" },
        { name: "Kestrel uploads", environment: "Kestrel QA" },
      ]);
      expect(JSON.stringify(rows)).not.toContain("fictional-secret");
    });

    it("deletes a connection of the environment", async () => {
      await svc.deleteEnvironmentStorage(ENV_A, CONN_A);
      expect(await connection(CONN_A)).toBeUndefined();
      expect(await activity("storage.deleted")).toEqual([
        {
          entity_id: CONN_A,
          data: { name: "Kestrel files", environment: "Kestrel QA" },
        },
      ]);
    });

    it("refuses QA (view only) with a 403", async () => {
      as(QA, "qa");
      expect(
        await refusal(svc.createEnvironmentStorage(ENV_A, input()))
      ).toMatchObject({ status: 403 });
      expect(
        await refusal(
          svc.updateEnvironmentStorage(ENV_A, CONN_A, { name: "x" })
        )
      ).toMatchObject({ status: 403 });
      expect(
        await refusal(svc.deleteEnvironmentStorage(ENV_A, CONN_A))
      ).toMatchObject({ status: 403 });
      expect(
        await refusal(
          svc.testEnvironmentStorage(ENV_A, {
            ...input(),
            secretKey: undefined,
            connectionId: CONN_A,
          })
        )
      ).toMatchObject({ status: 403 });
      expect((await connection(CONN_A))?.name).toBe("Kestrel files");
    });

    it("refuses a weak sign-in for every change", async () => {
      as(ENGINEER, "engineer", "password");
      expect(
        await refusal(svc.createEnvironmentStorage(ENV_A, input()))
      ).toMatchObject({ status: 403, code: "strong_sign_in_required" });
      expect(
        await refusal(svc.deleteEnvironmentStorage(ENV_A, CONN_A))
      ).toMatchObject({ status: 403, code: "strong_sign_in_required" });
      // Reading is fine.
      expect(await svc.listEnvironmentStorage(ENV_A)).toHaveLength(1);
    });

    it("answers 404 for every change aimed at an invisible environment or a foreign connection", async () => {
      expect(
        await refusal(svc.createEnvironmentStorage(ENV_B, input()))
      ).toMatchObject({ status: 404 });
      for (const [env, conn] of [
        [ENV_B, CONN_B],
        [ENV_A, CONN_B],
        [ENV_A2, CONN_A],
        [ENV_A, CONN_FREE],
        [ENV_A, CONN_BACKUP],
        [ENV_A, MISSING],
      ] as const) {
        expect(
          await refusal(
            svc.updateEnvironmentStorage(env, conn, { name: "Taken" })
          )
        ).toMatchObject({ status: 404 });
        expect(
          await refusal(svc.deleteEnvironmentStorage(env, conn))
        ).toMatchObject({ status: 404 });
        expect(
          await refusal(
            svc.testEnvironmentStorage(env, {
              ...input(),
              secretKey: undefined,
              connectionId: conn,
            })
          )
        ).toMatchObject({ status: 404 });
      }
      expect((await connection(CONN_B))?.name).toBe("Heron files");
      expect((await connection(CONN_FREE))?.name).toBe("Old bucket");
      expect(s3.probes).toEqual([]);
      expect(await activity("storage.updated")).toEqual([]);
      expect(await activity("storage.deleted")).toEqual([]);
    });

    it("tests a saved connection with its stored secret and the prefix", async () => {
      const result = await svc.testEnvironmentStorage(ENV_A, {
        ...input({ keyPrefix: "team-a" }),
        secretKey: undefined,
        connectionId: CONN_A,
      });
      expect(result).toEqual({ ok: true });
      expect(s3.probes).toEqual([
        expect.objectContaining({
          secretKey: SECRET_A,
          keyPrefix: "team-a/",
          bucket: "fictional-app-bucket",
        }),
      ]);
      expect(
        await refusal(
          svc.testEnvironmentStorage(ENV_A, {
            ...input({ keyPrefix: "../x" }),
            connectionId: CONN_A,
          })
        )
      ).toEqual({ status: 400, code: "s3KeyPrefixInvalid" });
    });
  });

  describe("unassigned connections (admin)", () => {
    it("lists only unassigned connections, for admins", async () => {
      as(ADMIN, "admin");
      const rows = await admin.listUnassignedS3Connections();
      expect(rows.map((r) => r.id).sort()).toEqual(
        [CONN_FREE, CONN_BACKUP].sort()
      );
      expect(JSON.stringify(rows)).not.toContain("fictional-secret");
      for (const [id, role] of [
        [ENGINEER, "engineer"],
        [QA, "qa"],
      ] as const) {
        as(id, role);
        expect(
          await refusal(admin.listUnassignedS3Connections())
        ).toMatchObject({ status: 403 });
      }
    });

    it("assigns a connection to an existing environment", async () => {
      as(ADMIN, "admin");
      const assigned = await admin.assignS3Connection(CONN_FREE, ENV_B);
      expect(assigned).toMatchObject({ id: CONN_FREE, environmentId: ENV_B });
      expect(assigned).not.toHaveProperty("secretKey");
      expect((await connection(CONN_FREE))?.environment_id).toBe(ENV_B);
      expect(await activity("storage.assigned")).toEqual([
        {
          entity_id: CONN_FREE,
          data: { name: "Old bucket", environment: "Heron QA" },
        },
      ]);
      expect(
        await refusal(admin.assignS3Connection(CONN_A, MISSING))
      ).toMatchObject({ status: 404 });
      expect(
        await refusal(admin.assignS3Connection(MISSING, ENV_A))
      ).toMatchObject({ status: 404 });
      expect((await connection(CONN_A))?.environment_id).toBe(ENV_A);
    });

    it("never assigns the instance backup destination", async () => {
      as(ADMIN, "admin");
      expect(
        await refusal(admin.assignS3Connection(CONN_BACKUP, ENV_A))
      ).toEqual({ status: 409, code: "s3BackupDestinationNotAssignable" });
      expect((await connection(CONN_BACKUP))?.environment_id).toBeNull();
    });

    it("refuses assignment to non-admins", async () => {
      as(ENGINEER, "engineer");
      expect(
        await refusal(admin.assignS3Connection(CONN_FREE, ENV_A))
      ).toMatchObject({ status: 403 });
      expect((await connection(CONN_FREE))?.environment_id).toBeNull();
    });

    it("deletes an unassigned connection, and only an unassigned one", async () => {
      as(ADMIN, "admin");
      await admin.deleteUnassignedS3Connection(CONN_FREE);
      expect(await connection(CONN_FREE)).toBeUndefined();
      expect(await activity("storage.deleted")).toEqual([
        { entity_id: CONN_FREE, data: { name: "Old bucket", environment: "" } },
      ]);
      expect(
        await refusal(admin.deleteUnassignedS3Connection(CONN_A))
      ).toMatchObject({ status: 404 });
      expect(await connection(CONN_A)).toBeDefined();
      as(ENGINEER, "engineer");
      expect(
        await refusal(admin.deleteUnassignedS3Connection(CONN_BACKUP))
      ).toMatchObject({ status: 403 });
    });

    it("keeps the global list for org storage readers only", async () => {
      as(ADMIN, "admin");
      expect((await admin.getS3Connections()).map((r) => r.id).sort()).toEqual(
        [CONN_A, CONN_B, CONN_FREE, CONN_BACKUP].sort()
      );
      // The engineer grant no longer reaches the global list: it would show
      // the connections of projects the engineer can't see.
      as(ENGINEER, "engineer");
      expect(await refusal(admin.getS3Connections())).toMatchObject({
        status: 403,
      });
      expect(await refusal(admin.getS3Connection(CONN_B))).toMatchObject({
        status: 403,
      });
    });
  });

  describe("the explorer on an environment's connection", () => {
    const src = (connectionId: string) => ({ kind: "s3", connectionId });

    it("browses with the environment's view right, confined to the prefix", async () => {
      as(QA, "qa");
      expect(await explorer.listEntries(src(CONN_A), "")).toEqual({
        success: true,
        data: [],
      });
      expect(s3.opened).toEqual([
        expect.objectContaining({
          bucket: "fictional-app-bucket",
          keyPrefix: "team-a/",
          secretKey: SECRET_A,
        }),
      ]);
    });

    it("changes files only with the environment's manage right", async () => {
      as(QA, "qa");
      expect(
        await refusal(explorer.deleteEntry(src(CONN_A), "a.txt"))
      ).toMatchObject({ status: 403 });
      as(ENGINEER, "engineer");
      expect(await explorer.deleteEntry(src(CONN_A), "a.txt")).toMatchObject({
        success: true,
      });
    });

    it("answers 404 for a connection of an environment the caller can't see", async () => {
      for (const [id, role] of [
        [ENGINEER, "engineer"],
        [QA, "qa"],
      ] as const) {
        as(id, role);
        expect(
          await refusal(explorer.listEntries(src(CONN_B), ""))
        ).toMatchObject({ status: 404 });
        expect(
          await refusal(explorer.deleteEntry(src(CONN_B), "a.txt"))
        ).toMatchObject({ status: 404 });
        expect(
          await refusal(explorer.getDownloadTarget(src(CONN_B), "a.txt"))
        ).toMatchObject({ status: 404 });
        expect(
          await refusal(explorer.listEntries(src(MISSING), ""))
        ).toMatchObject({ status: 404 });
      }
      const download = await app.request(
        `/api/explorer/download?source=${encodeURIComponent(
          JSON.stringify(src(CONN_B))
        )}&path=a.txt`
      );
      expect(download.status).toBe(404);
      const archive = await app.request(
        `/api/explorer/archive?source=${encodeURIComponent(
          JSON.stringify(src(CONN_B))
        )}`
      );
      expect(archive.status).toBe(404);
      const form = new FormData();
      form.set("file", new File(["x"], "a.txt"));
      form.set("source", JSON.stringify(src(CONN_B)));
      form.set("path", "");
      const upload = await app.request("/api/explorer/upload", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
        body: form,
      });
      expect(upload.status).toBe(404);
      expect(s3.opened).toEqual([]);
    });

    it("refuses a QA upload into a visible environment's bucket", async () => {
      as(QA, "qa");
      const form = new FormData();
      form.set("file", new File(["x"], "a.txt"));
      form.set("source", JSON.stringify(src(CONN_A)));
      form.set("path", "");
      const upload = await app.request("/api/explorer/upload", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
        body: form,
      });
      expect(upload.status).toBe(403);
      expect(s3.opened).toEqual([]);
    });

    it("keeps unassigned connections for admins and infra", async () => {
      as(ENGINEER, "engineer");
      expect(
        await refusal(explorer.listEntries(src(CONN_FREE), ""))
      ).toMatchObject({ status: 404 });
      as(INFRA, "infra");
      expect(await explorer.listEntries(src(CONN_FREE), "")).toMatchObject({
        success: true,
      });
      as(ADMIN, "admin");
      expect(await explorer.listEntries(src(CONN_BACKUP), "")).toMatchObject({
        success: true,
      });
    });

    it("needs a strong sign-in to browse", async () => {
      as(ENGINEER, "engineer", "password");
      expect(
        await refusal(explorer.listEntries(src(CONN_A), ""))
      ).toMatchObject({ status: 403, code: "strong_sign_in_required" });
      expect(s3.opened).toEqual([]);
    });
  });
});

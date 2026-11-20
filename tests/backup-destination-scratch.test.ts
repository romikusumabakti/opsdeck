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

// The instance backup destination against a real Postgres (a throwaway
// database in the local menara-postgres container, migrated and dropped):
// its own credentials in instance_settings.backup_s3_* (read without the
// secret, saved encrypted, a stored secret only reused for the stored
// location, cleared back to local-only, probed), the activity row, what
// instance backups and environment archives load from it, and the guards
// around it: never browsable from an environment (also through a connection
// pointing at the same bucket and prefix), the legacy backup_destination_id
// connection still restricted, and connections that old archives or the
// legacy setting still need never deleted.
//
//   BACKUP_DESTINATION_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/backup-destination-scratch.test.ts
const enabled = process.env.BACKUP_DESTINATION_SCRATCH === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = `backup_destination_${randomBytes(4).toString("hex")}`;
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

// No network: the probe records its input, the explorer backend what it
// was opened with.
const s3 = vi.hoisted(() => ({
  opened: [] as Record<string, unknown>[],
  probes: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/explorer/s3", () => ({
  createS3Backend: (conn: Record<string, unknown>) => {
    s3.opened.push(conn);
    return { list: async () => [] };
  },
  testS3Connection: async (probe: Record<string, unknown>) => {
    s3.probes.push(probe);
    return { ok: true };
  },
}));

const ADMIN = "00000000-0000-7000-8000-00000000d001";
const INFRA = "00000000-0000-7000-8000-00000000d002";
const ENGINEER = "00000000-0000-7000-8000-00000000d003";
const PROJECT = "00000000-0000-7000-8000-00000000d0a1";
const ENV = "00000000-0000-7000-8000-00000000d0e1";
const CONN_LEGACY = "00000000-0000-7000-8000-00000000d0c1";
const CONN_FREE = "00000000-0000-7000-8000-00000000d0c2";
const CONN_SAME = "00000000-0000-7000-8000-00000000d0c3";
const CONN_OTHER = "00000000-0000-7000-8000-00000000d0c4";
// Fictional credentials; the secrets are what must never come back.
const SECRET = "fictional-menara-secret-3b9e";
const LEGACY_SECRET = "fictional-legacy-secret-c01d";
const ENDPOINT = "https://objects.example.test";
const BUCKET = "fictional-menara-backups";

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

const destination = (over: Record<string, unknown> = {}) => ({
  endpoint: ENDPOINT,
  region: "auto",
  bucket: BUCKET,
  accessKeyId: "AKFICTIONALMENARA",
  secretKey: SECRET,
  forcePathStyle: true,
  keyPrefix: "acme/",
  ...over,
});

describe.skipIf(!enabled)("the backup destination on Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let previousUrl: string | undefined;
  let svc: typeof import("@/server/services/backup-destination");
  let backups: typeof import("@/server/services/instance-backups");
  let admin: typeof import("@/server/services/s3-connections");
  let storage: typeof import("@/server/services/environment-storage");
  let explorer: typeof import("@/server/services/explorer");
  let loadBackupDestination: typeof import("@/lib/instance-backup/destination")["loadBackupDestination"];
  let app: typeof import("@/server/app")["app"];
  let decryptSecret: typeof import("@/lib/secrets")["decryptSecret"];
  let encryptSecret: typeof import("@/lib/secrets")["encryptSecret"];

  const settingsRow = async () => {
    const [row] = await sql<Record<string, unknown>[]>`
      select backup_destination_id, backup_s3_endpoint, backup_s3_region,
        backup_s3_bucket, backup_s3_access_key_id, backup_s3_secret_key,
        backup_s3_force_path_style, backup_s3_key_prefix
      from instance_settings where id = 1`;
    return row ?? {};
  };
  const activity = () =>
    sql<{ actor_id: string; data: Record<string, string> }[]>`
      select actor_id, data from activity_log
      where action = 'instance.backupDestinationChanged'
      order by created_at`;

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
    ] as const) {
      await sql`insert into users (id, name, email, role)
        values (${id}, ${role}, ${`${role}@example.com`}, ${role})`;
    }
    await sql`insert into projects (id, name, key) values
      (${PROJECT}, 'Kestrel', 'KES')`;
    await sql`insert into project_members (project_id, user_id) values
      (${PROJECT}, ${ENGINEER})`;
    await sql`insert into environments (id, project_id, name, slug) values
      (${ENV}, ${PROJECT}, 'Kestrel QA', 'qa')`;
    ({ encryptSecret, decryptSecret } = await import("@/lib/secrets"));
    svc = await import("@/server/services/backup-destination");
    backups = await import("@/server/services/instance-backups");
    admin = await import("@/server/services/s3-connections");
    storage = await import("@/server/services/environment-storage");
    explorer = await import("@/server/services/explorer");
    ({ loadBackupDestination } = await import(
      "@/lib/instance-backup/destination"
    ));
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
    await sql`delete from environment_archives`;
    await sql`update instance_settings set backup_destination_id = null,
      backup_s3_endpoint = null, backup_s3_region = null,
      backup_s3_bucket = null, backup_s3_access_key_id = null,
      backup_s3_secret_key = null, backup_s3_force_path_style = true,
      backup_s3_key_prefix = null`;
    await sql`delete from s3_connections`;
    const row = (
      id: string,
      name: string,
      environmentId: string | null,
      bucket: string,
      keyPrefix: string | null,
      secret: string
    ) => ({
      id,
      name,
      environment_id: environmentId,
      endpoint: ENDPOINT,
      region: "auto",
      bucket,
      key_prefix: keyPrefix,
      access_key_id: `AK${name.replace(/\W/g, "").toUpperCase()}`,
      secret_key: encryptSecret(secret),
      force_path_style: true,
    });
    await sql`insert into s3_connections ${sql([
      row(CONN_LEGACY, "Menara backups", null, BUCKET, null, LEGACY_SECRET),
      row(CONN_FREE, "Old bucket", null, "fictional-old", null, "s-free"),
      // An environment's connection on the destination's bucket, under the
      // destination's prefix, and one beside it.
      row(CONN_SAME, "Menara copy", ENV, BUCKET, "acme/dumps/", "s-same"),
      row(CONN_OTHER, "Uploads", ENV, BUCKET, "uploads/", "s-other"),
    ])}`;
    await sql`update instance_settings
      set backup_destination_id = ${CONN_LEGACY} where id = 1`;
    s3.opened = [];
    s3.probes = [];
    as(ADMIN, "admin");
  });

  describe("read, save and clear", () => {
    it("is null until saved, then reads back without the secret", async () => {
      expect(await svc.getBackupDestination()).toBeNull();
      const saved = await svc.saveBackupDestination(destination());
      const read = await svc.getBackupDestination();
      for (const view of [saved, read]) {
        expect(view).toEqual({
          endpoint: ENDPOINT,
          region: "auto",
          bucket: BUCKET,
          accessKeyId: "AKFICTIONALMENARA",
          forcePathStyle: true,
          keyPrefix: "acme/",
          secretSet: true,
        });
        expect(JSON.stringify(view)).not.toContain(SECRET);
      }
      const page = await backups.getInstanceBackups();
      expect(page.destination).toEqual(read);
      expect(JSON.stringify(page)).not.toContain(SECRET);
      expect(JSON.stringify(page)).not.toContain("enc:v1:");
    });

    it("stores the secret encrypted, normalises the endpoint and the prefix", async () => {
      await svc.saveBackupDestination(
        destination({ endpoint: `${ENDPOINT}/`, keyPrefix: "/acme/backups" })
      );
      const row = await settingsRow();
      expect(row).toMatchObject({
        backup_s3_endpoint: ENDPOINT,
        backup_s3_key_prefix: "acme/backups/",
        // The legacy setting is left as it is (expand/contract).
        backup_destination_id: CONN_LEGACY,
      });
      const stored = String(row.backup_s3_secret_key);
      expect(stored.startsWith("enc:v1:")).toBe(true);
      expect(decryptSecret(stored)).toBe(SECRET);
      await svc.saveBackupDestination(destination({ keyPrefix: "  " }));
      expect((await settingsRow()).backup_s3_key_prefix).toBeNull();
    });

    it("refuses a bad key prefix with a coded 400", async () => {
      for (const keyPrefix of ["a/../b", "a//b", "a/%2e%2e/b", "./a"]) {
        expect(
          await refusal(svc.saveBackupDestination(destination({ keyPrefix })))
        ).toEqual({ status: 400, code: "s3KeyPrefixInvalid" });
      }
      expect((await settingsRow()).backup_s3_endpoint).toBeNull();
    });

    it("takes the secret again for a new destination and for any location change", async () => {
      expect(
        await refusal(
          svc.saveBackupDestination(destination({ secretKey: undefined }))
        )
      ).toEqual({ status: 400, code: "s3SecretRequiredForLocationChange" });
      await svc.saveBackupDestination(destination());
      for (const change of [
        { endpoint: "https://elsewhere.example.test" },
        { region: "eu-central-1" },
        { bucket: "fictional-other" },
        { accessKeyId: "AKOTHER" },
        { forcePathStyle: false },
        { keyPrefix: "other/" },
        { keyPrefix: null },
      ]) {
        expect(
          await refusal(
            svc.saveBackupDestination(destination({ ...change, secretKey: "" }))
          ),
          JSON.stringify(change)
        ).toEqual({ status: 400, code: "s3SecretRequiredForLocationChange" });
      }
      // The same location keeps the stored secret.
      await svc.saveBackupDestination(destination({ secretKey: "" }));
      expect(
        decryptSecret(String((await settingsRow()).backup_s3_secret_key))
      ).toBe(SECRET);
      // A location change with its own secret is saved.
      await svc.saveBackupDestination(
        destination({ bucket: "fictional-other", secretKey: "s-new" })
      );
      expect(await settingsRow()).toMatchObject({
        backup_s3_bucket: "fictional-other",
      });
    });

    it("clears back to local-only, keeping the legacy setting", async () => {
      await svc.saveBackupDestination(destination());
      await svc.clearBackupDestination();
      expect(await svc.getBackupDestination()).toBeNull();
      expect(await settingsRow()).toMatchObject({
        backup_s3_endpoint: null,
        backup_s3_region: null,
        backup_s3_bucket: null,
        backup_s3_access_key_id: null,
        backup_s3_secret_key: null,
        backup_s3_key_prefix: null,
        backup_destination_id: CONN_LEGACY,
      });
      expect(await loadBackupDestination()).toBeNull();
    });

    it("records instance.backupDestinationChanged, without secrets", async () => {
      await svc.saveBackupDestination(destination());
      await svc.clearBackupDestination();
      // Clearing nothing records nothing.
      await svc.clearBackupDestination();
      const rows = await activity();
      expect(rows).toEqual([
        {
          actor_id: ADMIN,
          data: { state: "set", endpoint: ENDPOINT, bucket: BUCKET },
        },
        {
          actor_id: ADMIN,
          data: { state: "cleared", endpoint: "", bucket: "" },
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain(SECRET);
    });
  });

  describe("permissions", () => {
    it("is admin-only, with a strong sign-in", async () => {
      await svc.saveBackupDestination(destination());
      for (const [id, role, method] of [
        [INFRA, "infra", "passkey"],
        [ENGINEER, "engineer", "passkey"],
        [ADMIN, "admin", "password"],
      ] as const) {
        as(id, role, method);
        for (const call of [
          () => svc.getBackupDestination(),
          () => svc.saveBackupDestination(destination()),
          () => svc.clearBackupDestination(),
          () => svc.testBackupDestination(destination()),
        ]) {
          expect((await refusal(call())).status, `${role} ${method}`).toBe(403);
        }
        for (const [method, path, body] of [
          ["GET", "/api/instance/backups/destination", undefined],
          ["PUT", "/api/instance/backups/destination", destination()],
          ["DELETE", "/api/instance/backups/destination", undefined],
          ["POST", "/api/instance/backups/destination/test", destination()],
        ] as const) {
          const res = await app.request(path, {
            method,
            headers: { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          expect(res.status, `${role} ${method} ${path}`).toBe(403);
        }
      }
      expect(s3.probes).toEqual([]);
      as(ADMIN, "admin");
      expect(await svc.getBackupDestination()).toMatchObject({
        bucket: BUCKET,
      });
    });

    it("serves the routes to an admin, never with the secret", async () => {
      const put = await app.request("/api/instance/backups/destination", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(destination()),
      });
      expect(put.status).toBe(200);
      const get = await app.request("/api/instance/backups/destination");
      const body = await get.text();
      expect(JSON.parse(body)).toMatchObject({
        bucket: BUCKET,
        secretSet: true,
      });
      expect(body).not.toContain(SECRET);
      // A bodyless request passes the CSRF guard as the browser's would.
      const del = await app.request("/api/instance/backups/destination", {
        method: "DELETE",
        headers: { "Sec-Fetch-Site": "same-origin" },
      });
      expect(del.status).toBe(200);
      expect(await svc.getBackupDestination()).toBeNull();
    });
  });

  describe("test connection", () => {
    it("uses the stored secret only for the unchanged stored location, with the prefix", async () => {
      await svc.saveBackupDestination(destination());
      expect(
        await svc.testBackupDestination(destination({ secretKey: undefined }))
      ).toEqual({ ok: true });
      expect(s3.probes).toEqual([
        {
          endpoint: ENDPOINT,
          region: "auto",
          bucket: BUCKET,
          accessKeyId: "AKFICTIONALMENARA",
          forcePathStyle: true,
          keyPrefix: "acme/",
          secretKey: SECRET,
        },
      ]);
      s3.probes = [];
      expect(
        await refusal(
          svc.testBackupDestination(
            destination({
              secretKey: "",
              endpoint: "https://evil.example.test",
            })
          )
        )
      ).toEqual({ status: 400, code: "s3SecretRequiredForLocationChange" });
      expect(s3.probes).toEqual([]);
      // Typed values with their own secret are probed as typed.
      await svc.testBackupDestination(
        destination({ bucket: "fictional-other", secretKey: "s-typed" })
      );
      expect(s3.probes).toEqual([
        expect.objectContaining({
          bucket: "fictional-other",
          secretKey: "s-typed",
        }),
      ]);
    });

    it("asks for a secret when none is stored", async () => {
      expect(
        await svc.testBackupDestination(destination({ secretKey: undefined }))
      ).toEqual({ ok: false, message: "s3SecretRequiredForTest" });
      expect(s3.probes).toEqual([]);
    });
  });

  describe("what backups and archives load", () => {
    it("instance backups and archives read the backup_s3_* destination", async () => {
      await svc.saveBackupDestination(destination());
      const loaded = await loadBackupDestination();
      expect(loaded).toMatchObject({
        endpoint: ENDPOINT,
        bucket: BUCKET,
        keyPrefix: "acme/",
        keepDaily: 14,
        keepWeekly: 8,
      });
    });

    it("stores a new archive flagged with the destination's endpoint and bucket", async () => {
      const { createArchive } = await import("@/lib/teardown/repository");
      const created = await createArchive({
        environmentId: null,
        projectName: "Kestrel",
        environmentName: "Kestrel QA",
        environmentSlug: "qa",
        expiresAt: new Date(Date.now() + 86_400_000),
        location: "s3",
        s3ConnectionId: null,
        inBackupDestination: true,
        s3Endpoint: ENDPOINT,
        s3Bucket: BUCKET,
        keyPrefix: "acme/menara-env-archives/menara/x/",
      });
      expect(created).toMatchObject({ inBackupDestination: true });
    });
  });

  describe("restricted targets", () => {
    const src = (connectionId: string) => ({
      kind: "s3" as const,
      connectionId,
    });

    it("an environment's connection on the destination's bucket and prefix is never browsable from it", async () => {
      await svc.saveBackupDestination(destination());
      as(ENGINEER, "engineer");
      expect(
        await refusal(explorer.listEntries(src(CONN_SAME), ""))
      ).toMatchObject({ status: 403 });
      expect(
        await refusal(
          storage.updateEnvironmentStorage(ENV, CONN_SAME, { name: "x" })
        )
      ).toEqual({ status: 409, code: "s3BackupDestinationRestricted" });
      // Beside the destination's prefix, the same bucket is the environment's.
      expect(await explorer.listEntries(src(CONN_OTHER), "")).toMatchObject({
        success: true,
      });
      expect(s3.opened).toHaveLength(1);
    });

    it("an environment can't add or move a connection onto the destination", async () => {
      await svc.saveBackupDestination(destination());
      as(ENGINEER, "engineer");
      for (const keyPrefix of [null, "acme/", "acme/sub/"]) {
        expect(
          await refusal(
            storage.createEnvironmentStorage(ENV, {
              name: "Sneaky",
              endpoint: `${ENDPOINT}/`,
              region: "auto",
              bucket: BUCKET,
              accessKeyId: "AKSNEAKY",
              secretKey: "s-sneaky",
              forcePathStyle: true,
              keyPrefix,
            })
          ),
          String(keyPrefix)
        ).toEqual({ status: 409, code: "s3BackupDestinationOverlap" });
      }
      expect(
        await refusal(
          storage.updateEnvironmentStorage(ENV, CONN_OTHER, {
            keyPrefix: "acme/",
            secretKey: "s-other-new",
          })
        )
      ).toEqual({ status: 409, code: "s3BackupDestinationOverlap" });
      const created = await storage.createEnvironmentStorage(ENV, {
        name: "Reports",
        endpoint: ENDPOINT,
        region: "auto",
        bucket: BUCKET,
        accessKeyId: "AKREPORTS",
        secretKey: "s-reports",
        forcePathStyle: true,
        keyPrefix: "reports/",
      });
      expect(created.keyPrefix).toBe("reports/");
    });

    it("restricts the destination's bucket and prefix on any endpoint spelling or alias", async () => {
      await svc.saveBackupDestination(destination());
      // An alias of the same store, and the same bucket name on another one.
      await sql`update s3_connections
        set endpoint = 'https://alias.example.test:9000' where id = ${CONN_SAME}`;
      await sql`update s3_connections
        set endpoint = 'https://192.0.2.44', bucket = ${BUCKET}
        where id = ${CONN_FREE}`;
      expect(await refusal(admin.assignS3Connection(CONN_FREE, ENV))).toEqual({
        status: 409,
        code: "s3BackupDestinationNotAssignable",
      });
      // Pages hide Edit and Browse for it (isBackupDestination).
      expect(
        (await admin.listUnassignedS3Connections()).find(
          (c) => c.id === CONN_FREE
        )
      ).toMatchObject({ isBackupDestination: true });
      as(ENGINEER, "engineer");
      expect(
        (await storage.listEnvironmentStorage(ENV)).map((c) => [
          c.id,
          c.isBackupDestination,
        ])
      ).toEqual(
        expect.arrayContaining([
          [CONN_SAME, true],
          [CONN_OTHER, false],
        ])
      );
      expect(
        await refusal(explorer.listEntries(src(CONN_SAME), ""))
      ).toMatchObject({ status: 403 });
      expect(s3.opened).toEqual([]);
      for (const endpoint of [
        "https://OBJECTS.example.test.:443/",
        "http://someone@objects.example.test:80?x=1",
        "https://alias.example.test",
        "https://198.51.100.7:9000",
      ]) {
        expect(
          await refusal(
            storage.createEnvironmentStorage(ENV, {
              name: "Sneaky",
              endpoint,
              region: "auto",
              bucket: BUCKET,
              accessKeyId: "AKSNEAKY",
              secretKey: "s-sneaky",
              forcePathStyle: true,
              keyPrefix: null,
            })
          ),
          endpoint
        ).toEqual({ status: 409, code: "s3BackupDestinationOverlap" });
      }
      expect(
        await refusal(
          storage.updateEnvironmentStorage(ENV, CONN_OTHER, {
            endpoint: "https://alias.example.test",
            keyPrefix: "acme/sub/",
            secretKey: "s-other-new",
          })
        )
      ).toEqual({ status: 409, code: "s3BackupDestinationOverlap" });
    });

    it("keeps the legacy backup destination connection restricted after the destination moved", async () => {
      await svc.saveBackupDestination(
        destination({ bucket: "fictional-elsewhere", keyPrefix: null })
      );
      expect(await refusal(admin.assignS3Connection(CONN_LEGACY, ENV))).toEqual(
        { status: 409, code: "s3BackupDestinationNotAssignable" }
      );
      // The engineer grant never reaches it.
      as(ENGINEER, "engineer");
      expect(
        await refusal(explorer.listEntries(src(CONN_LEGACY), ""))
      ).toMatchObject({ status: 403 });
    });
  });

  describe("deleting connections", () => {
    it("refuses the legacy backup destination and connections old archives live in", async () => {
      await sql`insert into environment_archives (project_name,
          environment_name, environment_slug, expires_at, location,
          s3_connection_id, key_prefix)
        values ('Heron', 'Heron old', 'old', now() + interval '30 days', 's3',
          ${CONN_FREE}, 'menara-env-archives/menara/old/')`;
      expect(
        await refusal(admin.deleteUnassignedS3Connection(CONN_LEGACY))
      ).toEqual({ status: 409, code: "s3BackupDestinationRestricted" });
      expect(
        await refusal(admin.deleteUnassignedS3Connection(CONN_FREE))
      ).toEqual({ status: 409, code: "s3ConnectionHoldsArchives" });
      const [kept] = await sql<{ count: number }[]>`
        select count(*)::int as count from s3_connections
        where id in (${CONN_LEGACY}, ${CONN_FREE})`;
      expect(kept?.count).toBe(2);
      await sql`delete from environment_archives`;
      await admin.deleteUnassignedS3Connection(CONN_FREE);
      const [gone] = await sql<{ count: number }[]>`
        select count(*)::int as count from s3_connections
        where id = ${CONN_FREE}`;
      expect(gone?.count).toBe(0);
    });
  });
});

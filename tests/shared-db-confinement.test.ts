import { beforeEach, describe, expect, it, vi } from "vitest";

// A shared database binding lives in a Postgres container that other
// environments use too. A caller without org server:manage (a project
// maintainer on an open server) may only touch the binding's own database and
// its `<dbName>_…` copies, only see those databases and their backups, and
// may not control or read the logs of the shared container. Admins are
// unaffected.

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const SOURCE_ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e2";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a9";

const state = vi.hoisted(() => ({
  orgRole: "member" as string,
  dbKind: "shared" as string | null,
  // The restore source's binding kind; undefined: same as dbKind.
  sourceDbKind: undefined as string | null | undefined,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({ user: { id: USER_ID, role: state.orgRole } }),
  getServerSession: async () => ({
    user: { id: USER_ID, role: state.orgRole },
  }),
}));
// The project guards pass (a maintainer); confinement is what is under test.
vi.mock("@/lib/authz", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/authz")>();
  const session = () => ({ user: { id: USER_ID, role: state.orgRole } });
  return {
    ...real,
    requireProjectPermission: async () => ({
      session: session(),
      role: "maintainer",
      projectId: "p",
    }),
    requireAnyProjectPermission: async () => ({
      session: session(),
      role: "maintainer",
      projectId: "p",
    }),
    routeProjectGuard: async () => ({
      ok: true,
      session: session(),
      role: "maintainer",
    }),
  };
});
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

const server = { id: "s1", host: "10.0.0.5", username: "ops", password: "pw" };
function environment(id: string) {
  return {
    id,
    name: id === ENV_ID ? "Sandbox 1" : "Sandbox source",
    projectId: "p",
    services: [
      {
        role: "db",
        serverId: "s1",
        server,
        serviceType: "docker",
        serviceName: "dplk-postgres",
        dbType: "postgres",
        dbName: id === ENV_ID ? "pcan_sandbox1" : "pcan_source",
        dbBackupPath: "/var/lib/postgresql/backups",
        dbKind:
          id === SOURCE_ENV_ID && state.sourceDbKind !== undefined
            ? state.sourceDbKind
            : state.dbKind,
      },
      {
        role: "backend",
        serverId: "s1",
        server,
        serviceType: "docker",
        serviceName: "pcan-sandbox1-api",
      },
    ],
  };
}
vi.mock("@/lib/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/environments")>()),
  loadEnvironmentWithServers: async (id: string) => environment(id),
}));

const jobs = vi.hoisted(() => ({ enqueue: vi.fn(), createRun: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueue: jobs.enqueue }));
vi.mock("@/lib/run-progress", () => ({ createRun: jobs.createRun }));

const ssh = vi.hoisted(() => ({
  executeRemoteCommand: vi.fn(),
  streamRemoteCommand: vi.fn(),
}));
vi.mock("@/lib/ssh", () => ssh);

const { createDatabase, dropDatabase, getDatabaseList, renameDatabase } =
  await import("@/server/services/databases");
const { createDatabaseBackup, getBackupList, restoreDatabaseBackup } =
  await import("@/server/services/backups");
const { controlService } = await import("@/server/services/services");
const { app } = await import("@/server/app");

const DATABASES = [
  "hris_dss",
  "pcan_sandbox1",
  "pcan_sandbox10",
  "pcan_sandbox1_copy",
  "postgres",
]
  .map((n) => `${n}|8192`)
  .join("\n");
const BACKUPS = [
  "hris_dss_2026-11-05T01-00-00-000Z.sql.gz",
  "pcan_sandbox1_2026-11-05T02-00-00-000Z.sql.gz",
  "pcan_sandbox1_copy_2026-11-05T03-00-00-000Z.sql",
  "pcan_sandbox10_2026-11-05T04-00-00-000Z.sql",
]
  .map((f) => `${f}\t1024\t1762300000`)
  .join("\n");

beforeEach(() => {
  vi.clearAllMocks();
  state.orgRole = "member";
  state.dbKind = "shared";
  state.sourceDbKind = undefined;
  jobs.createRun.mockResolvedValue("run-1");
  ssh.executeRemoteCommand.mockImplementation(
    async (_creds: unknown, cmd: string) =>
      cmd.includes("pg_database") ? DATABASES : BACKUPS
  );
});

const forbidden = { status: 403, message: "sharedDatabaseConfined" };

describe("database operations on a shared binding (maintainer)", () => {
  it("refuses create, drop and rename outright", async () => {
    for (const database of [
      "pcan_sandbox1_copy",
      "hris_dss",
      "pcan_sandbox10",
      "postgres",
    ]) {
      await expect(dropDatabase(ENV_ID, { database })).rejects.toMatchObject(
        forbidden
      );
      await expect(createDatabase(ENV_ID, { database })).rejects.toMatchObject(
        forbidden
      );
    }
    for (const [from, to] of [
      ["hris_dss", "pcan_sandbox1_x"],
      ["pcan_sandbox1_copy", "pcan_sandbox1_x"],
    ] as const) {
      await expect(renameDatabase(ENV_ID, { from, to })).rejects.toMatchObject(
        forbidden
      );
    }
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("lists only the binding's own database", async () => {
    const result = await getDatabaseList(ENV_ID);
    expect(result.success && result.data.map((d) => d.name)).toEqual([
      "pcan_sandbox1",
    ]);
  });

  it("lists only the binding's backups", async () => {
    const result = await getBackupList(ENV_ID);
    expect(result.success && result.data.map((b) => b.name)).toEqual([
      "pcan_sandbox1_2026-11-05T02-00-00-000Z.sql.gz",
      "pcan_sandbox1_copy_2026-11-05T03-00-00-000Z.sql",
    ]);
  });

  it("backs up and restores only the binding's own database, from its own backups", async () => {
    for (const database of ["hris_dss", "pcan_sandbox1_copy"]) {
      await expect(
        createDatabaseBackup(ENV_ID, { database })
      ).rejects.toMatchObject(forbidden);
      await expect(
        restoreDatabaseBackup(ENV_ID, {
          filename: "pcan_sandbox1_2026-11-05T02-00-00-000Z.sql.gz",
          database,
        })
      ).rejects.toMatchObject(forbidden);
    }
    // Restoring another database's backup file into its own database.
    await expect(
      restoreDatabaseBackup(ENV_ID, {
        filename: "hris_dss_2026-11-05T01-00-00-000Z.sql.gz",
      })
    ).rejects.toMatchObject(forbidden);
    // Never from another environment's backups, even the source's own file.
    for (const filename of [
      "pcan_source_2026-11-05T02-00-00-000Z.sql.gz",
      "pcan_sandbox1_2026-11-05T02-00-00-000Z.sql.gz",
    ]) {
      await expect(
        restoreDatabaseBackup(ENV_ID, {
          filename,
          sourceEnvironmentId: SOURCE_ENV_ID,
        })
      ).rejects.toMatchObject(forbidden);
    }
    expect(jobs.enqueue).not.toHaveBeenCalled();

    await expect(
      restoreDatabaseBackup(ENV_ID, {
        filename: "pcan_sandbox1_copy_2026-11-05T03-00-00-000Z.sql",
      })
    ).resolves.toEqual({ runId: "run-1" });
    await expect(
      restoreDatabaseBackup(ENV_ID, {
        filename: "pcan_sandbox1_2026-11-05T02-00-00-000Z.sql.gz",
        database: "pcan_sandbox1",
      })
    ).resolves.toEqual({ runId: "run-1" });
    await expect(createDatabaseBackup(ENV_ID)).resolves.toEqual({
      runId: "run-1",
    });
  });

  it("refuses control of the shared container, not of the environment's own services", async () => {
    await expect(controlService(ENV_ID, "db", "restart")).rejects.toMatchObject(
      { status: 403, message: "sharedDatabaseServiceConfined" }
    );
    await expect(controlService(ENV_ID, "backend", "restart")).resolves.toEqual(
      { runId: "run-1" }
    );
  });

  it("refuses the shared container's log stream", async () => {
    const res = await app.request(
      `/api/environments/${ENV_ID}/services/db/logs/stream`
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "sharedDatabaseServiceConfined",
    });
    expect(ssh.streamRemoteCommand).not.toHaveBeenCalled();
  });
});

describe("restoring from a shared source into a non-shared target", () => {
  const restoreFromSharedSource = () =>
    restoreDatabaseBackup(ENV_ID, {
      filename: "pcan_source_2026-11-05T02-00-00-000Z.sql.gz",
      sourceEnvironmentId: SOURCE_ENV_ID,
    });

  for (const target of [null, "container", "external"] as const) {
    it(`is refused for a maintainer (target ${target ?? "legacy"})`, async () => {
      state.dbKind = target;
      state.sourceDbKind = "shared";
      await expect(restoreFromSharedSource()).rejects.toMatchObject(forbidden);
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });
  }

  it("is allowed for an admin", async () => {
    state.orgRole = "admin";
    state.dbKind = null;
    state.sourceDbKind = "shared";
    await expect(restoreFromSharedSource()).resolves.toEqual({
      runId: "run-1",
    });
  });

  it("a maintainer still restores from a non-shared source", async () => {
    state.dbKind = null;
    state.sourceDbKind = "container";
    await expect(restoreFromSharedSource()).resolves.toEqual({
      runId: "run-1",
    });
  });
});

describe("the same calls by an admin, or on other bindings", () => {
  for (const [label, setup] of [
    ["an admin", () => (state.orgRole = "admin")],
    ["an infra user", () => (state.orgRole = "infra")],
    ["a maintainer on a legacy binding", () => (state.dbKind = null)],
    ["a maintainer on a container binding", () => (state.dbKind = "container")],
  ] as const) {
    it(`are allowed for ${label}`, async () => {
      setup();
      await expect(
        dropDatabase(ENV_ID, { database: "hris_dss" })
      ).resolves.toEqual({ runId: "run-1" });
      await expect(
        createDatabase(ENV_ID, { database: "pcan_sandbox1_copy" })
      ).resolves.toEqual({ runId: "run-1" });
      await expect(
        renameDatabase(ENV_ID, { from: "hris_dss", to: "hris_old" })
      ).resolves.toEqual({ runId: "run-1" });
      await expect(
        restoreDatabaseBackup(ENV_ID, {
          filename: "pcan_source_2026-11-05T02-00-00-000Z.sql.gz",
          sourceEnvironmentId: SOURCE_ENV_ID,
        })
      ).resolves.toEqual({ runId: "run-1" });
      await expect(
        restoreDatabaseBackup(ENV_ID, {
          filename: "hris_dss_2026-11-05T01-00-00-000Z.sql.gz",
          database: "hris_dss",
        })
      ).resolves.toEqual({ runId: "run-1" });
      const list = await getDatabaseList(ENV_ID);
      expect(list.success && list.data).toHaveLength(5);
      const backups = await getBackupList(ENV_ID);
      expect(backups.success && backups.data).toHaveLength(4);
      await expect(controlService(ENV_ID, "db", "restart")).resolves.toEqual({
        runId: "run-1",
      });
    });
  }
});

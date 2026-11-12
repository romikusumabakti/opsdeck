import { beforeEach, describe, expect, it, vi } from "vitest";

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const UUID = "11111111-1111-4111-8111-111111111111";

type Call = {
  op: string;
  table?: unknown;
  values?: unknown;
  where?: unknown;
};

// What the transaction did, in order, and what the stored environment holds.
const state = vi.hoisted(() => ({
  calls: [] as Call[],
  backupTargets: [] as unknown[],
  targets: [] as { componentKey: string; sourceBranch: string }[],
  appId: null as string | null,
  stored: { id: "", projectId: "", ownerId: null, services: [] } as {
    id: string;
    projectId: string;
    ownerId: string | null;
    services: { role: string; [k: string]: unknown }[];
  },
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({}),
  getServerSession: async () => ({}),
}));
vi.mock("@/lib/authz", () => ({
  getProjectRole: async () => null,
  projectScope: () => undefined,
  requireOrgPermission: async () => undefined,
  requireProjectPermission: async () => ({
    session: { user: { id: "user-1", role: "admin" } },
    role: "engineer",
  }),
}));
vi.mock("@/lib/secrets", () => ({
  encryptNullable: (v: string | null | undefined) => v ?? null,
}));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));
vi.mock("@/lib/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/environments")>()),
  loadEnvironmentWithServers: async () => state.stored,
}));
// Readable where-clauses: eq(column, value) -> value, and(...) -> array, so a
// test can see which role a delete/update targeted.
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (_column: unknown, value: unknown) => value,
  and: (...conditions: unknown[]) => conditions,
}));

const projectSources = vi.hoisted(() => ({
  ensureProjectSourceIn: vi.fn(),
  recordTargetSourceIn: vi.fn(),
}));
vi.mock("@/lib/project-sources", () => projectSources);

// No teardown under way (lib/teardown/guard has its own tests).
vi.mock("@/lib/teardown/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/teardown/guard")>()),
  tearingDownIn: async () => teardown.blocks,
  holdEnvironmentExclusive: async () => {},
}));
const teardown = vi.hoisted(() => ({ blocks: false, running: false }));

vi.mock("@/lib/db", () => {
  // A query builder: awaiting it yields rows, and every builder method returns
  // it again so any chain order works.
  const query = (call: Call, rows: unknown[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: self-referential mock builder
    const chain: any = Object.assign(Promise.resolve(rows), {
      values: (values: unknown) => {
        call.values = values;
        return chain;
      },
      set: (values: unknown) => {
        call.values = values;
        return chain;
      },
      where: (condition: unknown) => {
        call.where = condition;
        return chain;
      },
      from: (table: unknown) =>
        table === schema.deployTargets && call.op === "select"
          ? query(call, state.targets)
          : chain,
      limit: async () => rows,
      returning: async () => [
        { id: ENV_ID, projectId: UUID, appId: state.appId },
      ],
    });
    return chain;
  };
  const record = (op: string) => (table?: unknown) => {
    const call: Call = { op, table };
    state.calls.push(call);
    return query(call, [{ id: ENV_ID }]);
  };
  const tx = {
    insert: record("insert"),
    update: record("update"),
    delete: record("delete"),
    select: () => record("select")(),
  };
  return {
    db: {
      transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
      select: () => query({ op: "db-select" }, state.backupTargets),
    },
  };
});

const { createEnvironment, updateEnvironment, insertEnvironmentIn } =
  await import("@/server/services/environments");
const { db } = await import("@/lib/db");
const schema = await import("@/lib/db/schema");

const backend = {
  backendServerId: UUID,
  backendServiceType: "docker",
  backendServiceName: "api",
};
const database = {
  dbServerId: UUID,
  dbServiceType: "docker",
  dbServiceName: "pg",
  dbType: "postgres",
  dbName: "app",
  dbBackupPath: "/backups",
};
const frontend = {
  frontendServerId: UUID,
  frontendServiceType: "docker",
  frontendServiceName: "web",
};

const rolesInserted = () =>
  state.calls
    .filter((c) => c.op === "insert" && Array.isArray(c.values))
    .flatMap((c) => (c.values as { role: string }[]).map((v) => v.role));

beforeEach(() => {
  state.calls = [];
  state.backupTargets = [];
  state.targets = [];
  state.appId = null;
  projectSources.ensureProjectSourceIn.mockClear();
  projectSources.recordTargetSourceIn.mockClear();
  state.stored = {
    id: ENV_ID,
    projectId: UUID,
    ownerId: null,
    services: [
      { role: "db", serverId: UUID },
      { role: "backend", serverId: UUID },
      { role: "frontend", serverId: UUID },
    ],
  };
});

describe("createEnvironment with optional services", () => {
  it("inserts only backend and frontend when hasDatabase is false", async () => {
    const result = await createEnvironment({
      projectId: UUID,
      name: "Dev",
      hasDatabase: false,
      ...backend,
      ...frontend,
    });
    expect(result.success).toBe(true);
    expect(rolesInserted()).toEqual(["backend", "frontend"]);
  });

  it("rejects a payload missing fields of an enabled service", async () => {
    const result = await createEnvironment({
      projectId: UUID,
      name: "Dev",
      ...backend,
      ...frontend,
    });
    expect(result.success).toBe(false);
  });
});

describe("updateEnvironment with optional services", () => {
  it("deletes only the frontend row when hasFrontend is false", async () => {
    const result = await updateEnvironment(ENV_ID, { hasFrontend: false });
    expect(result.success).toBe(true);
    const deletes = state.calls.filter((c) => c.op === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.where).toEqual([ENV_ID, "frontend"]);
    expect(state.calls.filter((c) => c.op === "update")).toEqual([]);
    expect(rolesInserted()).toEqual([]);
  });

  it("refuses (409 teardownRunning) any edit while a teardown runs", async () => {
    teardown.blocks = true;
    try {
      await expect(
        updateEnvironment(ENV_ID, { hasFrontend: false })
      ).rejects.toMatchObject({ status: 409, code: "teardownRunning" });
      expect(state.calls.filter((c) => c.op === "delete")).toEqual([]);
    } finally {
      teardown.blocks = false;
    }
  });

  it("refuses to drop the database while a target backs up before deploy", async () => {
    state.backupTargets = [{ id: UUID }];
    await expect(
      updateEnvironment(ENV_ID, { hasDatabase: false })
    ).rejects.toMatchObject({
      status: 409,
      message: "backupTargetsBlockDatabaseRemoval",
    });
    expect(state.calls.filter((c) => c.op === "delete")).toEqual([]);
  });

  it("drops the database when no target backs up before deploy", async () => {
    const result = await updateEnvironment(ENV_ID, { hasDatabase: false });
    expect(result.success).toBe(true);
    expect(
      state.calls.filter((c) => c.op === "delete").map((c) => c.where)
    ).toEqual([[ENV_ID, "db"]]);
  });

  it("inserts the frontend when hasFrontend is true and the row is missing", async () => {
    state.stored.services = state.stored.services.filter(
      (s) => s.role !== "frontend"
    );
    const result = await updateEnvironment(ENV_ID, {
      hasFrontend: true,
      ...frontend,
    });
    expect(result.success).toBe(true);
    expect(rolesInserted()).toEqual(["frontend"]);
  });

  it("does not recreate a missing service when no flag is sent", async () => {
    state.stored.services = state.stored.services.filter(
      (s) => s.role !== "frontend"
    );
    await updateEnvironment(ENV_ID, { ...frontend });
    expect(rolesInserted()).toEqual([]);
    expect(state.calls.some((c) => c.op === "delete")).toBe(false);
    const updatedRoles = state.calls
      .filter((c) => c.op === "update" && Array.isArray(c.where))
      .map((c) => (c.where as unknown[])[1]);
    expect(updatedRoles.filter((r) => r !== "frontend")).toEqual([]);
  });

  it("refuses hasFrontend true without frontend fields", async () => {
    state.stored.services = state.stored.services.filter(
      (s) => s.role !== "frontend"
    );
    const result = await updateEnvironment(ENV_ID, { hasFrontend: true });
    expect(result).toEqual({
      success: false,
      message: "Frontend fields are required",
    });
    expect(state.calls).toEqual([]);
  });

  it("refuses hasDatabase true without database fields", async () => {
    state.stored.services = state.stored.services.filter(
      (s) => s.role !== "db"
    );
    const result = await updateEnvironment(ENV_ID, { hasDatabase: true });
    expect(result).toEqual({
      success: false,
      message: "Database fields are required",
    });
  });

  it("patches an existing service when the flag is true", async () => {
    await updateEnvironment(ENV_ID, {
      hasDatabase: true,
      dbServiceName: "pg2",
    });
    expect(rolesInserted()).toEqual([]);
    expect(state.calls.some((c) => c.op === "update")).toBe(true);
  });

  it("keeps today's partial patch when no flag is sent", async () => {
    await updateEnvironment(ENV_ID, { ...database, backendServiceName: "x" });
    expect(state.calls.some((c) => c.op === "delete")).toBe(false);
    expect(rolesInserted()).toEqual([]);
  });
});

describe("insertEnvironmentIn project sources", () => {
  const input = {
    projectId: UUID,
    name: "Dev",
    kind: "development",
    hasDatabase: false,
    hasFrontend: false,
    ...backend,
  } as never;
  const APP = "22222222-2222-4222-8222-222222222222";

  it("adds the app to the project's sources when the setup sets one", async () => {
    await db.transaction((tx) =>
      insertEnvironmentIn(tx as never, input, {
        slug: "dev",
        ownerId: "user-1",
        extra: { appId: APP },
      })
    );
    expect(projectSources.ensureProjectSourceIn).toHaveBeenCalledWith(
      expect.anything(),
      ENV_ID,
      APP
    );
  });

  it("adds nothing without an app", async () => {
    await db.transaction((tx) =>
      insertEnvironmentIn(tx as never, input, {
        slug: "dev",
        ownerId: "user-1",
      })
    );
    expect(projectSources.ensureProjectSourceIn).not.toHaveBeenCalled();
  });
});

describe("updateEnvironment moving to another project", () => {
  const OTHER = "22222222-2222-4222-8222-222222222222";
  const APP = "33333333-3333-4333-8333-333333333333";

  it("adds the app and seeds each target's branch in the new project", async () => {
    state.appId = APP;
    state.targets = [
      { componentKey: "api", sourceBranch: "main" },
      { componentKey: "web", sourceBranch: "develop" },
    ];
    const result = await updateEnvironment(ENV_ID, { projectId: OTHER });
    expect(result.success).toBe(true);
    expect(projectSources.ensureProjectSourceIn).toHaveBeenCalledWith(
      expect.anything(),
      ENV_ID,
      APP
    );
    expect(
      projectSources.recordTargetSourceIn.mock.calls.map((c) => c[1])
    ).toEqual([
      { environmentId: ENV_ID, componentKey: "api", sourceBranch: "main" },
      { environmentId: ENV_ID, componentKey: "web", sourceBranch: "develop" },
    ]);
  });

  it("skips the app when the environment has none", async () => {
    await updateEnvironment(ENV_ID, { projectId: OTHER });
    expect(projectSources.ensureProjectSourceIn).not.toHaveBeenCalled();
  });

  it("calls nothing when the project does not change", async () => {
    state.appId = APP;
    state.targets = [{ componentKey: "api", sourceBranch: "main" }];
    await updateEnvironment(ENV_ID, { name: "Renamed" });
    await updateEnvironment(ENV_ID, { projectId: UUID });
    expect(projectSources.ensureProjectSourceIn).not.toHaveBeenCalled();
    expect(projectSources.recordTargetSourceIn).not.toHaveBeenCalled();
  });
});

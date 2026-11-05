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
    role: "maintainer",
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
      from: () => chain,
      limit: async () => rows,
      returning: async () => [{ id: ENV_ID, projectId: UUID }],
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
      select: () => query({ op: "select" }, state.backupTargets),
    },
  };
});

const { createEnvironment, updateEnvironment } = await import(
  "@/server/services/environments"
);

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

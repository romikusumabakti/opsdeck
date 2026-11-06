import { beforeEach, describe, expect, it, vi } from "vitest";

// Database hosts are fleet-level (org server:manage). Registering one checks
// over SSH that the superuser can query the container; deleting one is
// refused while an environment is bound to it.

const SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const HOST_ID = "0197f3a0-1b2c-7def-8000-0123456789b7";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";

type Call = { op: string; table?: unknown; values?: unknown };
const state = vi.hoisted(() => ({
  orgRole: "admin" as string,
  hostRows: [] as Record<string, unknown>[],
  boundRows: [] as { id: string }[],
  insertConflict: false,
  calls: [] as Call[],
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: USER_ID, role: state.orgRole },
  })),
}));
vi.mock("@/lib/authz", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/authz")>();
  const { canOrg } = await import("@/lib/permissions");
  return {
    ...real,
    requireOrgPermission: vi.fn(async (perms: Parameters<typeof canOrg>[1]) => {
      if (!canOrg(state.orgRole, perms)) throw new real.ForbiddenError();
      return { user: { id: USER_ID, role: state.orgRole } };
    }),
  };
});
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

const ssh = vi.hoisted(() => ({ executeRemoteCommand: vi.fn() }));
vi.mock("@/lib/ssh", () => ssh);

vi.mock("@/lib/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/environments")>()),
  loadServerCredentials: vi.fn(async (id: string) =>
    id === SERVER_ID
      ? { host: "10.0.0.5", username: "ops", password: "ssh-pw" }
      : null
  ),
}));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const rowsFor = (call: Call): unknown[] => {
    if (call.op === "insert") {
      return state.insertConflict
        ? []
        : [{ id: HOST_ID, ...(call.values as object) }];
    }
    if (call.op !== "select") return [];
    if (call.table === schema.servers) {
      return [{ id: SERVER_ID, name: "node-1" }];
    }
    if (call.table === schema.databaseHosts) return state.hostRows;
    if (call.table === schema.environmentServices) return state.boundRows;
    return [];
  };
  const query = (call: Call) => {
    // biome-ignore lint/suspicious/noExplicitAny: self-referential mock builder
    const chain: any = {
      from: (table: unknown) => {
        call.table = table;
        return chain;
      },
      values: (values: unknown) => {
        call.values = values;
        return chain;
      },
      where: () => chain,
      innerJoin: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      onConflictDoNothing: () => chain,
      returning: () => chain,
      // biome-ignore lint/suspicious/noThenProperty: awaitable query builder
      then: (resolve: (rows: unknown[]) => unknown, reject: () => unknown) =>
        Promise.resolve(rowsFor(call)).then(resolve, reject),
    };
    return chain;
  };
  const record = (op: string) => (table?: unknown) => {
    const call: Call = { op, table };
    state.calls.push(call);
    return query(call);
  };
  return {
    db: {
      select: () => record("select")(),
      insert: record("insert"),
      delete: record("delete"),
    },
  };
});

const schema = await import("@/lib/db/schema");
const { app } = await import("@/server/app");

const BODY = {
  serverId: SERVER_ID,
  containerName: "dplk-postgres",
  backupPath: "/var/lib/postgresql/backups",
  label: "DPLK Postgres",
};
const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const writes = () =>
  state.calls.filter((c) => c.op === "insert" || c.op === "delete");

beforeEach(() => {
  vi.clearAllMocks();
  state.orgRole = "admin";
  state.hostRows = [
    {
      id: HOST_ID,
      serverId: SERVER_ID,
      containerName: "dplk-postgres",
      label: "DPLK Postgres",
      server: "node-1",
    },
  ];
  state.boundRows = [];
  state.insertConflict = false;
  state.calls = [];
  ssh.executeRemoteCommand.mockResolvedValue("1\n");
});

describe("database hosts API", () => {
  it("is 403 without server:manage", async () => {
    for (const role of ["member", "observer"]) {
      state.orgRole = role;
      expect((await send("GET", "/api/database-hosts")).status).toBe(403);
      expect((await send("POST", "/api/database-hosts", BODY)).status).toBe(
        403
      );
      expect(
        (await send("DELETE", `/api/database-hosts/${HOST_ID}`)).status
      ).toBe(403);
    }
    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it("lists the hosts", async () => {
    const res = await send("GET", `/api/database-hosts?serverId=${SERVER_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it("verifies the container, registers it and logs it", async () => {
    const res = await send("POST", "/api/database-hosts", BODY);
    expect(res.status).toBe(200);
    expect(ssh.executeRemoteCommand.mock.calls[0]?.[1]).toBe(
      "docker exec 'dplk-postgres' psql -U postgres -Atc 'select 1'"
    );
    const insert = state.calls.find((c) => c.op === "insert");
    expect(insert?.table).toBe(schema.databaseHosts);
    expect(insert?.values).toEqual(BODY);
    const entry = activity.recordActivity.mock.calls[0]?.[0];
    expect(entry).toMatchObject({
      action: "database_host.create",
      data: { server: "node-1", container: "dplk-postgres" },
    });
  });

  it("is 502 when the container can't be queried, and registers nothing", async () => {
    ssh.executeRemoteCommand.mockRejectedValue(new Error("No such container"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await send("POST", "/api/database-hosts", BODY);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "databaseHostUnreachable" });
    expect(writes()).toEqual([]);
  });

  it("is 409 for a container already registered", async () => {
    state.insertConflict = true;
    const res = await send("POST", "/api/database-hosts", BODY);
    expect(res.status).toBe(409);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("is 400 for an invalid container name or backup path", async () => {
    for (const bad of [
      { containerName: "a b; rm -rf /" },
      { backupPath: "relative/path" },
      { label: "" },
    ]) {
      const res = await send("POST", "/api/database-hosts", {
        ...BODY,
        ...bad,
      });
      expect(res.status).toBe(400);
    }
    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
  });

  it("refuses to delete a host an environment is bound to (409)", async () => {
    state.boundRows = [{ id: "svc" }];
    const res = await send("DELETE", `/api/database-hosts/${HOST_ID}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "databaseHostInUse" });
    expect(writes()).toEqual([]);
  });

  it("deletes an unbound host and logs it", async () => {
    const res = await send("DELETE", `/api/database-hosts/${HOST_ID}`);
    expect(res.status).toBe(200);
    expect(writes()).toEqual([
      expect.objectContaining({ op: "delete", table: schema.databaseHosts }),
    ]);
    expect(activity.recordActivity.mock.calls[0]?.[0]).toMatchObject({
      action: "database_host.delete",
      data: { label: "DPLK Postgres", server: "node-1" },
    });
  });

  it("is 404 for an unknown host", async () => {
    state.hostRows = [];
    const res = await send("DELETE", `/api/database-hosts/${HOST_ID}`);
    expect(res.status).toBe(404);
  });
});

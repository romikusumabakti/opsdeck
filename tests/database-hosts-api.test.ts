import { beforeEach, describe, expect, it, vi } from "vitest";

// Database hosts are fleet-level: creating and deleting need org
// server:manage, listing (without the backup path) only a session.
// Registering one checks over SSH that the superuser can query the container
// and that it runs Postgres 15+; deleting one is refused while an environment
// is bound to it.

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
    if (call.op === "update") return state.hostRows;
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
      set: (values: unknown) => {
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
      update: record("update"),
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
  state.calls.filter(
    (c) => c.op === "insert" || c.op === "delete" || c.op === "update"
  );

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
  ssh.executeRemoteCommand.mockImplementation(async (_creds, command) =>
    String(command).includes("docker inspect")
      ? '{"bridge":{},"dplk_net":{}}\n'
      : "180006\n"
  );
});

describe("database hosts API", () => {
  it("is 403 without server:manage for create and delete", async () => {
    for (const role of ["member", "observer"]) {
      state.orgRole = role;
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

  it("lists the hosts to any signed-in user, without the backup path", async () => {
    state.hostRows = [
      {
        id: HOST_ID,
        serverId: SERVER_ID,
        label: "DPLK Postgres",
        containerName: "dplk-postgres",
      },
    ];
    for (const role of ["member", "observer", "admin"]) {
      state.orgRole = role;
      const res = await send(
        "GET",
        `/api/database-hosts?serverId=${SERVER_ID}`
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(state.hostRows);
    }
    // The projection itself names no backup path.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("server/services/database-hosts.ts", "utf8")
    );
    const list = source.slice(
      source.indexOf("export async function listDatabaseHosts"),
      source.indexOf("// Postgres 15 stopped")
    );
    expect(list).toContain("requireSession()");
    expect(list).not.toContain("backupPath");
  });

  it("refuses a Postgres older than 15 and stores nothing", async () => {
    for (const version of ["140011", "garbage", ""]) {
      ssh.executeRemoteCommand.mockResolvedValue(`${version}\n`);
      const res = await send("POST", "/api/database-hosts", BODY);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "databaseHostVersion" });
    }
    expect(writes()).toEqual([]);
  });

  it("verifies the container, registers it and logs it", async () => {
    const res = await send("POST", "/api/database-hosts", BODY);
    expect(res.status).toBe(200);
    expect(ssh.executeRemoteCommand.mock.calls[0]?.[1]).toBe(
      "docker exec 'dplk-postgres' psql -U postgres -Atc 'show server_version_num'"
    );
    const insert = state.calls.find((c) => c.op === "insert");
    expect(insert?.table).toBe(schema.databaseHosts);
    expect(ssh.executeRemoteCommand.mock.calls[1]?.[1]).toBe(
      "docker inspect -f '{{json .NetworkSettings.Networks}}' 'dplk-postgres'"
    );
    expect(insert?.values).toEqual({ ...BODY, network: "dplk_net" });
    const entry = activity.recordActivity.mock.calls[0]?.[0];
    expect(entry).toMatchObject({
      action: "database_host.create",
      data: { server: "node-1", container: "dplk-postgres" },
    });
  });

  it("keeps an explicit network without reading the container's", async () => {
    const res = await send("POST", "/api/database-hosts", {
      ...BODY,
      network: "custom-net",
    });
    expect(res.status).toBe(200);
    expect(ssh.executeRemoteCommand).toHaveBeenCalledTimes(1);
    expect(state.calls.find((c) => c.op === "insert")?.values).toEqual({
      ...BODY,
      network: "custom-net",
    });
  });

  it("registers with no network when the networks can't be read", async () => {
    ssh.executeRemoteCommand.mockImplementation(async (_creds, command) => {
      if (String(command).includes("docker inspect")) throw new Error("boom");
      return "180006\n";
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await send("POST", "/api/database-hosts", BODY);
    expect(res.status).toBe(200);
    expect(state.calls.find((c) => c.op === "insert")?.values).toEqual({
      ...BODY,
      network: null,
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

  it("sets the network of a host and logs it (PATCH)", async () => {
    state.hostRows = [
      {
        id: HOST_ID,
        serverId: SERVER_ID,
        containerName: "dplk-postgres",
        label: "DPLK Postgres",
      },
    ];
    const res = await send("PATCH", `/api/database-hosts/${HOST_ID}`, {
      network: "dplk_net",
    });
    expect(res.status).toBe(200);
    const update = state.calls.find((c) => c.op === "update");
    expect(update?.table).toBe(schema.databaseHosts);
    expect(update?.values).toMatchObject({ network: "dplk_net" });
    expect(activity.recordActivity.mock.calls[0]?.[0]).toMatchObject({
      action: "database_host.update",
      data: { network: "dplk_net", server: "node-1" },
    });
  });

  it("clears the network with null", async () => {
    const res = await send("PATCH", `/api/database-hosts/${HOST_ID}`, {
      network: null,
    });
    expect(res.status).toBe(200);
    expect(state.calls.find((c) => c.op === "update")?.values).toMatchObject({
      network: null,
    });
  });

  it("is 403 for PATCH without server:manage", async () => {
    state.orgRole = "member";
    const res = await send("PATCH", `/api/database-hosts/${HOST_ID}`, {
      network: "x",
    });
    expect(res.status).toBe(403);
    expect(writes()).toEqual([]);
  });

  it("is 400 for an invalid network name", async () => {
    for (const bad of ["-lead", "a b", "x;rm", "", "a".repeat(129)]) {
      const res = await send("PATCH", `/api/database-hosts/${HOST_ID}`, {
        network: bad,
      });
      expect(res.status, bad).toBe(400);
    }
    expect(writes()).toEqual([]);
  });

  it("is 404 for PATCH on an unknown host", async () => {
    state.hostRows = [];
    const res = await send("PATCH", `/api/database-hosts/${HOST_ID}`, {
      network: "x",
    });
    expect(res.status).toBe(404);
  });
});

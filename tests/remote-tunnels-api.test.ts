import { beforeEach, describe, expect, it, vi } from "vitest";

const SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const ROW_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";

const state = vi.hoisted(() => ({
  orgRole: "admin" as string,
  serverExists: true,
  serverTaken: false,
  accountRowId: "acc-row-1" as string | undefined,
  alreadyRegistered: false,
  bindings: 0,
  tunnels: [] as {
    id: string;
    name: string;
    status: string;
    remoteConfig: boolean;
  }[],
  insertError: null as unknown,
  deleteError: null as unknown,
  inserted: null as Record<string, unknown> | null,
  deleted: [] as string[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "user-1", role: state.orgRole },
  })),
}));

vi.mock("@/lib/authz", async () => {
  const { canOrg } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    requireOrgPermission: vi.fn(async (perms: Parameters<typeof canOrg>[1]) => {
      if (!canOrg(state.orgRole as "admin", perms)) {
        throw new HTTPException(403, { message: "Forbidden" });
      }
      return { user: { id: "user-1", role: state.orgRole } };
    }),
  };
});

vi.mock("@/server/services/cloudflare-account", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/services/cloudflare-account")
  >()),
  callCloudflare: vi.fn(async () => state.tunnels),
}));

vi.mock("@/lib/domains/repository", () => ({
  serverExists: vi.fn(async () => state.serverExists),
  getRemoteTunnelByServer: vi.fn(async () =>
    state.serverTaken ? { id: ROW_ID } : undefined
  ),
  getAccountRowId: vi.fn(async () => state.accountRowId),
  getRemoteTunnelByCloudflareId: vi.fn(async () =>
    state.alreadyRegistered ? { id: ROW_ID } : undefined
  ),
  insertRemoteTunnel: vi.fn(async (values: Record<string, unknown>) => {
    if (state.insertError) throw state.insertError;
    state.inserted = values;
    return { id: ROW_ID, ...values };
  }),
  listRemoteTunnels: vi.fn(async () => []),
  getRemoteTunnel: vi.fn(async (id: string) =>
    id === ROW_ID ? { id } : undefined
  ),
  countBindings: vi.fn(async () => state.bindings),
  deleteRemoteTunnel: vi.fn(async (id: string) => {
    if (state.deleteError) throw state.deleteError;
    state.deleted.push(id);
  }),
}));

const { app } = await import("@/server/app");

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const register = (extra: Record<string, unknown> = {}) =>
  send("POST", "/api/remote-tunnels", {
    serverId: SERVER_ID,
    tunnelId: "t-1",
    ...extra,
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.orgRole = "admin";
  state.serverExists = true;
  state.serverTaken = false;
  state.accountRowId = "acc-row-1";
  state.alreadyRegistered = false;
  state.bindings = 0;
  state.tunnels = [
    { id: "t-1", name: "dss-113", status: "healthy", remoteConfig: true },
    { id: "t-local", name: "legacy", status: "healthy", remoteConfig: false },
  ];
  state.inserted = null;
  state.insertError = null;
  state.deleteError = null;
  state.deleted = [];
});

describe("permissions", () => {
  it("answers 403 on every route without server:manage", async () => {
    state.orgRole = "engineer";
    expect((await send("GET", "/api/remote-tunnels")).status).toBe(403);
    expect((await register()).status).toBe(403);
    expect((await send("DELETE", `/api/remote-tunnels/${ROW_ID}`)).status).toBe(
      403
    );
    expect(state.inserted).toBeNull();
    expect(state.deleted).toEqual([]);
  });
});

describe("POST /api/remote-tunnels", () => {
  it("registers a listed remote tunnel, taking the name from Cloudflare", async () => {
    const res = await register({ originHost: "10.0.0.5", name: "ignored" });
    // `name` is not an accepted field.
    expect(res.status).toBe(400);

    const ok = await register({ originHost: "10.0.0.5" });
    expect(ok.status).toBe(201);
    expect(state.inserted).toMatchObject({
      accountId: "acc-row-1",
      serverId: SERVER_ID,
      tunnelId: "t-1",
      name: "dss-113",
      originHost: "10.0.0.5",
    });
  });

  it("defaults the origin host to localhost", async () => {
    expect((await register()).status).toBe(201);
    expect(state.inserted).toMatchObject({ originHost: "localhost" });
  });

  it("refuses a tunnel id the account does not list with 422", async () => {
    const res = await register({ tunnelId: "t-missing" });
    expect(res.status).toBe(422);
    expect(state.inserted).toBeNull();
  });

  it("refuses a locally managed tunnel with 422 tunnelNotRemote", async () => {
    const res = await register({ tunnelId: "t-local" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/configured locally/);
    expect(state.inserted).toBeNull();
  });

  it("answers 409 when the account is not set up", async () => {
    state.accountRowId = undefined;
    expect((await register()).status).toBe(409);
  });

  it("answers 409 when the server or the tunnel is already registered", async () => {
    state.serverTaken = true;
    expect((await register()).status).toBe(409);
    state.serverTaken = false;
    state.alreadyRegistered = true;
    expect((await register()).status).toBe(409);
    expect(state.inserted).toBeNull();
  });

  it("answers 422 for an unknown server and 400 for a bad origin host", async () => {
    state.serverExists = false;
    expect((await register()).status).toBe(422);
    state.serverExists = true;
    expect((await register({ originHost: "http://x" })).status).toBe(400);
  });
});

describe("DELETE /api/remote-tunnels/:id", () => {
  it("deletes an unbound tunnel", async () => {
    const res = await send("DELETE", `/api/remote-tunnels/${ROW_ID}`);
    expect(res.status).toBe(200);
    expect(state.deleted).toEqual([ROW_ID]);
  });

  it("answers 409 while an environment is bound to it", async () => {
    state.bindings = 1;
    const res = await send("DELETE", `/api/remote-tunnels/${ROW_ID}`);
    expect(res.status).toBe(409);
    expect(state.deleted).toEqual([]);
  });

  it("answers 404 for an unknown id", async () => {
    const res = await send(
      "DELETE",
      "/api/remote-tunnels/0197f3a0-1b2c-7def-8000-0123456789ff"
    );
    expect(res.status).toBe(404);
  });
});

describe("database races", () => {
  it("maps a unique violation on register to 409", async () => {
    state.insertError = Object.assign(new Error("dup"), { code: "23505" });
    expect((await register()).status).toBe(409);
  });

  it("maps a foreign key violation on delete to 409", async () => {
    state.deleteError = { cause: { code: "23503" } };
    const res = await send("DELETE", `/api/remote-tunnels/${ROW_ID}`);
    expect(res.status).toBe(409);
  });
});

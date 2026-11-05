import { beforeEach, describe, expect, it, vi } from "vitest";

const SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";

const state = vi.hoisted(() => ({ orgRole: "admin" as string }));
const store = vi.hoisted(() => ({
  preflight: null as unknown,
  preflightAt: null as Date | null,
  entryPorts: [] as number[],
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: USER_ID, role: state.orgRole },
  })),
}));
vi.mock("@/lib/authz", async () => {
  const { canOrg } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    requireOrgPermission: vi.fn(async (perms: Parameters<typeof canOrg>[1]) => {
      if (!canOrg(state.orgRole, perms)) {
        throw new HTTPException(403, { message: "Forbidden" });
      }
      return { user: { id: USER_ID, role: state.orgRole } };
    }),
  };
});

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

const ssh = vi.hoisted(() => ({ executeRemoteCommand: vi.fn() }));
vi.mock("@/lib/ssh", () => ssh);

vi.mock("@/lib/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/environments")>()),
  loadServerCredentials: vi.fn(async () => ({
    host: "10.0.0.5",
    username: "ops",
    password: "pw",
  })),
}));

vi.mock("@/server/services/preflight-repository", () => ({
  getStoredPreflight: vi.fn(async (id: string) =>
    id === SERVER_ID
      ? {
          name: "node-1",
          preflight: store.preflight,
          preflightAt: store.preflightAt,
        }
      : null
  ),
  saveServerPreflight: vi.fn(
    async (_id: string, preflight: unknown, at: Date) => {
      store.preflight = preflight;
      store.preflightAt = at;
    }
  ),
  listEntryPortsOnServer: vi.fn(async () => store.entryPorts),
}));

const { app } = await import("@/server/app");

const OUTPUT =
  "@@docker\n29.0.1\n@@ps\ndb\tpostgres:18\t5432/tcp\n@@ss\nLISTEN 0 1 0.0.0.0:8100 0.0.0.0:*\n";

beforeEach(() => {
  vi.clearAllMocks();
  state.orgRole = "admin";
  store.preflight = null;
  store.preflightAt = null;
  store.entryPorts = [];
  ssh.executeRemoteCommand.mockResolvedValue(OUTPUT);
});

const post = (path: string) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
const get = (path: string) => app.request(path);

describe("server preflight API", () => {
  it("rejects callers without server:manage", async () => {
    state.orgRole = "member";
    expect((await post(`/api/servers/${SERVER_ID}/preflight`)).status).toBe(
      403
    );
    expect((await get(`/api/servers/${SERVER_ID}/preflight`)).status).toBe(403);
    expect((await get(`/api/servers/${SERVER_ID}/free-port`)).status).toBe(403);
    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
  });

  it("runs, stores and logs without the output", async () => {
    const res = await post(`/api/servers/${SERVER_ID}/preflight`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runtime.docker).toBe("29.0.1");
    expect(ssh.executeRemoteCommand.mock.calls[0]?.[2]).toBe(30_000);
    expect(store.preflightAt).toBeInstanceOf(Date);

    const stored = await (
      await get(`/api/servers/${SERVER_ID}/preflight`)
    ).json();
    expect(stored.preflight.postgresCandidates).toHaveLength(1);

    const entry = activity.recordActivity.mock.calls[0]?.[0];
    expect(entry.action).toBe("server.preflight");
    expect(JSON.stringify(entry)).not.toContain("29.0.1");
  });

  it("answers 404 for an unknown server", async () => {
    const res = await post(
      `/api/servers/0197f3a0-1b2c-7def-8000-0123456789ff/preflight`
    );
    expect(res.status).toBe(404);
  });

  it("free-port skips scanned ports and other environments' entry ports", async () => {
    await post(`/api/servers/${SERVER_ID}/preflight`);
    store.entryPorts = [8101];
    const res = await get(`/api/servers/${SERVER_ID}/free-port`);
    const body = await res.json();
    expect(body.port).toBe(8102);
    expect(body.preflightAt).toBeTruthy();
  });

  it("free-port works before any scan", async () => {
    store.entryPorts = [8100];
    const body = await (
      await get(`/api/servers/${SERVER_ID}/free-port`)
    ).json();
    expect(body).toEqual({ port: 8101, preflightAt: null });
  });
});

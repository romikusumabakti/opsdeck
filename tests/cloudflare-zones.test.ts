import { beforeEach, describe, expect, it, vi } from "vitest";

const TUNNEL_ID = "0197f3a0-1b2c-7def-8000-0123456789c1";
const ZONE_ROW_ID = "0197f3a0-1b2c-7def-8000-0123456789d1";
const ZONE_ID = "0123456789abcdef0123456789abcdef";

const state = vi.hoisted(() => ({
  role: "admin" as string,
  // The zone's own token, stored encrypted; null means "use the account's".
  zoneToken: null as string | null,
  // The account's decrypted token, or null when no account is set up.
  accountToken: null as string | null,
  inserted: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/authz", async () => {
  const { canOrg } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    requireOrgPermission: vi.fn(async (perms: Parameters<typeof canOrg>[1]) => {
      if (!canOrg(state.role as "admin", perms)) {
        throw new HTTPException(403, { message: "Forbidden" });
      }
      return { user: { id: "user-1", role: state.role } };
    }),
  };
});

vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));

vi.mock("@/server/services/cloudflare-account", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/services/cloudflare-account")
  >()),
  loadCloudflareAccount: vi.fn(async () =>
    state.accountToken
      ? {
          creds: { accountId: "acc", apiToken: state.accountToken },
          accessIdpId: null,
        }
      : null
  ),
}));

vi.mock("@/lib/domains/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/domains/repository")>()),
  getAccountRowId: vi.fn(async () =>
    state.accountToken ? "acc-row-1" : undefined
  ),
}));

// One tunnel joined to its server and zone, as loadTunnel selects it.
vi.mock("@/lib/db", async () => {
  const { encryptSecret } = await import("@/lib/secrets");
  const joined = () => [
    {
      tunnels: {
        id: TUNNEL_ID,
        name: "dss-apps-136",
        containerName: "cloudflared",
        stackDir: "/opt/cloudflared",
        configPath: "config.yml",
      },
      servers: {
        host: "10.0.0.136",
        username: "root",
        password: encryptSecret("ssh-password"),
      },
      cloudflare_zones: {
        zoneId: ZONE_ID,
        name: "example.com",
        apiToken: state.zoneToken,
      },
    },
  ];
  const chain = {
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => joined(),
  };
  return {
    db: {
      select: () => ({ from: () => chain }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          state.inserted = values;
          return { returning: async () => [{ id: ZONE_ROW_ID, ...values }] };
        },
      }),
    },
  };
});

// The host side of a route withdrawal always succeeds; only the DNS calls
// matter here.
vi.mock("@/lib/tunnels/remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tunnels/remote")>()),
  readRemoteText: vi.fn(async () => "ingress"),
  tunnelImage: vi.fn(async () => "cloudflare/cloudflared"),
  stageRemoteText: vi.fn(async () => "/tmp/staged"),
  validateIngressFile: vi.fn(async () => undefined),
  commitStagedFile: vi.fn(async () => undefined),
  applyStack: vi.fn(async () => undefined),
  assertConfigApplied: vi.fn(async () => undefined),
  waitForTunnelHealth: vi.fn(async () => ({ healthy: true })),
}));
vi.mock("@/lib/tunnels/ingress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tunnels/ingress")>()),
  removeRoute: vi.fn(() => "ingress without the route"),
}));

const cf = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/cloudflare/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cloudflare/request")>()),
  request: cf.request,
}));

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { encryptSecret } = await import("@/lib/secrets");
const { app } = await import("@/server/app");

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const withdraw = () =>
  post("/api/tunnels/delete-tunnel-route", {
    input: { tunnelId: TUNNEL_ID, hostname: "app.example.com" },
  });

const createZone = (extra: Record<string, unknown> = {}) =>
  post("/api/tunnels/create-cloudflare-zone", {
    data: { name: "example.com", zoneId: ZONE_ID, ...extra },
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.role = "admin";
  state.zoneToken = null;
  state.accountToken = "account-token";
  state.inserted = null;
  // findDnsRecord answers one record; deleteDnsRecord answers its id.
  cf.request.mockImplementation(async (_token: string, path: string) =>
    path.includes("?name=") ? [{ id: "rec-1" }] : { id: "rec-1" }
  );
});

describe("zone DNS token", () => {
  it("zone without token uses the account token", async () => {
    const res = await withdraw();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });

    // The lookup and the delete both ran, with the account's token.
    expect(cf.request).toHaveBeenCalledTimes(2);
    const [, deleteCall] = cf.request.mock.calls;
    expect(deleteCall?.[1]).toBe(`/zones/${ZONE_ID}/dns_records/rec-1`);
    expect(deleteCall?.[2]).toMatchObject({ method: "DELETE" });
    for (const [token] of cf.request.mock.calls) {
      expect(token).toBe("account-token");
    }
  });

  it("a zone's own token wins over the account's", async () => {
    state.zoneToken = encryptSecret("zone-token");
    expect((await withdraw()).status).toBe(200);
    for (const [token] of cf.request.mock.calls) {
      expect(token).toBe("zone-token");
    }
  });

  it("answers cloudflareNotConfigured without a zone token or an account", async () => {
    state.accountToken = null;
    const res = await withdraw();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: "cloudflareNotConfigured" });
    expect(JSON.stringify(body)).not.toContain('token"');
    expect(cf.request).not.toHaveBeenCalled();
  });

  it("the zone test falls back to the account token", async () => {
    cf.request.mockResolvedValue([]);
    const res = await post("/api/tunnels/test-cloudflare-zone", {
      input: { zoneId: ZONE_ID, id: ZONE_ROW_ID },
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(cf.request).toHaveBeenCalledWith(
      "account-token",
      `/zones/${ZONE_ID}/dns_records?per_page=1`
    );
  });
});

describe("POST /api/tunnels/create-cloudflare-zone", () => {
  it("zone form token optional when an account exists", async () => {
    const res = await createZone();
    expect(await res.json()).toMatchObject({
      success: true,
      data: { id: ZONE_ROW_ID },
    });
    expect(state.inserted).toMatchObject({
      name: "example.com",
      zoneId: ZONE_ID,
      apiToken: null,
    });
  });

  it("still stores a zone's own token, encrypted", async () => {
    await createZone({ apiToken: "zone-token" });
    expect(state.inserted?.apiToken).toEqual(expect.any(String));
    expect(state.inserted?.apiToken).not.toBe("zone-token");
  });

  it("requires a token when no account is set up", async () => {
    state.accountToken = null;
    const res = await createZone();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "cloudflareNotConfigured" });
    expect(state.inserted).toBeNull();
  });
});

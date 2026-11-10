import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/environments/:id/domain/adopt against a fake Cloudflare API (the
// real lib/cloudflare/api over a stubbed fetch) and a fake domain repository.

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const RT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";
const ZONE_ROW = "0197f3a0-1b2c-7def-8000-0123456789a1";
const CF_ZONE = "cf-zone-1";
const CF_TUNNEL = "6ff42ae2-765d-4adf-8112-31c55c1551ef";
const OTHER_TUNNEL = "11111111-2222-4333-8444-555555555555";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-token-very-secret-0123456789";
const HOST = "portal.dssconsulting.id";
const SERVICE = "http://dplk-customer-portal-frontend:80";

type DnsRecord = {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
};
type App = {
  id: string;
  name: string;
  domain: string;
  self_hosted_domains?: string[];
};

const cf = vi.hoisted(() => ({
  records: [] as DnsRecord[],
  apps: [] as App[],
  config: {} as Record<string, unknown>,
  puts: [] as Record<string, unknown>[],
  writes: [] as string[],
  fail: false,
}));

const state = vi.hoisted(() => ({
  orgRole: "admin" as string,
  existing: undefined as Record<string, unknown> | undefined,
  takenHostnames: [] as string[],
  adopted: null as null | { environmentId: string; row: unknown },
  adoptResult: "saved" as string,
  tearingDown: false,
  adoptError: null as unknown,
  lockKeys: [] as string[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "user-1", role: state.orgRole },
  })),
}));

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

// The Cloudflare account row, read by server/services/cloudflare-account.
vi.mock("@/lib/db", async () => {
  const { encryptSecret } = await import("@/lib/secrets");
  const row = {
    id: "acc-1",
    accountId: ACCOUNT_ID,
    name: "DSS",
    apiToken: encryptSecret(TOKEN),
    accessIdpId: "idp-1",
  };
  return {
    db: {
      select: () => ({ from: () => ({ limit: async () => [row] }) }),
    },
  };
});

vi.mock("@/lib/provisioning/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provisioning/repository")>()),
  withAdvisoryXactLock: vi.fn(async (key: string, fn: () => unknown) => {
    state.lockKeys.push(key);
    return fn();
  }),
}));

vi.mock("@/lib/teardown/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/teardown/guard")>()),
  teardownBlocks: vi.fn(async () => state.tearingDown),
}));

vi.mock("@/lib/domains/repository", () => ({
  getEnvironmentRow: vi.fn(async (id: string) =>
    id === ENV_ID ? { id, name: "Portal Dev", entryPort: null } : undefined
  ),
  getDomain: vi.fn(async () => state.existing),
  hostnameTakenByOther: vi.fn(async (hostname: string) =>
    state.takenHostnames.includes(hostname)
  ),
  listZones: vi.fn(async () => [
    { id: "zone-other", name: "example.com" },
    { id: ZONE_ROW, name: "dssconsulting.id" },
  ]),
  getZoneCloudflareId: vi.fn(async (id: string) =>
    id === ZONE_ROW ? CF_ZONE : "cf-zone-other"
  ),
  getRemoteTunnel: vi.fn(async (id: string) =>
    id === RT_ID
      ? { id: RT_ID, tunnelId: CF_TUNNEL, name: "dss-113", originHost: "x" }
      : undefined
  ),
  adoptDomain: vi.fn(async (environmentId: string, row: unknown) => {
    if (state.adoptError) throw state.adoptError;
    if (state.adoptResult !== "saved") return state.adoptResult;
    state.adopted = { environmentId, row };
    return "saved";
  }),
}));

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");

const { app } = await import("@/server/app");
const { hostnameTakenByOther } = await import("@/lib/domains/repository");

const ok = (result: unknown) =>
  new Response(
    JSON.stringify({
      success: true,
      errors: [],
      result,
      result_info: { total_pages: 1 },
    }),
    { status: 200 }
  );

function fakeCloudflare(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  const { pathname, searchParams } = new URL(url);
  if (cf.fail) {
    return new Response(
      JSON.stringify({
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
        result: null,
      }),
      { status: 403 }
    );
  }
  if (method !== "GET") cf.writes.push(`${method} ${pathname}`);
  if (pathname.endsWith(`/zones/${CF_ZONE}/dns_records`) && method === "GET") {
    const name = searchParams.get("name");
    return ok(cf.records.filter((r) => r.name === name));
  }
  if (pathname.endsWith("/access/apps") && method === "GET") {
    return ok(cf.apps);
  }
  if (pathname.endsWith(`/cfd_tunnel/${CF_TUNNEL}/configurations`)) {
    if (method === "GET") return ok({ config: cf.config });
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body));
      cf.puts.push(body.config);
      cf.config = body.config;
      return ok({});
    }
  }
  throw new Error(`unexpected request ${method} ${pathname}`);
}

const url = `/api/environments/${ENV_ID}/domain/adopt`;
const send = (body: unknown) =>
  app.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const body = (extra: Record<string, unknown> = {}) => ({
  hostname: HOST,
  remoteTunnelId: RT_ID,
  service: SERVICE,
  ...extra,
});

const tunnelRecord = (content = `${CF_TUNNEL}.cfargotunnel.com`) => ({
  id: "rec-1",
  name: HOST,
  type: "CNAME",
  content,
  proxied: true,
});
const catchAll = { service: "http_status:404" };

beforeEach(() => {
  vi.clearAllMocks();
  state.orgRole = "admin";
  state.existing = undefined;
  state.takenHostnames = [];
  state.adopted = null;
  state.adoptResult = "saved";
  state.tearingDown = false;
  state.adoptError = null;
  state.lockKeys = [];
  cf.records = [tunnelRecord()];
  cf.apps = [{ id: "app-1", name: "Portal", domain: HOST }];
  cf.config = {
    ingress: [{ hostname: "other.dssconsulting.id", service: "x" }, catchAll],
    warp_routing: { enabled: false },
  };
  cf.puts = [];
  cf.writes = [];
  cf.fail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string, init?: RequestInit) => fakeCloudflare(u, init))
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /domain/adopt", () => {
  it("stores the found DNS record and Access app and adds the missing route", async () => {
    const res = await send(body());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hostname: HOST });
    expect(state.adopted).toEqual({
      environmentId: ENV_ID,
      row: {
        kind: "tunnel",
        hostname: HOST,
        zoneId: ZONE_ROW,
        remoteTunnelId: RT_ID,
        accessPolicyId: null,
        accessAppId: "app-1",
        dnsRecordId: "rec-1",
      },
    });
    // The route goes in before the catch-all; nothing else is created.
    expect(cf.puts).toHaveLength(1);
    expect(cf.config).toEqual({
      ingress: [
        { hostname: "other.dssconsulting.id", service: "x" },
        { hostname: HOST, service: SERVICE },
        catchAll,
      ],
      warp_routing: { enabled: false },
    });
    expect(cf.writes).toEqual([
      `PUT /client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL}/configurations`,
    ]);
    expect(state.lockKeys).toEqual([`cf-tunnel:${CF_TUNNEL}`]);
    expect(activity.recordActivity).toHaveBeenCalledWith({
      actorId: "user-1",
      action: "environment.domain.adopted",
      entityType: "environment",
      entityId: ENV_ID,
      data: { environment: "Portal Dev", hostname: HOST },
    });
  });

  it("writes nothing to Cloudflare when the route is already there", async () => {
    cf.config = { ingress: [{ hostname: HOST, service: SERVICE }, catchAll] };
    const res = await send(body());
    expect(res.status).toBe(200);
    expect(cf.writes).toEqual([]);
    expect(state.adopted?.row).toMatchObject({
      accessAppId: "app-1",
      dnsRecordId: "rec-1",
    });
  });

  it("records no Access app when none covers the hostname, without creating one", async () => {
    cf.apps = [
      { id: "app-9", name: "Other", domain: "other.dssconsulting.id" },
    ];
    const res = await send(body());
    expect(res.status).toBe(200);
    expect(state.adopted?.row).toMatchObject({ accessAppId: null });
    expect(cf.writes.some((w) => w.includes("/access/apps"))).toBe(false);
  });

  it("refuses a CNAME on another tunnel", async () => {
    cf.records = [tunnelRecord(`${OTHER_TUNNEL}.cfargotunnel.com`)];
    const res = await send(body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("hostnameNotOnTunnel");
    expect(cf.writes).toEqual([]);
    expect(state.adopted).toBeNull();
  });

  it("refuses a hostname without a DNS record", async () => {
    cf.records = [];
    const res = await send(body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("hostnameNotOnTunnel");
    expect(state.adopted).toBeNull();
  });

  it("refuses a record that is not a CNAME", async () => {
    cf.records = [{ ...tunnelRecord(), type: "A", content: "203.0.113.7" }];
    const res = await send(body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("hostnameNotOnTunnel");
  });

  it("refuses a hostname bound to another environment", async () => {
    state.takenHostnames = [HOST];
    const res = await send(body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("domainHostnameTaken");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps a hostname race on insert to domainHostnameTaken", async () => {
    state.adoptError = Object.assign(new Error("duplicate"), { code: "23505" });
    const res = await send(body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("domainHostnameTaken");
  });

  it("refuses an environment that already has a domain", async () => {
    state.existing = { kind: "tunnel", hostname: "x.dssconsulting.id" };
    const res = await send(body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("domainProvisioned");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses when a row appeared meanwhile", async () => {
    state.adoptResult = "provisioned";
    const res = await send(body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("domainProvisioned");
  });

  it("refuses with teardownRunning before any Cloudflare call while a teardown is under way", async () => {
    state.tearingDown = true;
    const res = await send(body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("teardownRunning");
    expect(fetch).not.toHaveBeenCalled();
    expect(state.adopted).toBeNull();
  });

  it("refuses with teardownRunning when a teardown started before the write", async () => {
    state.adoptResult = "tearingDown";
    const res = await send(body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("teardownRunning");
  });

  it("removes the route it added when the write is refused or races", async () => {
    const before = structuredClone(cf.config);
    for (const refuse of [
      () => {
        state.adoptResult = "tearingDown";
      },
      () => {
        state.adoptResult = "provisioned";
      },
      () => {
        state.adoptError = Object.assign(new Error("duplicate"), {
          code: "23505",
        });
      },
    ]) {
      state.adoptResult = "saved";
      state.adoptError = null;
      cf.puts = [];
      refuse();
      const res = await send(body());
      expect(res.status).toBe(409);
      // Added, then taken out again: the config is as it was.
      expect(cf.puts).toHaveLength(2);
      expect(cf.config).toEqual(before);
    }
  });

  it("leaves the route when a concurrent adopt recorded the hostname meanwhile", async () => {
    state.adoptError = Object.assign(new Error("duplicate"), { code: "23505" });
    // The other adopt's row exists once the write raced: only the undo sees it.
    vi.mocked(hostnameTakenByOther)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const res = await send(body());
    expect(res.status).toBe(409);
    expect(cf.puts).toHaveLength(1);
    expect(cf.config).toMatchObject({
      ingress: expect.arrayContaining([{ hostname: HOST, service: SERVICE }]),
    });
  });

  it("leaves a route that was already there when the write is refused", async () => {
    cf.config = { ingress: [{ hostname: HOST, service: SERVICE }, catchAll] };
    state.adoptResult = "tearingDown";
    const res = await send(body());
    expect(res.status).toBe(409);
    expect(cf.writes).toEqual([]);
    expect(cf.config).toEqual({
      ingress: [{ hostname: HOST, service: SERVICE }, catchAll],
    });
  });

  it("adopts an app matched only through a destination, without a domain", async () => {
    cf.apps = [
      {
        id: "app-d",
        name: "Portal",
        destinations: [{ type: "public", uri: HOST }],
      } as unknown as App,
    ];
    const res = await send(body());
    expect(res.status).toBe(200);
    expect(state.adopted?.row).toMatchObject({ accessAppId: "app-d" });
  });

  it("does not count a path on the same hostname as another hostname", async () => {
    cf.apps = [
      {
        id: "app-1",
        name: "Portal",
        domain: HOST,
        destinations: [
          { type: "public", uri: HOST },
          { type: "public", uri: `${HOST}/admin` },
        ],
      } as unknown as App,
    ];
    const res = await send(body());
    expect(res.status).toBe(200);
    expect(state.adopted?.row).toMatchObject({ accessAppId: "app-1" });
  });

  it("refuses an engineer (no org server:manage)", async () => {
    state.orgRole = "member";
    const res = await send(body());
    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.adopted).toBeNull();
  });

  it("refuses a hostname outside the registered zones", async () => {
    const res = await send(body({ hostname: "portal.elsewhere.org" }));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("domainUnknownZone");
  });

  it("refuses an unknown remote tunnel", async () => {
    const res = await send(
      body({ remoteTunnelId: "0197f3a0-1b2c-7def-8000-0123456789ff" })
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("tunnelUnknown");
  });

  it("refuses a route that sends the hostname to another service", async () => {
    cf.config = {
      ingress: [{ hostname: HOST, service: "http://other:80" }, catchAll],
    };
    const res = await send(body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("domainRouteConflict");
    expect(cf.writes).toEqual([]);
    expect(state.adopted).toBeNull();
  });

  it("refuses a tunnel config it may not edit", async () => {
    cf.config = {
      ingress: [{ hostname: "other.dssconsulting.id", service: "x" }],
    };
    const res = await send(body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("domainTunnelConfigUnsafe");
    expect(cf.writes).toEqual([]);
  });

  it("refuses when several Access apps cover the hostname", async () => {
    cf.apps = [
      { id: "app-1", name: "Portal", domain: HOST },
      { id: "app-2", name: "Portal 2", domain: HOST },
    ];
    const res = await send(body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("domainAccessAppAmbiguous");
    expect(state.adopted).toBeNull();
  });

  it("refuses an Access app that also covers other hostnames", async () => {
    cf.apps = [
      {
        id: "app-1",
        name: "Portal",
        domain: HOST,
        self_hosted_domains: [HOST, "cms.dssconsulting.id"],
      },
    ];
    const res = await send(body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("domainAccessAppShared");
    expect(state.adopted).toBeNull();
  });

  it("passes a Cloudflare failure on as a bad gateway without the token", async () => {
    cf.fail = true;
    const res = await send(body());
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
    expect(state.adopted).toBeNull();
  });

  it.each([
    "dplk-customer-portal-frontend:80",
    "http://host",
    "http://host:80/path",
    "http://ho st:80",
    "http_status:404",
    "http://host:99999",
  ])("rejects the service %s", async (service) => {
    const res = await send(body({ service }));
    expect(res.status).toBe(400);
    expect(state.adopted).toBeNull();
  });

  it("rejects an invalid hostname", async () => {
    const res = await send(body({ hostname: "not a host" }));
    expect(res.status).toBe(400);
  });
});

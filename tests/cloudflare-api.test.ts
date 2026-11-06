import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudflareApiError,
  CloudflareConflictError,
  createAccessApp,
  createProxiedCname,
  findAccessAppByDomain,
  findDnsRecord,
  getTunnelConfig,
  listAccessPolicies,
  listIdentityProviders,
  listTunnels,
  putTunnelConfig,
  type TunnelConfig,
  verifyAccount,
  withIngressRoute,
} from "@/lib/cloudflare/api";

const creds = { accountId: "a".repeat(32), apiToken: "SECRET-TOKEN-VALUE" };
const base = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}`;

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let responses: Response[];

function ok(result: unknown, info?: Record<string, unknown>) {
  return new Response(
    JSON.stringify({ success: true, errors: [], result, result_info: info }),
    { status: 200 }
  );
}

beforeEach(() => {
  calls = [];
  responses = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("verifyAccount", () => {
  it("counts tunnels and reads the Access policies", async () => {
    responses.push(ok([{ id: "t1" }], { total_count: 7 }), ok([]));
    expect(await verifyAccount(creds)).toEqual({ tunnels: 7 });
    expect(calls.map((c) => c.url)).toEqual([
      `${base}/cfd_tunnel?is_deleted=false&per_page=1`,
      `${base}/access/policies?per_page=1`,
    ]);
  });
});

describe("pagination", () => {
  it("listTunnels follows total_pages and maps remote_config", async () => {
    responses.push(
      ok([{ id: "t1", name: "one", status: "healthy", remote_config: true }], {
        total_pages: 2,
      }),
      ok([{ id: "t2", name: "two", status: "down" }], { total_pages: 2 })
    );
    expect(await listTunnels(creds)).toEqual([
      { id: "t1", name: "one", status: "healthy", remoteConfig: true },
      { id: "t2", name: "two", status: "down", remoteConfig: false },
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      `${base}/cfd_tunnel?is_deleted=false&page=1&per_page=100`,
      `${base}/cfd_tunnel?is_deleted=false&page=2&per_page=100`,
    ]);
  });

  it("lists policies and identity providers across pages", async () => {
    responses.push(
      ok(
        [
          {
            id: "p1",
            name: "Staff",
            decision: "allow",
            include: [{ email_domain: { domain: "x.id" } }],
            extra: 1,
          },
        ],
        { total_pages: 2 }
      ),
      ok(
        [
          {
            id: "p2",
            name: "Admins",
            decision: "bypass",
            include: [{ everyone: {} }],
          },
        ],
        { total_pages: 2 }
      ),
      ok([{ id: "i1", name: "Entra", type: "azureAD" }], { total_pages: 1 })
    );
    expect(await listAccessPolicies(creds)).toEqual([
      { id: "p1", name: "Staff", decision: "allow", everyone: false },
      { id: "p2", name: "Admins", decision: "bypass", everyone: true },
    ]);
    expect(await listIdentityProviders(creds)).toEqual([
      { id: "i1", name: "Entra", type: "azureAD" },
    ]);
    expect(calls[2]?.url).toBe(
      `${base}/access/identity_providers?page=1&per_page=100`
    );
  });
});

describe("tunnel configuration", () => {
  it("reads the config and writes the whole object back", async () => {
    const config = {
      ingress: [{ service: "http_status:404" }],
      "warp-routing": { enabled: false },
    };
    responses.push(ok({ tunnel_id: "t1", version: 3, config }), ok({}));
    const read = await getTunnelConfig(creds, "t1");
    expect(read).toEqual(config);
    await putTunnelConfig(creds, "t1", read);
    expect(calls[1]).toEqual({
      url: `${base}/cfd_tunnel/t1/configurations`,
      method: "PUT",
      body: { config },
    });
  });

  it("treats a missing config as an empty ingress", async () => {
    responses.push(ok({ tunnel_id: "t1", config: null }));
    expect(await getTunnelConfig(creds, "t1")).toEqual({ ingress: [] });
  });
});

// Shaped like the live dss-srv-113 tunnel.
const live113 = (): TunnelConfig => ({
  ingress: [
    {
      hostname: "panel.example.net",
      service: "http://localhost:80",
      originRequest: { httpHostHeader: "panel.example.net" },
    },
    { hostname: "ci.example.net", service: "http://localhost:8000" },
    { hostname: "hris.example.net", service: "http://localhost:8091" },
    { service: "http_status:404" },
  ],
  "warp-routing": { enabled: false },
  originRequest: {},
});

describe("withIngressRoute", () => {
  it("inserts before the catch-all and keeps everything else", () => {
    const original = live113();
    const { config, changed } = withIngressRoute(
      original,
      "hris-staging.example.net",
      "http://localhost:9001"
    );
    expect(changed).toBe(true);
    const expected = live113();
    expected.ingress.splice(3, 0, {
      hostname: "hris-staging.example.net",
      service: "http://localhost:9001",
    });
    expect(config).toEqual(expected);
    // Pure: the input is untouched.
    expect(original).toEqual(live113());
  });

  it("is a no-op for the same hostname and service", () => {
    const original = live113();
    const result = withIngressRoute(
      original,
      "ci.example.net",
      "http://localhost:8000"
    );
    expect(result.changed).toBe(false);
    expect(result.config).toEqual(live113());
  });

  it("throws a conflict when the hostname routes elsewhere", () => {
    expect(() =>
      withIngressRoute(live113(), "ci.example.net", "http://localhost:1")
    ).toThrow(CloudflareConflictError);
  });

  it("appends the rule and a catch-all when there is none", () => {
    const { config, changed } = withIngressRoute(
      { ingress: [{ hostname: "a.example.com", service: "http://x:1" }] },
      "b.example.com",
      "http://y:2"
    );
    expect(changed).toBe(true);
    expect(config.ingress).toEqual([
      { hostname: "a.example.com", service: "http://x:1" },
      { hostname: "b.example.com", service: "http://y:2" },
      { service: "http_status:404" },
    ]);
  });
});

describe("DNS", () => {
  it("finds a record by name", async () => {
    const record = {
      id: "r1",
      name: "x.example.com",
      type: "CNAME",
      content: "t1.cfargotunnel.com",
      proxied: true,
    };
    responses.push(ok([record]), ok([]));
    expect(await findDnsRecord(creds, "zone1", "x.example.com")).toEqual(
      record
    );
    expect(await findDnsRecord(creds, "zone1", "y.example.com")).toBeNull();
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/zones/zone1/dns_records?name=x.example.com"
    );
  });

  it("creates a proxied CNAME into the tunnel", async () => {
    responses.push(ok({ id: "r1" }));
    await createProxiedCname(
      creds,
      "zone1",
      "x.example.com",
      "t1",
      "opsdeck:e1"
    );
    expect(calls[0]).toEqual({
      url: "https://api.cloudflare.com/client/v4/zones/zone1/dns_records",
      method: "POST",
      body: {
        type: "CNAME",
        name: "x.example.com",
        content: "t1.cfargotunnel.com",
        proxied: true,
        comment: "opsdeck:e1",
      },
    });
  });
});

describe("Access apps", () => {
  it("finds an app by exact domain across pages", async () => {
    responses.push(
      ok([{ id: "1", name: "n", domain: "other.example.com" }], {
        total_pages: 2,
      }),
      ok(
        [
          { id: "2", name: "n", domain: "x.example.com/admin" },
          { id: "3", name: "n", domain: "x.example.com" },
        ],
        { total_pages: 2 }
      )
    );
    expect((await findAccessAppByDomain(creds, "x.example.com"))?.id).toBe("3");
  });

  it("returns null when no app matches", async () => {
    responses.push(ok([], { total_pages: 1 }));
    expect(await findAccessAppByDomain(creds, "x.example.com")).toBeNull();
  });

  it("creates a self-hosted app bound to one policy and IdP", async () => {
    responses.push(ok({ id: "app1", name: "opsdeck:e1", domain: "x" }));
    await createAccessApp(creds, {
      name: "opsdeck:e1",
      domain: "x.example.com",
      policyId: "pol1",
      idpId: "idp1",
    });
    expect(calls[0]).toEqual({
      url: `${base}/access/apps`,
      method: "POST",
      body: {
        name: "opsdeck:e1",
        domain: "x.example.com",
        type: "self_hosted",
        allowed_idps: ["idp1"],
        auto_redirect_to_identity: true,
        policies: [{ id: "pol1", precedence: 1 }],
      },
    });
  });
});

describe("errors", () => {
  it("sends the token as a bearer header only", async () => {
    responses.push(ok([]));
    await listAccessPolicies(creds);
    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${creds.apiToken}`
    );
  });

  it("never puts the token in a thrown message", async () => {
    responses.push(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
          result: null,
        }),
        { status: 403 }
      )
    );
    const api = await listTunnels(creds).catch((e) => e);
    expect(api).toBeInstanceOf(CloudflareApiError);
    expect(api.message).toBe("Authentication error (code 10000)");
    expect(api.message).not.toContain(creds.apiToken);

    vi.mocked(fetch).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const net = await listTunnels(creds).catch((e) => e);
    expect(net).toBeInstanceOf(CloudflareApiError);
    expect(net.message).not.toContain(creds.apiToken);

    responses.push(new Response("<html>", { status: 502 }));
    const html = await listTunnels(creds).catch((e) => e);
    expect(html.message).toBe(
      "Cloudflare API returned 502 with a non-JSON body"
    );
  });
});

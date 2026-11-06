import { beforeEach, describe, expect, it, vi } from "vitest";

// The Cloudflare provisioning steps against an in-memory Cloudflare account.
// withIngressRoute and the error classes are the real ones; the HTTP calls and
// the database are fakes. The advisory lock is a real mutex per key, so the
// interleaving test fails if a step reads the config outside the lock.

const TOKEN = "cf-token-very-secret-0123456789";
const ENV_A = "0197f3a0-1b2c-7def-8000-0000000000a1";
const ENV_B = "0197f3a0-1b2c-7def-8000-0000000000b1";
const RUN_ID = "0197f3a0-1b2c-7def-8000-0000000000r1";
const CF_TUNNEL = "6ff42ae2-765d-4adf-8112-31c55c1551ef";
const HOST_A = "hris-staging.example.net";
const HOST_B = "hris-qa.example.net";

type Record_ = {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  comment?: string | null;
};

const cf = vi.hoisted(() => ({
  config: { ingress: [] as Record<string, unknown>[] } as Record<
    string,
    unknown
  >,
  gets: [] as string[][],
  puts: 0,
  apps: [] as { id: string; name: string; domain: string }[],
  records: [] as Record_[],
  writes: [] as string[],
  accessIdpId: "idp-1" as string | null,
  failWith: null as null | string,
  seq: 0,
}));

const db = vi.hoisted(() => ({
  lockKeys: [] as string[],
  domains: {} as Record<
    string,
    { accessAppId: string | null; dnsRecordId: string | null }
  >,
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const hostnames = (config: Record<string, unknown>) =>
  (config.ingress as { hostname?: string }[]).map((r) => r.hostname ?? "*");

vi.mock("@/lib/cloudflare/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cloudflare/api")>();
  const maybeFail = () => {
    if (cf.failWith) throw new actual.CloudflareApiError(cf.failWith);
  };
  return {
    ...actual,
    getTunnelConfig: vi.fn(async (creds: { apiToken: string }) => {
      expect(creds.apiToken).toBe(TOKEN);
      maybeFail();
      const snapshot = structuredClone(cf.config);
      await tick();
      cf.gets.push(hostnames(snapshot));
      return snapshot;
    }),
    putTunnelConfig: vi.fn(
      async (
        _c: unknown,
        tunnelId: string,
        config: Record<string, unknown>
      ) => {
        expect(tunnelId).toBe(CF_TUNNEL);
        await tick();
        cf.config = structuredClone(config);
        cf.puts++;
        cf.writes.push("put_tunnel");
      }
    ),
    findAccessAppByDomain: vi.fn(async (_c: unknown, domain: string) => {
      maybeFail();
      return cf.apps.find((a) => a.domain === domain) ?? null;
    }),
    createAccessApp: vi.fn(
      async (
        _c: unknown,
        app: { name: string; domain: string; policyId: string; idpId: string }
      ) => {
        const created = {
          id: `app-${++cf.seq}`,
          name: app.name,
          domain: app.domain,
        };
        cf.apps.push(created);
        cf.writes.push("create_app");
        return created;
      }
    ),
    findDnsRecord: vi.fn(async (_c: unknown, zoneId: string, name: string) => {
      expect(zoneId).toBe("cf-zone-1");
      maybeFail();
      return cf.records.find((r) => r.name === name) ?? null;
    }),
    createProxiedCname: vi.fn(
      async (
        _c: unknown,
        _zone: string,
        name: string,
        tunnelId: string,
        comment: string
      ) => {
        const created = {
          id: `rec-${++cf.seq}`,
          name,
          type: "CNAME",
          content: `${tunnelId}.cfargotunnel.com`,
          proxied: true,
          comment,
        };
        cf.records.push(created);
        cf.writes.push("create_dns");
        return created;
      }
    ),
  };
});

vi.mock("@/server/services/cloudflare-account", () => ({
  loadCloudflareAccount: async () => ({
    creds: { accountId: "a".repeat(32), apiToken: TOKEN },
    accessIdpId: cf.accessIdpId,
  }),
}));

vi.mock("@/lib/domains/repository", () => ({
  getRemoteTunnel: async (id: string) =>
    id === "rt-1"
      ? {
          id: "rt-1",
          tunnelId: CF_TUNNEL,
          name: "dss-srv-113",
          originHost: "localhost",
        }
      : undefined,
  getZoneCloudflareId: async (id: string) =>
    id === "zone-row-1" ? "cf-zone-1" : undefined,
  setDomainAccessAppId: async (env: string, accessAppId: string) => {
    db.domains[env] = {
      dnsRecordId: null,
      ...db.domains[env],
      accessAppId,
    };
  },
  setDomainDnsRecordId: async (env: string, dnsRecordId: string) => {
    db.domains[env] = {
      accessAppId: null,
      ...db.domains[env],
      dnsRecordId,
    };
  },
}));

// A mutex per key stands in for pg_advisory_xact_lock.
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  db.lockKeys.push(key);
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.then(fn, fn);
  locks.set(
    key,
    current.catch(() => {})
  );
  return current;
}

type Step = {
  id: string;
  position: number;
  kind: string;
  params: Record<string, unknown>;
  status: "pending" | "running" | "done" | "failed";
  lastError: string | null;
};
const job = vi.hoisted(() => ({
  steps: [] as Step[],
  log: [] as string[],
  run: null as null | { status: string; error?: string },
}));

vi.mock("@/lib/provisioning/repository", () => ({
  withAdvisoryXactLock: (key: string, fn: () => Promise<unknown>) =>
    withLock(key, fn),
  getProvisionRun: async () => ({
    environmentId: ENV_A,
    userId: "u1",
    status: job.run?.status ?? "started",
  }),
  failRunningSteps: async () => {},
  listSteps: async () =>
    [...job.steps]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ ...s })),
  markStep: async (
    id: string,
    status: Step["status"],
    opts: { error?: string }
  ) => {
    const step = job.steps.find((s) => s.id === id);
    if (step) {
      step.status = status;
      step.lastError = opts.error ?? null;
    }
  },
  loadDatabaseHost: async () => null,
  findNewestBuild: async () => null,
}));
vi.mock("@/lib/run-progress", () => ({
  appendRunOutput: async (_id: string, line: string) => {
    job.log.push(line);
  },
  completeRun: async () => {
    job.run = { status: "success" };
    return true;
  },
  failRun: async (_id: string, error: string) => {
    job.run = { status: "failed", error };
    return true;
  },
}));
vi.mock("@/lib/provisioning/database", () => ({
  redactSecrets: (m: string, secrets: string[]) =>
    secrets.reduce((acc, s) => acc.split(s).join("[redacted]"), m),
  provisionSharedDatabase: vi.fn(),
}));
vi.mock("@/lib/secrets", () => ({ decryptSecret: (v: string) => v }));
vi.mock("@/lib/environments", () => ({ loadServerCredentials: vi.fn() }));
vi.mock("@/lib/ssh", () => ({ executeRemoteCommand: vi.fn() }));
vi.mock("@/lib/variables/repository", () => ({ getVariable: vi.fn() }));
vi.mock("@/lib/deploy/repository", () => ({ getTarget: vi.fn() }));
vi.mock("@/server/services/deployments", () => ({
  requestDeployment: vi.fn(),
}));

const { tunnelRoute, accessApp, dnsRecord } = await import(
  "@/lib/jobs/provision-cloudflare"
);
const { runProvisioning } = await import("@/lib/jobs/provision");

const ctx = (environmentId = ENV_A) => ({ environmentId, secrets: [] });
const route = (hostname: string, service = "http://localhost:8091") => ({
  remoteTunnelId: "rt-1",
  hostname,
  service,
});
const live = () => ({
  "warp-routing": { enabled: false },
  ingress: [
    { hostname: "panel.example.net", service: "http://localhost:8000" },
    {
      service: "http_status:404",
      originRequest: { noTLSVerify: true },
    },
  ],
});

beforeEach(() => {
  cf.config = live();
  cf.gets = [];
  cf.puts = 0;
  cf.apps = [];
  cf.records = [];
  cf.writes = [];
  cf.accessIdpId = "idp-1";
  cf.failWith = null;
  cf.seq = 0;
  db.lockKeys = [];
  db.domains = {};
  job.steps = [];
  job.log = [];
  job.run = null;
  locks.clear();
});

describe("tunnel_route", () => {
  it("serializes concurrent edits of one tunnel so no route is lost", async () => {
    await Promise.all([
      tunnelRoute(ctx(ENV_A), route(HOST_A)),
      tunnelRoute(ctx(ENV_B), route(HOST_B, "http://localhost:8092")),
    ]);
    expect(hostnames(cf.config)).toEqual([
      "panel.example.net",
      HOST_A,
      HOST_B,
      "*",
    ]);
    expect(cf.puts).toBe(2);
    // Same key for both, and the second GET saw the first PUT.
    expect(db.lockKeys).toEqual([
      `cf-tunnel:${CF_TUNNEL}`,
      `cf-tunnel:${CF_TUNNEL}`,
    ]);
    expect(cf.gets[1]).toContain(HOST_A);
    // Unknown keys and the catch-all survive.
    expect(cf.config["warp-routing"]).toEqual({ enabled: false });
    expect((cf.config.ingress as unknown[]).at(-1)).toEqual(
      live().ingress.at(-1)
    );
  });

  it("writes nothing when the route is already there", async () => {
    await tunnelRoute(
      ctx(),
      route("panel.example.net", "http://localhost:8000")
    );
    expect(cf.writes).toEqual([]);
  });

  it("fails without a write when the hostname routes elsewhere", async () => {
    await expect(
      tunnelRoute(ctx(), route("PANEL.example.net", "http://localhost:9"))
    ).rejects.toThrow(
      "PANEL.example.net already routes to http://localhost:8000"
    );
    expect(cf.writes).toEqual([]);
  });
});

describe("access_app", () => {
  const params = { hostname: HOST_A, policyId: "pol-1" };

  it("creates a Panel-tagged app and stores its id", async () => {
    await accessApp(ctx(), params);
    expect(cf.apps).toEqual([
      { id: "app-1", name: `opsdeck:${ENV_A}`, domain: HOST_A },
    ]);
    expect(db.domains[ENV_A]?.accessAppId).toBe("app-1");
  });

  it("reuses the tagged app on a retry and creates no second one", async () => {
    await accessApp(ctx(), params);
    db.domains = {};
    await accessApp(ctx(), params);
    expect(cf.writes).toEqual(["create_app"]);
    expect(cf.apps).toHaveLength(1);
    expect(db.domains[ENV_A]?.accessAppId).toBe("app-1");
  });

  it("fails without a write when another app covers the hostname", async () => {
    cf.apps = [{ id: "x", name: "HRIS (manual)", domain: HOST_A }];
    await expect(accessApp(ctx(), params)).rejects.toThrow(
      `Access app HRIS (manual) already covers ${HOST_A}`
    );
    expect(cf.writes).toEqual([]);
    expect(db.domains[ENV_A]).toBeUndefined();
  });

  it("does not take over another environment's tagged app", async () => {
    cf.apps = [{ id: "x", name: `opsdeck:${ENV_B}`, domain: HOST_A }];
    await expect(accessApp(ctx(), params)).rejects.toThrow(
      `Access app opsdeck:${ENV_B} already covers ${HOST_A}`
    );
    expect(cf.writes).toEqual([]);
  });

  it("fails before any call when the account has no identity provider", async () => {
    cf.accessIdpId = null;
    await expect(accessApp(ctx(), params)).rejects.toThrow(
      "Cloudflare account has no Access identity provider set"
    );
    expect(cf.writes).toEqual([]);
  });
});

describe("dns_record", () => {
  const params = {
    zoneId: "zone-row-1",
    hostname: HOST_A,
    remoteTunnelId: "rt-1",
  };
  const ours = (): Record_ => ({
    id: "rec-ours",
    name: HOST_A,
    type: "CNAME",
    content: `${CF_TUNNEL}.cfargotunnel.com`,
    proxied: true,
    comment: `opsdeck:${ENV_A}`,
  });

  it("creates a tagged proxied CNAME and stores its id", async () => {
    await dnsRecord(ctx(), params);
    expect(cf.records).toEqual([{ ...ours(), id: "rec-1" }]);
    expect(db.domains[ENV_A]?.dnsRecordId).toBe("rec-1");
  });

  it("reuses its own record without a write", async () => {
    cf.records = [ours()];
    await dnsRecord(ctx(), params);
    expect(cf.writes).toEqual([]);
    expect(db.domains[ENV_A]?.dnsRecordId).toBe("rec-ours");
  });

  it.each([
    ["an A record", { type: "A", content: "103.75.27.250", proxied: false }],
    ["an unproxied CNAME", { proxied: false }],
    ["a CNAME to another tunnel", { content: "other.cfargotunnel.com" }],
    ["a CNAME without the tag", { comment: null }],
    ["another environment's record", { comment: `opsdeck:${ENV_B}` }],
  ])("fails without a write on %s", async (_label, change) => {
    const record = { ...ours(), ...change };
    cf.records = [record];
    await expect(dnsRecord(ctx(), params)).rejects.toThrow(
      `DNS record ${record.type} ${record.content} already exists for ${HOST_A}`
    );
    expect(cf.writes).toEqual([]);
    expect(db.domains[ENV_A]).toBeUndefined();
  });
});

describe("in the provisioning run", () => {
  function seed(kinds: string[]) {
    const params: Record<string, Record<string, unknown>> = {
      tunnel_route: route(HOST_A),
      access_app: { hostname: HOST_A, policyId: "pol-1" },
      dns_record: {
        zoneId: "zone-row-1",
        hostname: HOST_A,
        remoteTunnelId: "rt-1",
      },
    };
    job.steps = kinds.map((kind, position) => ({
      id: `s${position}`,
      position,
      kind,
      params: params[kind] as Record<string, unknown>,
      status: "pending",
      lastError: null,
    }));
  }
  const run = () => runProvisioning({ environmentId: ENV_A, runId: RUN_ID });

  it("runs route, Access app and DNS record and stores both ids", async () => {
    seed(["tunnel_route", "access_app", "dns_record"]);
    await expect(run()).resolves.toEqual({ status: "success" });
    expect(job.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(cf.writes).toEqual(["put_tunnel", "create_app", "create_dns"]);
    expect(db.domains[ENV_A]).toEqual({
      accessAppId: "app-1",
      dnsRecordId: "rec-2",
    });
    expect(job.log.join("\n")).toContain(
      `tunnel_route ${HOST_A} → http://localhost:8091`
    );
  });

  it("resumes after a failed DNS step with the same Access app", async () => {
    seed(["tunnel_route", "access_app", "dns_record"]);
    cf.records = [
      {
        id: "foreign",
        name: HOST_A,
        type: "A",
        content: "1.2.3.4",
        proxied: false,
      },
    ];
    await expect(run()).resolves.toEqual({ status: "failed" });
    expect(job.steps.map((s) => s.status)).toEqual(["done", "done", "failed"]);
    expect(job.steps[2]?.lastError).toBe(
      `DNS record A 1.2.3.4 already exists for ${HOST_A}`
    );

    // The clash is removed by hand; the retry redoes only the DNS step.
    cf.records = [];
    job.run = null;
    await expect(run()).resolves.toEqual({ status: "success" });
    expect(cf.writes).toEqual(["put_tunnel", "create_app", "create_dns"]);
    expect(cf.apps).toHaveLength(1);
  });

  it("keeps the token out of the run output and the step error", async () => {
    seed(["tunnel_route"]);
    // A Cloudflare error that, against all odds, echoes the token.
    cf.failWith = `Invalid token ${TOKEN} (code 10000)`;
    await expect(run()).resolves.toEqual({ status: "failed" });
    const everything = [
      ...job.log,
      job.run?.error ?? "",
      ...job.steps.map((s) => s.lastError ?? ""),
    ].join("\n");
    expect(everything).toContain("(code 10000)");
    expect(everything).not.toContain(TOKEN);
  });
});

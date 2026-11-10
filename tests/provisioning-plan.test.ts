import { describe, expect, it, vi } from "vitest";

// savePlan runs against a fake transaction that records every write.
const writes = vi.hoisted(() => ({
  existing: [] as {
    id: string;
    kind: string;
    params: unknown;
    status: string;
  }[],
  deleted: [] as string[][],
  updates: [] as { set: Record<string, unknown>; ids: string[] }[],
  inserted: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/db", () => {
  const tx = {
    select: () => ({ from: () => ({ where: async () => writes.existing }) }),
    delete: () => ({
      where: async (cond: { ids?: string[] }) => {
        writes.deleted.push(cond.ids ?? []);
      },
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async (cond: { ids?: string[] }) => {
          writes.updates.push({ set, ids: cond.ids ?? [] });
        },
      }),
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        writes.inserted.push(row);
      },
    }),
  };
  return {
    db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) },
  };
});

// Capture the ids a where() clause targets instead of building SQL.
vi.mock("drizzle-orm", async () => {
  const actual =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    inArray: (_col: unknown, ids: string[]) => ({ ids }),
    eq: (_col: unknown, id: string) => ({ ids: [id] }),
  };
});

const { planProvisioning, ProvisioningPlanError, provisioningStepSpecSchema } =
  await import("@/lib/provisioning/plan");
const { savePlan } = await import("@/lib/provisioning/repository");

const target = (id: string, dir = "/opt/app") => ({
  id,
  serverId: "srv-1",
  deployDir: dir,
  sourceBranch: "main",
});
const shared = {
  dbKind: "shared",
  databaseHostId: "host-1",
  dbName: "hris_staging",
  dbRole: "hris_staging",
  dbPasswordVariable: "DB_PASSWORD",
};

describe("planProvisioning", () => {
  it("orders directory, database, deploy for a shared database", () => {
    const plan = planProvisioning({ targets: [target("t1")], db: shared });
    expect(plan.map((s) => s.kind)).toEqual([
      "prepare_deploy_dir",
      "create_database",
      "deploy",
    ]);
    expect(plan[1]).toEqual({
      kind: "create_database",
      params: {
        databaseHostId: "host-1",
        database: "hris_staging",
        role: "hris_staging",
        passwordVariable: "DB_PASSWORD",
      },
    });
    expect(plan[2]).toEqual({
      kind: "deploy",
      params: { targetId: "t1", branch: "main" },
    });
  });

  it.each(["container", "external", null])(
    "has no create_database for kind %s",
    (dbKind) => {
      const plan = planProvisioning({
        targets: [target("t1")],
        db: { ...shared, dbKind },
      });
      expect(plan.map((s) => s.kind)).toEqual(["prepare_deploy_dir", "deploy"]);
    }
  );

  it("skips the deploy of a target that already deployed successfully", () => {
    const plan = planProvisioning({
      targets: [{ ...target("t1"), deployed: true }, target("t2")],
      db: null,
    });
    expect(plan.filter((s) => s.kind === "deploy")).toEqual([
      { kind: "deploy", params: { targetId: "t2", branch: "main" } },
    ]);
  });

  it("has no create_database without a db service", () => {
    const plan = planProvisioning({ targets: [target("t1")], db: null });
    expect(plan.some((s) => s.kind === "create_database")).toBe(false);
  });

  it("prepares a shared directory once", () => {
    const plan = planProvisioning({
      targets: [target("t1"), target("t2")],
      db: null,
    });
    expect(plan.map((s) => s.kind)).toEqual([
      "prepare_deploy_dir",
      "deploy",
      "deploy",
    ]);
  });

  it("prepares each distinct directory", () => {
    const plan = planProvisioning({
      targets: [target("t1"), target("t2", "/opt/other")],
      db: null,
    });
    expect(plan.filter((s) => s.kind === "prepare_deploy_dir")).toHaveLength(2);
  });

  it("rejects a shared binding without a role", () => {
    expect(() =>
      planProvisioning({
        targets: [target("t1")],
        db: { ...shared, dbRole: null },
      })
    ).toThrowError(expect.objectContaining({ code: "missing_db_fields" }));
  });

  it("rejects a shared binding without a password variable", () => {
    expect(() =>
      planProvisioning({
        targets: [target("t1")],
        db: { ...shared, dbPasswordVariable: null },
      })
    ).toThrow(ProvisioningPlanError);
  });

  it("rejects an environment without targets", () => {
    expect(() => planProvisioning({ targets: [], db: null })).toThrowError(
      expect.objectContaining({ code: "no_targets" })
    );
  });
});

describe("planProvisioning with a domain", () => {
  const tunnel = {
    kind: "tunnel" as const,
    hostname: "hris-staging.example.net",
    zoneId: "zone-row-1",
    remoteTunnelId: "rt-1",
    originHost: "localhost",
    accessPolicyId: "pol-1",
    entryPort: 8091,
  };

  it("adds Access app, route and DNS record before the deploys", () => {
    const plan = planProvisioning({
      targets: [target("t1")],
      db: null,
      domain: tunnel,
    });
    // Access first: no route or record ever serves the hostname unprotected.
    expect(plan.map((s) => s.kind)).toEqual([
      "prepare_deploy_dir",
      "access_app",
      "tunnel_route",
      "dns_record",
      "deploy",
    ]);
    expect(plan.slice(1, 4)).toEqual([
      {
        kind: "access_app",
        params: {
          zoneId: "zone-row-1",
          remoteTunnelId: "rt-1",
          hostname: "hris-staging.example.net",
          policyId: "pol-1",
        },
      },
      {
        kind: "tunnel_route",
        params: {
          zoneId: "zone-row-1",
          remoteTunnelId: "rt-1",
          hostname: "hris-staging.example.net",
          service: "http://localhost:8091",
        },
      },
      {
        kind: "dns_record",
        params: {
          zoneId: "zone-row-1",
          hostname: "hris-staging.example.net",
          remoteTunnelId: "rt-1",
        },
      },
    ]);
  });

  it("puts the domain steps after the shared database", () => {
    const plan = planProvisioning({
      targets: [target("t1")],
      db: shared,
      domain: tunnel,
    });
    expect(plan.map((s) => s.kind)).toEqual([
      "prepare_deploy_dir",
      "create_database",
      "access_app",
      "tunnel_route",
      "dns_record",
      "deploy",
    ]);
  });

  it("has no access_app for a public binding", () => {
    const plan = planProvisioning({
      targets: [target("t1")],
      db: null,
      domain: { ...tunnel, accessPolicyId: null },
    });
    expect(plan.map((s) => s.kind)).toEqual([
      "prepare_deploy_dir",
      "tunnel_route",
      "dns_record",
      "deploy",
    ]);
  });

  it("adds no Cloudflare steps for an external binding", () => {
    const plan = planProvisioning({
      targets: [target("t1")],
      db: null,
      domain: {
        kind: "external",
        hostname: "hris.example.com",
        zoneId: null,
        remoteTunnelId: null,
        originHost: null,
        accessPolicyId: null,
        entryPort: null,
      },
    });
    expect(plan.map((s) => s.kind)).toEqual(["prepare_deploy_dir", "deploy"]);
  });

  it("rejects a tunnel binding without an entry port", () => {
    expect(() =>
      planProvisioning({
        targets: [target("t1")],
        db: null,
        domain: { ...tunnel, entryPort: null },
      })
    ).toThrowError(expect.objectContaining({ code: "missing_entry_port" }));
  });

  it("parses the stored domain steps back", () => {
    const plan = planProvisioning({
      targets: [target("t1")],
      db: null,
      domain: tunnel,
    });
    for (const spec of plan) {
      expect(provisioningStepSpecSchema.parse(spec)).toEqual(spec);
    }
  });
});

describe("savePlan", () => {
  const specs = planProvisioning({ targets: [target("t1")], db: null });

  function reset() {
    writes.deleted.length = 0;
    writes.updates.length = 0;
    writes.inserted.length = 0;
  }

  it("keeps an identical done step and inserts the rest", async () => {
    reset();
    writes.existing = [
      {
        id: "s-dir",
        kind: "prepare_deploy_dir",
        // Key order differs from the spec on purpose.
        params: { deployDir: "/opt/app", serverId: "srv-1" },
        status: "done",
      },
      {
        id: "s-deploy",
        kind: "deploy",
        params: { targetId: "t1", branch: "main" },
        status: "failed",
      },
    ];
    await savePlan("env-1", specs);
    expect(writes.deleted).toEqual([["s-deploy"]]);
    expect(writes.inserted).toHaveLength(1);
    expect(writes.inserted[0]).toMatchObject({ kind: "deploy", position: 1 });
    expect(writes.updates.at(-1)).toEqual({
      set: { position: 0 },
      ids: ["s-dir"],
    });
  });

  it("replaces a done step whose params changed", async () => {
    reset();
    writes.existing = [
      {
        id: "s-dir",
        kind: "prepare_deploy_dir",
        params: { serverId: "srv-1", deployDir: "/opt/old" },
        status: "done",
      },
    ];
    await savePlan("env-1", specs);
    expect(writes.deleted).toEqual([["s-dir"]]);
    expect(writes.inserted.map((r) => r.kind)).toEqual([
      "prepare_deploy_dir",
      "deploy",
    ]);
  });
});

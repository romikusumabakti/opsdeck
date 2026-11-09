import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { locales } from "@/i18n/locales";
import type { TeardownEnvironment } from "@/lib/teardown/repository";

// The teardown plan is pure (planTeardown); buildTeardownPlan only adds the
// environment's rows, faked here (the loader runs against Postgres in
// teardown-repository-scratch.test.ts).
const loaded = vi.hoisted(() => ({
  env: null as TeardownEnvironment | null,
}));

vi.mock("@/lib/teardown/repository", () => ({
  loadTeardownEnvironment: vi.fn(async () => loaded.env),
}));

const {
  buildTeardownPlan,
  isSafeDeployDir,
  normaliseDeployDir,
  planTeardown,
  teardownStepSpecSchema,
} = await import("@/lib/teardown/plan");
const { TEARDOWN_ERRORS } = await import("@/lib/teardown/errors");

const S1 = "server-1";
const S2 = "server-2";

function env(over: Partial<TeardownEnvironment> = {}): TeardownEnvironment {
  return {
    targets: [],
    otherTargets: [],
    dbServices: [],
    domain: null,
    ...over,
  };
}

beforeEach(() => {
  loaded.env = null;
});

describe("isSafeDeployDir", () => {
  it.each([
    "/",
    "/deployments",
    "/deployments/",
    "/opt",
    "/deployments/../etc",
    "/deployments/a/..",
    "/deployments/./a",
    "/deployments//a",
    "relative/x",
    "",
    "/deployments/a b",
    "/deployments/a\tb",
    "/deployments/a'b",
    '/deployments/a"b',
    "/deployments/a;rm",
    "/deployments/$(id)",
    "/deployments/`id`",
    "/deployments/a|b",
    "/deployments/a&b",
    "/deployments/a*",
    "/deployments/a\nb",
  ])("refuses %j", (dir) => {
    expect(isSafeDeployDir(dir)).toBe(false);
  });

  it.each([
    "/deployments/dplk-dms",
    "/opt/stacks/x",
    "/deployments/dplk-dms/",
    "/srv/app_1.2",
  ])("accepts %j", (dir) => {
    expect(isSafeDeployDir(dir)).toBe(true);
  });

  it("normalises a trailing slash away", () => {
    expect(normaliseDeployDir("/deployments/dplk-dms/")).toBe(
      "/deployments/dplk-dms"
    );
    expect(normaliseDeployDir("/deployments/dplk-dms//")).toBe(
      "/deployments/dplk-dms"
    );
    expect(normaliseDeployDir("/")).toBe("/");
  });
});

describe("planTeardown", () => {
  it("plans only delete_environment for an empty environment", () => {
    expect(planTeardown(env())).toEqual({
      steps: [{ kind: "delete_environment", params: {} }],
    });
  });

  it("plans one dir step of each kind for components sharing a dir", () => {
    const result = planTeardown(
      env({
        targets: [
          { serverId: S1, deployDir: "/deployments/dms" },
          { serverId: S1, deployDir: "/deployments/dms/" },
        ],
      })
    );
    expect(result).toEqual({
      steps: [
        {
          kind: "check_stack",
          params: { serverId: S1, deployDir: "/deployments/dms" },
        },
        {
          kind: "archive_deploy_dir",
          params: { serverId: S1, deployDir: "/deployments/dms" },
        },
        {
          kind: "stack_down",
          params: { serverId: S1, deployDir: "/deployments/dms" },
        },
        {
          kind: "remove_deploy_dir",
          params: { serverId: S1, deployDir: "/deployments/dms" },
        },
        { kind: "delete_environment", params: {} },
      ],
    });
  });

  it("keeps the same dir on two servers apart", () => {
    const result = planTeardown(
      env({
        targets: [
          { serverId: S1, deployDir: "/deployments/dms" },
          { serverId: S2, deployDir: "/deployments/dms" },
        ],
      })
    );
    expect("steps" in result && result.steps.map((s) => s.kind)).toEqual([
      "check_stack",
      "check_stack",
      "archive_deploy_dir",
      "archive_deploy_dir",
      "stack_down",
      "stack_down",
      "remove_deploy_dir",
      "remove_deploy_dir",
      "delete_environment",
    ]);
  });

  it("refuses a dir another environment uses on the same server", () => {
    expect(
      planTeardown(
        env({
          targets: [{ serverId: S1, deployDir: "/deployments/dms" }],
          otherTargets: [{ serverId: S1, deployDir: "/deployments/dms/" }],
        })
      )
    ).toEqual({ refusal: "deployDirShared" });
  });

  it("refuses a dir nested in or around another environment's dir", () => {
    for (const other of ["/deployments/dms/worker", "/deployments"]) {
      expect(
        planTeardown(
          env({
            targets: [{ serverId: S1, deployDir: "/deployments/dms" }],
            otherTargets: [{ serverId: S1, deployDir: other }],
          })
        )
      ).toEqual({ refusal: "deployDirShared" });
    }
  });

  it("ignores another environment's dir on a different server or a sibling dir", () => {
    const result = planTeardown(
      env({
        targets: [{ serverId: S1, deployDir: "/deployments/dms" }],
        otherTargets: [
          { serverId: S2, deployDir: "/deployments/dms" },
          { serverId: S1, deployDir: "/deployments/dms-2" },
        ],
      })
    );
    expect("steps" in result).toBe(true);
  });

  it("refuses an unsafe deploy dir", () => {
    for (const deployDir of ["/", "/deployments", "/deployments/../etc"]) {
      expect(
        planTeardown(env({ targets: [{ serverId: S1, deployDir }] }))
      ).toEqual({ refusal: "unsafeDeployDir" });
    }
  });

  it("refuses a db service that is not Postgres", () => {
    for (const dbType of ["mysql", "mssql", null] as const) {
      expect(
        planTeardown(
          env({ dbServices: [{ id: "svc-db", dbType, dbKind: "container" }] })
        )
      ).toEqual({ refusal: "databaseBackupUnsupported" });
    }
  });

  it("drops only a database on a shared host", () => {
    const result = planTeardown(
      env({
        dbServices: [
          { id: "svc-shared", dbType: "postgres", dbKind: "shared" },
          { id: "svc-stack", dbType: "postgres", dbKind: "container" },
        ],
      })
    );
    expect(result).toEqual({
      steps: [
        { kind: "archive_database", params: { serviceId: "svc-shared" } },
        { kind: "archive_database", params: { serviceId: "svc-stack" } },
        { kind: "drop_database", params: { serviceId: "svc-shared" } },
        { kind: "delete_environment", params: {} },
      ],
    });
  });

  it("removes only the Cloudflare objects whose ids are set", () => {
    const domain = {
      kind: "tunnel" as const,
      hostname: "dms.example.com",
      zoneId: "zone-1",
      remoteTunnelId: "tunnel-1",
      accessAppId: null,
      dnsRecordId: "rec-1",
    };
    expect(planTeardown(env({ domain }))).toEqual({
      steps: [
        {
          kind: "remove_tunnel_route",
          params: { remoteTunnelId: "tunnel-1", hostname: "dms.example.com" },
        },
        {
          kind: "remove_dns_record",
          params: { zoneId: "zone-1", recordId: "rec-1" },
        },
        { kind: "delete_environment", params: {} },
      ],
    });
  });

  it("plans nothing on Cloudflare for an external domain", () => {
    expect(
      planTeardown(
        env({
          domain: {
            kind: "external",
            hostname: "dms.example.org",
            zoneId: null,
            remoteTunnelId: null,
            accessAppId: null,
            dnsRecordId: null,
          },
        })
      )
    ).toEqual({ steps: [{ kind: "delete_environment", params: {} }] });
  });

  it("orders every step kind", () => {
    const result = planTeardown(
      env({
        targets: [
          { serverId: S1, deployDir: "/deployments/dms" },
          { serverId: S1, deployDir: "/deployments/dms" },
        ],
        dbServices: [{ id: "svc-db", dbType: "postgres", dbKind: "shared" }],
        domain: {
          kind: "tunnel",
          hostname: "dms.example.com",
          zoneId: "zone-1",
          remoteTunnelId: "tunnel-1",
          accessAppId: "app-1",
          dnsRecordId: "rec-1",
        },
      })
    );
    expect("steps" in result && result.steps.map((s) => s.kind)).toEqual([
      "check_stack",
      "archive_database",
      "archive_deploy_dir",
      "stack_down",
      "drop_database",
      "remove_tunnel_route",
      "remove_access_app",
      "remove_dns_record",
      "remove_deploy_dir",
      "delete_environment",
    ]);
    if ("steps" in result) {
      expect(
        result.steps.find((s) => s.kind === "remove_access_app")?.params
      ).toEqual({ zoneId: "zone-1", appId: "app-1" });
      for (const step of result.steps) {
        expect(teardownStepSpecSchema.parse(step)).toEqual(step);
      }
    }
  });
});

describe("buildTeardownPlan", () => {
  it("plans from the loaded environment", async () => {
    loaded.env = env({
      targets: [{ serverId: S1, deployDir: "/deployments/dms" }],
      otherTargets: [{ serverId: S1, deployDir: "/deployments/dms" }],
    });
    await expect(buildTeardownPlan("env-1")).resolves.toEqual({
      refusal: "deployDirShared",
    });
  });

  it("is null for an unknown environment", async () => {
    await expect(buildTeardownPlan("missing")).resolves.toBeNull();
  });
});

describe("teardownStepSpecSchema", () => {
  it("rejects an unsafe deploy dir read back from jsonb", () => {
    for (const kind of [
      "check_stack",
      "archive_deploy_dir",
      "stack_down",
      "remove_deploy_dir",
    ]) {
      expect(
        teardownStepSpecSchema.safeParse({
          kind,
          params: { serverId: S1, deployDir: "/deployments/../etc" },
        }).success
      ).toBe(false);
    }
  });

  it("rejects missing params and unknown kinds", () => {
    expect(
      teardownStepSpecSchema.safeParse({
        kind: "remove_dns_record",
        params: { zoneId: "zone-1" },
      }).success
    ).toBe(false);
    expect(
      teardownStepSpecSchema.safeParse({ kind: "deploy", params: {} }).success
    ).toBe(false);
  });
});

describe("teardown error messages", () => {
  const codes = [
    "deployDirShared",
    "databaseBackupUnsupported",
    "unsafeDeployDir",
    "environmentBusy",
    "teardownRunning",
    "databaseNotRegistered",
    "archiveFailed",
    "confirmNameMismatch",
    "environmentIsProduction",
    "productionConfirmRequired",
  ];

  it("defines every code", () => {
    expect(Object.keys(TEARDOWN_ERRORS).sort()).toEqual([...codes].sort());
  });

  for (const locale of locales) {
    it(`${locale} has a non-empty message per code`, () => {
      const messages = JSON.parse(
        readFileSync(`messages/${locale}.json`, "utf8")
      ) as { teardown?: { errors?: Record<string, unknown> } };
      const errors = messages.teardown?.errors ?? {};
      expect(Object.keys(errors).sort()).toEqual([...codes].sort());
      for (const code of codes) {
        expect(typeof errors[code], code).toBe("string");
        expect(String(errors[code]).trim().length, code).toBeGreaterThan(0);
      }
    });
  }
});

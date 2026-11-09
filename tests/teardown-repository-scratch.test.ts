import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The teardown loader and step storage against a real Panel database: the
// local scratch copy named by TEARDOWN_SCRATCH_DB (a migrated database in the
// opsdeck-postgres container), reached through its published port with the
// container's own superuser password, read from the container and never
// printed. Every fixture is named td-it/TDIT and removed.
//
//   TEARDOWN_SCRATCH_DB=teardown_scratch env -u SECRETS_KEY bun --bun vitest run --maxWorkers=3 tests/teardown-repository-scratch.test.ts
const scratchDb = process.env.TEARDOWN_SCRATCH_DB;
if (scratchDb) {
  const password = encodeURIComponent(
    execFileSync("podman", [
      "exec",
      "opsdeck-postgres",
      "printenv",
      "POSTGRES_PASSWORD",
    ])
      .toString()
      .trim()
  );
  process.env.DATABASE_URL = `postgres://postgres:${password}@127.0.0.1:5432/${scratchDb}`;
  process.env.SECRETS_KEY = Buffer.alloc(32, 9).toString("base64");
}

describe.skipIf(!scratchDb)("teardown repository on scratch", async () => {
  const { eq, inArray } = await import("drizzle-orm");
  const { db, pgClient } = await import("@/lib/db");
  const s = await import("@/lib/db/schema");
  const { encryptSecret } = await import("@/lib/secrets");
  const { buildTeardownPlan } = await import("@/lib/teardown/plan");
  const { listTeardownSteps, loadTeardownEnvironment, saveTeardownSteps } =
    await import("@/lib/teardown/repository");

  const ids = {
    project: "",
    app: "",
    ci: "",
    server: "",
    server2: "",
    serverAlias: "",
    account: "",
    zone: "",
    tunnel: "",
    env: "",
    other: "",
    dbService: "",
  };

  async function one<T>(rows: Promise<T[]>): Promise<T> {
    const [row] = await rows;
    if (!row) throw new Error("insert returned no row");
    return row;
  }

  async function cleanup() {
    const projectRows = await db
      .select({ id: s.projects.id })
      .from(s.projects)
      .where(eq(s.projects.key, "TDIT"));
    const projectIds = projectRows.map((p) => p.id);
    if (projectIds.length > 0) {
      await db
        .delete(s.environments)
        .where(inArray(s.environments.projectId, projectIds));
      await db.delete(s.projects).where(inArray(s.projects.id, projectIds));
    }
    await db
      .delete(s.appComponents)
      .where(inArray(s.appComponents.componentKey, ["td-it", "td-it-web"]));
    await db.delete(s.apps).where(eq(s.apps.appKey, "td-it"));
    await db.delete(s.ciConnections).where(eq(s.ciConnections.name, "td-it"));
    await db.delete(s.remoteTunnels).where(eq(s.remoteTunnels.name, "td-it"));
    await db
      .delete(s.cloudflareZones)
      .where(eq(s.cloudflareZones.name, "td-it.example"));
    await db
      .delete(s.cloudflareAccounts)
      .where(eq(s.cloudflareAccounts.name, "td-it"));
    await db
      .delete(s.servers)
      .where(
        inArray(s.servers.name, [
          "td-it server",
          "td-it server 2",
          "td-it server alias",
        ])
      );
  }

  async function server(name: string, host: string) {
    return (
      await one(
        db
          .insert(s.servers)
          .values({ name, host, username: "deploy", password: "unused" })
          .returning({ id: s.servers.id })
      )
    ).id;
  }

  async function environment(name: string) {
    return (
      await one(
        db
          .insert(s.environments)
          .values({
            projectId: ids.project,
            name,
            slug: name.toLowerCase().replace(/\s+/g, "-"),
            appId: ids.app,
          })
          .returning({ id: s.environments.id })
      )
    ).id;
  }

  beforeAll(async () => {
    await cleanup();
    ids.project = (
      await one(
        db
          .insert(s.projects)
          .values({ key: "TDIT", name: "Teardown IT" })
          .returning({ id: s.projects.id })
      )
    ).id;
    ids.ci = (
      await one(
        db
          .insert(s.ciConnections)
          .values({
            name: "td-it",
            provider: "woodpecker",
            forge: "bitbucket",
            baseUrl: "https://ci.example.test",
          })
          .returning({ id: s.ciConnections.id })
      )
    ).id;
    ids.app = (
      await one(
        db
          .insert(s.apps)
          .values({ appKey: "td-it", name: "Teardown IT" })
          .returning({ id: s.apps.id })
      )
    ).id;
    for (const componentKey of ["td-it", "td-it-web"]) {
      await db.insert(s.appComponents).values({
        componentKey,
        appId: ids.app,
        ciConnectionId: ids.ci,
        repoFullName: `example/${componentKey}`,
        bundleImage: `${componentKey}-deploy`,
        notifySecret: encryptSecret("notify"),
      });
    }
    ids.server = await server("td-it server", "192.0.2.20");
    ids.server2 = await server("td-it server 2", "192.0.2.21");
    // A second row for the first machine, as another login would add it.
    ids.serverAlias = await server("td-it server alias", " 192.0.2.20 ");
    ids.env = await environment("TD Main");
    ids.other = await environment("TD Other");
    await db.insert(s.deployTargets).values([
      {
        environmentId: ids.env,
        componentKey: "td-it",
        serverId: ids.server,
        sourceBranch: "main",
        deployDir: "/deployments/td-it",
        services: ["backend"],
      },
      {
        environmentId: ids.env,
        componentKey: "td-it-web",
        serverId: ids.server,
        sourceBranch: "main",
        deployDir: "/deployments/td-it/",
        services: ["frontend"],
      },
      {
        // Same dir, other server: not shared.
        environmentId: ids.other,
        componentKey: "td-it",
        serverId: ids.server2,
        sourceBranch: "main",
        deployDir: "/deployments/td-it",
        services: ["backend"],
      },
    ]);
    ids.dbService = (
      await one(
        db
          .insert(s.environmentServices)
          .values({
            environmentId: ids.env,
            role: "db",
            serverId: ids.server,
            serviceType: "docker",
            serviceName: "td-it-db",
            dbType: "postgres",
            dbKind: "container",
          })
          .returning({ id: s.environmentServices.id })
      )
    ).id;
    await db.insert(s.environmentServices).values({
      environmentId: ids.env,
      role: "backend",
      serverId: ids.server,
      serviceType: "docker",
      serviceName: "td-it-backend",
    });
  });

  afterAll(async () => {
    await cleanup();
    await pgClient().end();
  });

  it("loads targets, other environments' targets on the same servers and db services", async () => {
    const loaded = await loadTeardownEnvironment(ids.env);
    expect(loaded).toEqual({
      targets: [
        {
          serverId: ids.server,
          host: "192.0.2.20",
          deployDir: "/deployments/td-it",
        },
        {
          serverId: ids.server,
          host: "192.0.2.20",
          deployDir: "/deployments/td-it/",
        },
      ],
      // Every other environment's target; the planner matches by host.
      otherTargets: [{ host: "192.0.2.21", deployDir: "/deployments/td-it" }],
      otherDomains: [],
      dbServices: [
        { id: ids.dbService, dbType: "postgres", dbKind: "container" },
      ],
      domain: null,
    });
    await expect(loadTeardownEnvironment(crypto.randomUUID())).resolves.toBe(
      null
    );
  });

  it("plans one set of dir steps for the shared dir", async () => {
    const plan = await buildTeardownPlan(ids.env);
    expect(plan && "steps" in plan && plan.steps.map((st) => st.kind)).toEqual([
      "check_stack",
      "archive_database",
      "archive_deploy_dir",
      "stack_down",
      "remove_deploy_dir",
      "delete_environment",
    ]);
  });

  it("refuses once another environment uses the dir on the same machine", async () => {
    const third = await environment("TD Third");
    await db.insert(s.deployTargets).values({
      environmentId: third,
      componentKey: "td-it",
      // Another server row with the same host.
      serverId: ids.serverAlias,
      sourceBranch: "main",
      deployDir: "/deployments/td-it",
      services: ["backend"],
    });
    try {
      expect(
        (await loadTeardownEnvironment(ids.env))?.otherTargets
      ).toContainEqual({
        host: " 192.0.2.20 ",
        deployDir: "/deployments/td-it",
      });
      await expect(buildTeardownPlan(ids.env)).resolves.toEqual({
        refusal: "deployDirShared",
      });
    } finally {
      await db.delete(s.environments).where(eq(s.environments.id, third));
    }
  });

  it("loads the domain's Cloudflare ids", async () => {
    ids.account = (
      await one(
        db
          .insert(s.cloudflareAccounts)
          .values({
            name: "td-it",
            accountId: "acc-td-it",
            apiToken: encryptSecret("token"),
          })
          .returning({ id: s.cloudflareAccounts.id })
      )
    ).id;
    ids.zone = (
      await one(
        db
          .insert(s.cloudflareZones)
          .values({
            zoneId: "cf-zone-td-it",
            name: "td-it.example",
          })
          .returning({ id: s.cloudflareZones.id })
      )
    ).id;
    ids.tunnel = (
      await one(
        db
          .insert(s.remoteTunnels)
          .values({
            accountId: ids.account,
            serverId: ids.server,
            tunnelId: "cf-tunnel-td-it",
            name: "td-it",
          })
          .returning({ id: s.remoteTunnels.id })
      )
    ).id;
    await db.insert(s.environmentDomains).values({
      environmentId: ids.env,
      kind: "tunnel",
      hostname: "app.td-it.example",
      zoneId: ids.zone,
      remoteTunnelId: ids.tunnel,
      accessAppId: "cf-app-1",
      dnsRecordId: "cf-rec-1",
    });
    const loaded = await loadTeardownEnvironment(ids.env);
    expect(loaded?.domain).toEqual({
      kind: "tunnel",
      hostname: "app.td-it.example",
      zoneId: ids.zone,
      remoteTunnelId: ids.tunnel,
      accessAppId: "cf-app-1",
      dnsRecordId: "cf-rec-1",
    });
    expect(loaded?.otherDomains).toEqual([]);
  });

  it("loads another environment's domain that records the same Access app", async () => {
    await db.insert(s.environmentDomains).values({
      environmentId: ids.other,
      kind: "tunnel",
      hostname: "other.td-it.example",
      zoneId: ids.zone,
      remoteTunnelId: ids.tunnel,
      accessAppId: "cf-app-1",
      dnsRecordId: "cf-rec-other",
    });
    try {
      expect((await loadTeardownEnvironment(ids.env))?.otherDomains).toEqual([
        { accessAppId: "cf-app-1", dnsRecordId: "cf-rec-other" },
      ]);
      await expect(buildTeardownPlan(ids.env)).resolves.toEqual({
        refusal: "domainShared",
      });
    } finally {
      await db
        .delete(s.environmentDomains)
        .where(eq(s.environmentDomains.environmentId, ids.other));
    }
  });

  it("saves and lists steps in order, keeping finished ones on a re-save", async () => {
    const plan = await buildTeardownPlan(ids.env);
    if (!plan || !("steps" in plan)) throw new Error("expected steps");
    await saveTeardownSteps(ids.env, plan.steps);
    const saved = await listTeardownSteps(ids.env);
    expect(saved.map((st) => ({ kind: st.kind, params: st.params }))).toEqual(
      plan.steps
    );
    expect(saved.map((st) => st.position)).toEqual(plan.steps.map((_, i) => i));
    expect(saved.every((st) => st.status === "pending")).toBe(true);

    const first = saved[0];
    if (!first) throw new Error("expected a step");
    await db
      .update(s.teardownSteps)
      .set({ status: "done", completedAt: new Date() })
      .where(eq(s.teardownSteps.id, first.id));
    await saveTeardownSteps(ids.env, plan.steps);
    const resaved = await listTeardownSteps(ids.env);
    expect(resaved).toHaveLength(plan.steps.length);
    expect(resaved[0]?.id).toBe(first.id);
    expect(resaved[0]?.status).toBe("done");
  });
});

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
  const { and, eq, inArray } = await import("drizzle-orm");
  const { db, pgClient } = await import("@/lib/db");
  const s = await import("@/lib/db/schema");
  const { encryptSecret } = await import("@/lib/secrets");
  const { buildTeardownPlan } = await import("@/lib/teardown/plan");
  const {
    addArchiveFile,
    createArchive,
    deleteTeardownEnvironment,
    environmentExists,
    findOpenArchive,
    listTeardownSteps,
    loadArchiveSnapshot,
    loadStackGuard,
    loadTeardownDbService,
    loadTeardownEnvironment,
    saveTeardownSteps,
    deleteArchiveRow,
    environmentBusy,
    failStaleTeardownRuns,
    getArchive,
    latestTeardownRunId,
    listArchives,
    listPrunableArchives,
    loadTeardownSubject,
    startTeardownRun,
    teardownState,
  } = await import("@/lib/teardown/repository");
  const { cancelTeardownSteps } = await import("@/lib/teardown/repository");
  const { createRunUnlessTearingDown, teardownBlocks } = await import(
    "@/lib/teardown/guard"
  );

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
    await db
      .delete(s.environmentArchives)
      .where(eq(s.environmentArchives.projectName, "Teardown IT"));
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
      "archive_volumes",
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

  it("loads the run-time guard of one machine from current rows", async () => {
    const third = await environment("TD Third");
    const [dbHost] = await db
      .insert(s.databaseHosts)
      .values({
        serverId: ids.serverAlias,
        containerName: "td-it-shared-pg",
        backupPath: "/backups",
        label: "td-it shared",
      })
      .returning({ id: s.databaseHosts.id });
    await db.insert(s.deployTargets).values({
      environmentId: third,
      componentKey: "td-it",
      serverId: ids.serverAlias,
      sourceBranch: "main",
      deployDir: "/",
      services: ["backend"],
    });
    await db.insert(s.environmentServices).values([
      {
        // Same machine through the alias row: guarded.
        environmentId: third,
        role: "db",
        serverId: ids.serverAlias,
        serviceType: "docker",
        serviceName: "td-it-third-db",
        dbType: "postgres",
        dbKind: "container",
      },
      {
        // Another machine: not guarded.
        environmentId: ids.other,
        role: "db",
        serverId: ids.server2,
        serviceType: "docker",
        serviceName: "td-it-other-db",
        dbType: "postgres",
        dbKind: "container",
      },
    ]);
    try {
      const guard = await loadStackGuard(ids.env, ids.server);
      expect(guard).toEqual({
        otherDeployDirs: ["/"],
        databaseContainers: ["td-it-shared-pg", "td-it-third-db"],
      });
      await expect(loadStackGuard(ids.env, crypto.randomUUID())).resolves.toBe(
        null
      );
      await expect(loadTeardownDbService(ids.dbService)).resolves.toEqual({
        environmentId: ids.env,
        role: "db",
        dbType: "postgres",
        dbKind: "container",
        dbName: null,
        dbRole: null,
        databaseHostId: null,
        serverId: ids.server,
        serviceType: "docker",
        serviceName: "td-it-db",
      });
      await expect(loadTeardownDbService(crypto.randomUUID())).resolves.toBe(
        null
      );
    } finally {
      await db.delete(s.environments).where(eq(s.environments.id, third));
      await db
        .delete(s.environmentServices)
        .where(eq(s.environmentServices.serviceName, "td-it-other-db"));
      if (dbHost) {
        await db
          .delete(s.databaseHosts)
          .where(eq(s.databaseHosts.id, dbHost.id));
      }
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

  it("keeps one open archive, appends each file once, and closes it with the delete", async () => {
    const gone = await environment("TD Gone");
    await db.insert(s.teardownSteps).values({
      environmentId: gone,
      position: 0,
      kind: "delete_environment",
      params: {},
    });
    const run = await one(
      db
        .insert(s.runs)
        .values({
          environmentId: gone,
          kind: "teardown",
          description: "td-it teardown",
          status: "started",
          output: "",
          runAt: new Date(),
        })
        .returning({ id: s.runs.id })
    );

    await expect(loadArchiveSnapshot(gone)).resolves.toEqual({
      projectName: "Teardown IT",
      environmentName: "TD Gone",
      environmentSlug: "td-gone",
    });
    await expect(findOpenArchive(gone)).resolves.toBe(null);
    const archive = await createArchive({
      environmentId: gone,
      projectName: "Teardown IT",
      environmentName: "TD Gone",
      environmentSlug: "td-gone",
      expiresAt: new Date(Date.now() + 86_400_000),
      location: "local",
      keyPrefix: "/tmp/td-it/",
    });
    // A second open row for the environment is refused; the open one comes
    // back instead (a concurrent first archive step).
    const again = await createArchive({
      environmentId: gone,
      projectName: "Teardown IT",
      environmentName: "TD Gone",
      environmentSlug: "td-gone",
      expiresAt: new Date(Date.now() + 86_400_000),
      location: "s3",
      keyPrefix: "other/",
    });
    expect(again.id).toBe(archive.id);
    expect(again.location).toBe("local");
    await addArchiveFile(archive.id, { name: "db-x.dump", size: 10 });
    await addArchiveFile(archive.id, { name: "db-x.dump", size: 99 });
    await addArchiveFile(archive.id, { name: "deploy-x.tar.gz", size: 20 });
    const open = await findOpenArchive(gone);
    expect(open?.id).toBe(archive.id);
    expect(open?.files).toEqual([
      { name: "db-x.dump", size: 10 },
      { name: "deploy-x.tar.gz", size: 20 },
    ]);

    // An escrowed variable, not confirmed: nothing is written.
    const [escrowed] = await db
      .insert(s.environmentVariables)
      .values({
        environmentId: gone,
        name: "KEY",
        kind: "secret",
        value: encryptSecret("k"),
        escrow: true,
      })
      .returning({ id: s.environmentVariables.id });
    await expect(
      deleteTeardownEnvironment(gone, null, { escrowConfirmed: false })
    ).resolves.toEqual({ refusal: "environmentHasEscrowedVariables" });
    await expect(environmentExists(gone)).resolves.toBe(true);
    await expect(findOpenArchive(gone)).resolves.toMatchObject({
      id: archive.id,
    });
    await db
      .delete(s.environmentVariables)
      .where(eq(s.environmentVariables.id, (escrowed as { id: string }).id));

    const before = Date.now();
    await expect(
      deleteTeardownEnvironment(gone, null, { escrowConfirmed: false })
    ).resolves.toEqual({
      environmentName: "TD Gone",
      archiveId: archive.id,
    });
    // Recorded in the delete's transaction.
    const activity = await db
      .select()
      .from(s.activityLog)
      .where(eq(s.activityLog.entityId, gone));
    expect(activity.map((a) => ({ action: a.action, data: a.data }))).toEqual([
      {
        action: "environment.deleted",
        data: { environment: "TD Gone", archiveId: archive.id },
      },
    ]);
    await expect(environmentExists(gone)).resolves.toBe(false);
    const [kept] = await db
      .select()
      .from(s.environmentArchives)
      .where(eq(s.environmentArchives.id, archive.id));
    expect(kept?.completedAt).toBeInstanceOf(Date);
    expect(kept?.environmentId).toBe(gone);
    // Kept 30 days from the delete, not from the archive's creation.
    const day = 86_400_000;
    expect(kept?.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 30 * day - 5_000
    );
    expect(kept?.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 30 * day + 5_000
    );
    await expect(findOpenArchive(gone)).resolves.toBe(null);
    // The cascade took the steps and the run.
    await expect(listTeardownSteps(gone)).resolves.toEqual([]);
    const runs = await db
      .select({ id: s.runs.id })
      .from(s.runs)
      .where(eq(s.runs.id, run.id));
    expect(runs).toEqual([]);
    await expect(
      deleteTeardownEnvironment(gone, null, { escrowConfirmed: true })
    ).resolves.toBe(null);
    await db.delete(s.activityLog).where(eq(s.activityLog.entityId, gone));
  });

  async function startedRun(
    environmentId: string,
    kind:
      | "deploy"
      | "provision"
      | "backup"
      | "restore"
      | "mock_time"
      | "teardown",
    status: "started" | "failed" | "success" = "started"
  ) {
    return (
      await one(
        db
          .insert(s.runs)
          .values({
            environmentId,
            kind,
            description: "td-it run",
            status,
            output: "",
            runAt: new Date(),
          })
          .returning({ id: s.runs.id })
      )
    ).id;
  }

  it("loads what the delete API checks: name, kind and escrowed variables", async () => {
    const env = await environment("TD Subject");
    try {
      await expect(loadTeardownSubject(env)).resolves.toEqual({
        name: "TD Subject",
        kind: null,
        hasEscrowedVariables: false,
      });
      await db
        .update(s.environments)
        .set({ kind: "prod" })
        .where(eq(s.environments.id, env));
      await db.insert(s.environmentVariables).values([
        { environmentId: env, name: "PLAIN", kind: "plain", value: "a" },
        {
          environmentId: env,
          name: "KEY",
          kind: "secret",
          value: encryptSecret("b"),
          escrow: true,
        },
      ]);
      await expect(loadTeardownSubject(env)).resolves.toMatchObject({
        kind: "prod",
        hasEscrowedVariables: true,
      });
      await expect(loadTeardownSubject(crypto.randomUUID())).resolves.toBe(
        null
      );
    } finally {
      await db.delete(s.environments).where(eq(s.environments.id, env));
    }
  });

  it("is busy for a started deploy, provision, backup or restore run, or an active deploy lock", async () => {
    const env = await environment("TD Busy");
    try {
      await expect(environmentBusy(env)).resolves.toBe(false);
      // Not busy: other kinds, and finished runs.
      await startedRun(env, "mock_time");
      await startedRun(env, "deploy", "failed");
      await startedRun(env, "teardown");
      await expect(environmentBusy(env)).resolves.toBe(false);
      for (const kind of [
        "deploy",
        "provision",
        "backup",
        "restore",
      ] as const) {
        const id = await startedRun(env, kind);
        await expect(environmentBusy(env)).resolves.toBe(true);
        await db.delete(s.runs).where(eq(s.runs.id, id));
      }
      await db.insert(s.environmentDeployLocks).values({
        environmentId: env,
        reason: "td-it",
        expiresAt: new Date(Date.now() - 60_000),
      });
      await expect(environmentBusy(env)).resolves.toBe(false);
      await db
        .update(s.environmentDeployLocks)
        .set({ expiresAt: new Date(Date.now() + 60_000) })
        .where(eq(s.environmentDeployLocks.environmentId, env));
      await expect(environmentBusy(env)).resolves.toBe(true);
    } finally {
      await db.delete(s.environments).where(eq(s.environments.id, env));
    }
  });

  it("reports the teardown state and opens one teardown run at a time", async () => {
    const env = await environment("TD Run");
    try {
      await expect(teardownState(env)).resolves.toEqual({
        planned: false,
        running: false,
        progressed: false,
      });
      await expect(latestTeardownRunId(env)).resolves.toBe(null);
      await db.insert(s.teardownSteps).values([
        { environmentId: env, position: 0, kind: "check_stack", params: {} },
        {
          environmentId: env,
          position: 1,
          kind: "delete_environment",
          params: {},
        },
      ]);
      await expect(teardownState(env)).resolves.toEqual({
        planned: true,
        running: false,
        progressed: false,
      });

      // From a clean state, two at once: exactly one opens the run; the
      // other waits on the lock, then sees it.
      const results = await Promise.all([
        startTeardownRun(env, null, "start"),
        startTeardownRun(env, null, "start"),
      ]);
      const won = results.filter((r) => "runId" in r);
      expect(won).toHaveLength(1);
      expect(results.filter((r) => !("runId" in r))).toEqual([
        { refusal: "teardownRunning" },
      ]);
      const opened = won[0];
      if (!opened || !("runId" in opened)) throw new Error("expected a run");
      const [run] = await db
        .select()
        .from(s.runs)
        .where(eq(s.runs.id, opened.runId));
      expect(run).toMatchObject({ kind: "teardown", status: "started" });
      await expect(latestTeardownRunId(env)).resolves.toBe(opened.runId);
      await expect(teardownState(env)).resolves.toMatchObject({
        running: true,
      });
      await expect(teardownBlocks(env)).resolves.toBe(true);

      await db
        .update(s.runs)
        .set({ status: "failed" })
        .where(eq(s.runs.id, opened.runId));
      await expect(teardownBlocks(env)).resolves.toBe(false);
      await db
        .update(s.teardownSteps)
        .set({ status: "running" })
        .where(
          and(
            eq(s.teardownSteps.environmentId, env),
            eq(s.teardownSteps.position, 0)
          )
        );
      // A step left running counts as running too.
      for (const mode of ["start", "retry"] as const) {
        await expect(startTeardownRun(env, null, mode)).resolves.toEqual({
          refusal: "teardownRunning",
        });
      }
      await db
        .update(s.teardownSteps)
        .set({ status: "done" })
        .where(
          and(
            eq(s.teardownSteps.environmentId, env),
            eq(s.teardownSteps.position, 0)
          )
        );
      await expect(teardownState(env)).resolves.toEqual({
        planned: true,
        running: false,
        progressed: true,
      });
      // A done step blocks other work, and a fresh start under the lock.
      await expect(teardownBlocks(env)).resolves.toBe(true);
      await expect(startTeardownRun(env, null, "start")).resolves.toEqual({
        refusal: "teardownRunning",
      });

      const busy = await startedRun(env, "deploy");
      await expect(startTeardownRun(env, null, "retry")).resolves.toEqual({
        refusal: "environmentBusy",
      });
      await db.delete(s.runs).where(eq(s.runs.id, busy));
      const second = await startTeardownRun(env, null, "retry");
      expect("runId" in second && second.runId).not.toBe(opened.runId);
      await expect(latestTeardownRunId(env)).resolves.toBe(
        "runId" in second ? second.runId : null
      );
    } finally {
      await db.delete(s.environments).where(eq(s.environments.id, env));
    }
  });

  it("fails teardown runs left started at boot, and their running steps", async () => {
    const env = await environment("TD Stale");
    try {
      const stale = await startedRun(env, "teardown");
      const other = await startedRun(env, "deploy");
      await db.insert(s.teardownSteps).values([
        {
          environmentId: env,
          position: 0,
          kind: "check_stack",
          params: {},
          status: "done",
        },
        {
          environmentId: env,
          position: 1,
          kind: "archive_deploy_dir",
          params: {},
          status: "running",
        },
        {
          environmentId: env,
          position: 2,
          kind: "delete_environment",
          params: {},
        },
      ]);
      expect(await failStaleTeardownRuns()).toBeGreaterThanOrEqual(1);
      const runRows = await db
        .select({ id: s.runs.id, status: s.runs.status })
        .from(s.runs)
        .where(inArray(s.runs.id, [stale, other]));
      expect(Object.fromEntries(runRows.map((r) => [r.id, r.status]))).toEqual({
        [stale]: "failed",
        [other]: "started",
      });
      const steps = await listTeardownSteps(env);
      expect(
        steps.map((st) => ({ status: st.status, lastError: st.lastError }))
      ).toEqual([
        { status: "done", lastError: null },
        { status: "failed", lastError: "stepFailed" },
        { status: "pending", lastError: null },
      ]);
    } finally {
      await db.delete(s.environments).where(eq(s.environments.id, env));
    }
  });

  it("lists archives newest first and selects only prunable ones", async () => {
    const day = 86_400_000;
    const now = new Date("2026-11-10T03:00:00Z");
    const cutoff = new Date(now.getTime() - 30 * day);
    const live = await environment("TD Archive Live");
    try {
      await db.insert(s.teardownSteps).values({
        environmentId: live,
        position: 0,
        kind: "delete_environment",
        params: {},
        status: "failed",
      });
      const base = {
        projectName: "Teardown IT",
        environmentSlug: "td",
        location: "local" as const,
        keyPrefix: "/tmp/td-it/",
      };
      const rows = await db
        .insert(s.environmentArchives)
        .values([
          {
            // Completed, expired: pruned.
            ...base,
            environmentName: "expired",
            environmentId: crypto.randomUUID(),
            createdAt: new Date(now.getTime() - 31 * day),
            expiresAt: new Date(now.getTime() - day),
            completedAt: new Date(now.getTime() - 31 * day),
          },
          {
            // Completed, not expired: kept.
            ...base,
            environmentName: "kept",
            environmentId: crypto.randomUUID(),
            createdAt: new Date(now.getTime() - 2 * day),
            expiresAt: new Date(now.getTime() + 28 * day),
            completedAt: new Date(now.getTime() - 2 * day),
          },
          {
            // Open, old, environment has no teardown steps left: pruned.
            ...base,
            environmentName: "abandoned",
            environmentId: crypto.randomUUID(),
            createdAt: new Date(now.getTime() - 31 * day),
            expiresAt: new Date(now.getTime() - day),
          },
          {
            // Open, old, but its teardown still has steps: kept, even
            // past expiry (a retry resumes after the archive steps).
            ...base,
            environmentName: "in progress",
            environmentId: live,
            createdAt: new Date(now.getTime() - 31 * day),
            expiresAt: new Date(now.getTime() - day),
          },
          {
            // Open, young, no steps: kept.
            ...base,
            environmentName: "young",
            environmentId: crypto.randomUUID(),
            createdAt: new Date(now.getTime() - 3 * day),
            expiresAt: new Date(now.getTime() + 27 * day),
          },
        ])
        .returning({
          id: s.environmentArchives.id,
          name: s.environmentArchives.environmentName,
        });
      const byName = Object.fromEntries(rows.map((r) => [r.name, r.id]));

      const ours = (a: { id: string }) => Object.values(byName).includes(a.id);
      const prunable = await listPrunableArchives(now, cutoff);
      expect(
        prunable
          .filter(ours)
          .map((a) => a.environmentName)
          .sort()
      ).toEqual(["abandoned", "expired"]);

      const listed = (await listArchives()).filter(ours);
      // Newest first; the three 31-day-old rows follow in any order.
      expect(listed.map((a) => a.environmentName).sort()).toEqual([
        "abandoned",
        "expired",
        "in progress",
        "kept",
        "young",
      ]);
      // kept is 2 days old, young 3.
      expect(listed.slice(0, 2).map((a) => a.environmentName)).toEqual([
        "kept",
        "young",
      ]);

      const expired = byName.expired as string;
      await expect(getArchive(expired)).resolves.toMatchObject({
        id: expired,
        environmentName: "expired",
      });
      await deleteArchiveRow(expired);
      await expect(getArchive(expired)).resolves.toBe(null);
    } finally {
      await db.delete(s.environments).where(eq(s.environments.id, live));
    }
  });

  it("keeps deploys, provisioning, backups and lock releases off an environment being deleted", async () => {
    const { placeDeployment, releaseDeployLock } = await import(
      "@/lib/deploy/repository"
    );
    const { startProvisioningRun } = await import(
      "@/lib/provisioning/repository"
    );
    const env = await environment("TD Guard");
    try {
      const target = await one(
        db
          .insert(s.deployTargets)
          .values({
            environmentId: env,
            componentKey: "td-it",
            serverId: ids.server2,
            sourceBranch: "main",
            deployDir: "/deployments/td-guard",
            services: ["backend"],
          })
          .returning({ id: s.deployTargets.id })
      );
      const place = (trigger: "auto" | "manual") =>
        placeDeployment({
          targetId: target.id,
          environmentId: env,
          tag: "origin-main-abc1234",
          trigger,
          userId: null,
          buildId: null,
          description: "td-it deploy",
          now: new Date(),
        });
      // A failed teardown with nothing done does not block.
      await db.insert(s.teardownSteps).values({
        environmentId: env,
        position: 0,
        kind: "check_stack",
        params: {},
        status: "failed",
      });
      await expect(teardownBlocks(env)).resolves.toBe(false);
      const backup = await createRunUnlessTearingDown({
        environmentId: env,
        description: "td-it backup",
        kind: "backup",
      });
      expect(backup).toEqual(expect.any(String));
      await db.delete(s.runs).where(eq(s.runs.environmentId, env));

      // A held auto build behind a lock, then a step is done.
      await db.insert(s.environmentDeployLocks).values({
        environmentId: env,
        reason: "td-it",
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      const held = await place("auto");
      expect(held.kind).toBe("held");
      await db
        .update(s.teardownSteps)
        .set({ status: "done" })
        .where(eq(s.teardownSteps.environmentId, env));

      for (const trigger of ["auto", "manual"] as const) {
        await expect(place(trigger)).resolves.toEqual({
          kind: "tearingDown",
          released: null,
        });
      }
      await expect(
        createRunUnlessTearingDown({
          environmentId: env,
          description: "td-it backup",
          kind: "backup",
        })
      ).resolves.toBe(null);
      await expect(
        startProvisioningRun(env, crypto.randomUUID())
      ).resolves.toEqual({
        tearingDown: true,
      });
      const released = await releaseDeployLock(env);
      expect(released?.queued).toEqual([]);
      const rows = await db
        .select({ status: s.deployments.status })
        .from(s.deployments)
        .where(eq(s.deployments.environmentId, env));
      expect(rows).toEqual([{ status: "held" }]);
      // Nothing started on the environment.
      const started = await db
        .select({ id: s.runs.id })
        .from(s.runs)
        .where(
          and(eq(s.runs.environmentId, env), eq(s.runs.status, "started"))
        );
      expect(started).toEqual([]);
    } finally {
      await db.delete(s.environments).where(eq(s.environments.id, env));
    }
  });

  it("cancels a teardown only before anything past the archive steps is done", async () => {
    const env = await environment("TD Cancel");
    try {
      await expect(cancelTeardownSteps(env)).resolves.toEqual({
        nothing: true,
      });
      const kinds = [
        "check_stack",
        "archive_database",
        "archive_deploy_dir",
        "archive_volumes",
        "stack_down",
        "delete_environment",
      ] as const;
      const seed = async (done: number) => {
        await db
          .delete(s.teardownSteps)
          .where(eq(s.teardownSteps.environmentId, env));
        await db.insert(s.teardownSteps).values(
          kinds.map((kind, position) => ({
            environmentId: env,
            position,
            kind,
            params: {},
            status: position < done ? ("done" as const) : ("pending" as const),
          }))
        );
      };

      // stack_down done: past the archives.
      await seed(5);
      await expect(cancelTeardownSteps(env)).resolves.toEqual({
        refusal: "teardownCannotCancel",
      });
      await expect(listTeardownSteps(env)).resolves.toHaveLength(6);

      // A started teardown run: still running.
      await seed(4);
      const running = await startedRun(env, "teardown");
      await expect(cancelTeardownSteps(env)).resolves.toEqual({
        refusal: "teardownRunning",
      });
      await db.delete(s.runs).where(eq(s.runs.id, running));
      // A running step.
      await db
        .update(s.teardownSteps)
        .set({ status: "running" })
        .where(
          and(
            eq(s.teardownSteps.environmentId, env),
            eq(s.teardownSteps.position, 4)
          )
        );
      await expect(cancelTeardownSteps(env)).resolves.toEqual({
        refusal: "teardownRunning",
      });

      // Every archive step done, nothing else: cancelled, unfrozen.
      await seed(4);
      const base = {
        environmentId: env,
        projectName: "Teardown IT",
        environmentName: "TD Cancel",
        environmentSlug: "td-cancel",
        location: "local" as const,
        keyPrefix: "/tmp/td-it/",
      };
      const day = 86_400_000;
      const old = await createArchive({
        ...base,
        expiresAt: new Date(Date.now() + 30 * day),
      });
      await addArchiveFile(old.id, { name: "db-x.dump", size: 1 });
      await expect(teardownBlocks(env)).resolves.toBe(true);
      await expect(cancelTeardownSteps(env)).resolves.toEqual({
        cancelled: true,
      });
      await expect(listTeardownSteps(env)).resolves.toEqual([]);
      await expect(teardownBlocks(env)).resolves.toBe(false);

      // The open archive is detached: still open, no longer the env's.
      const detached = await getArchive(old.id);
      expect(detached).toMatchObject({
        environmentId: null,
        completedAt: null,
      });
      await expect(findOpenArchive(env)).resolves.toBe(null);
      // Still listed (and so downloadable).
      expect((await listArchives()).map((a) => a.id)).toContain(old.id);
      // The next teardown's first archive step creates a new, empty row.
      const fresh = await createArchive({
        ...base,
        expiresAt: new Date(Date.now() + 30 * day),
      });
      expect(fresh.id).not.toBe(old.id);
      expect(fresh.files).toEqual([]);
      // The incomplete-archive prune takes the detached one after 30 days.
      const later = new Date(Date.now() + 31 * day);
      const prunable = (
        await listPrunableArchives(later, new Date(later.getTime() - 30 * day))
      ).map((a) => a.id);
      expect(prunable).toContain(old.id);
      // The fresh one belongs to an environment with no steps now, so it
      // is prunable too once old; with steps it would be kept.
      await seed(1);
      const withSteps = (
        await listPrunableArchives(later, new Date(later.getTime() - 30 * day))
      ).map((a) => a.id);
      expect(withSteps).toContain(old.id);
      expect(withSteps).not.toContain(fresh.id);
    } finally {
      await db.delete(s.environments).where(eq(s.environments.id, env));
    }
  });
});

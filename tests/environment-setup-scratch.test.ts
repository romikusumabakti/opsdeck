import { execFileSync } from "node:child_process";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The setup wizard's preview and create against a real Panel database: the
// local scratch copy named by SETUP_SCRATCH_DB (e.g. wiz_scratch, in the
// opsdeck-postgres container), reached through its published port with the
// container's own superuser password, read from the container and never
// printed. Only the session, the job queue, the Cloudflare API and the
// activity feed are stubbed; permissions, placement, the transaction and the
// provisioning run are real. Every fixture is named wiz-it/WIZ* and removed.
//
//   SETUP_SCRATCH_DB=wiz_scratch bunx vitest run tests/environment-setup-scratch.test.ts
const scratchDb = process.env.SETUP_SCRATCH_DB;
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

const state = vi.hoisted(() => ({
  user: { id: "", role: "engineer", name: "Wiz IT" },
  // Forces the domain's pre-check to pass, so the hostname clash happens
  // inside the transaction, on its last insert.
  skipHostnameCheck: false,
  enqueued: [] as unknown[],
  activity: [] as { action: string; data: unknown }[],
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({ user: state.user })),
  getServerSession: vi.fn(async () => ({ user: state.user })),
}));
vi.mock("@/lib/queue", () => ({
  enqueue: vi.fn(async (name: string, payload: unknown) => {
    state.enqueued.push({ name, payload });
  }),
}));
vi.mock("@/lib/activity", () => ({
  recordActivity: vi.fn(async (entry: { action: string; data: unknown }) => {
    state.activity.push(entry);
  }),
}));
vi.mock("@/server/services/cloudflare-account", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/services/cloudflare-account")
  >()),
  callCloudflare: vi.fn(async () => [
    { id: "pol-staff", name: "Staff", decision: "allow", everyone: false },
    { id: "pol-open", name: "Open", decision: "bypass", everyone: true },
  ]),
}));
vi.mock("@/lib/domains/repository", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/domains/repository")>();
  return {
    ...real,
    hostnameTakenByOther: vi.fn(async (hostname: string, id?: string) =>
      state.skipHostnameCheck ? false : real.hostnameTakenByOther(hostname, id)
    ),
  };
});

describe.skipIf(!scratchDb)("environment setup on scratch", async () => {
  const { eq, inArray, sql } = await import("drizzle-orm");
  const { db } = await import("@/lib/db");
  const s = await import("@/lib/db/schema");
  const { decryptSecret, encryptSecret } = await import("@/lib/secrets");
  const { app } = await import("@/server/app");
  const cf = await import("@/server/services/cloudflare-account");
  const { HTTPException } = await import("hono/http-exception");

  const SECRET_PLAIN = "wiz-it-smtp-secret-value";
  const KEY_PLAIN = "wiz-it-escrowed-key-value";
  const DB_PASSWORD_PLAIN = "wiz-it-source-db-password-0123456789";
  const SESSION_PLAIN = "wiz-it-source-session-secret-0123456789";
  const ZONE = "wiz-it.example";

  const ids = {
    maintainer: "",
    contributor: "",
    observer: "",
    projectA: "",
    projectB: "",
    projectC: "",
    server: "",
    host: "",
    ci: "",
    app: "",
    account: "",
    zone: "",
    tunnel: "",
    source: "",
    sourceB: "",
    sourceC: "",
    admin: "",
    restricted: "",
    fixedSource: "",
  };

  async function cleanup() {
    const projectRows = await db
      .select({ id: s.projects.id })
      .from(s.projects)
      .where(inArray(s.projects.key, ["WIZA", "WIZB", "WIZC"]));
    const projectIds = projectRows.map((p) => p.id);
    if (projectIds.length > 0) {
      await db
        .delete(s.environments)
        .where(inArray(s.environments.projectId, projectIds));
      await db.delete(s.projects).where(inArray(s.projects.id, projectIds));
    }
    await db
      .delete(s.apps)
      .where(eq(s.apps.appKey, "wiz-it"))
      .catch(() => {});
    await db
      .delete(s.appComponents)
      .where(eq(s.appComponents.componentKey, "wiz-it"));
    await db.delete(s.apps).where(eq(s.apps.appKey, "wiz-it"));
    await db.delete(s.ciConnections).where(eq(s.ciConnections.name, "wiz-it"));
    await db.delete(s.remoteTunnels).where(eq(s.remoteTunnels.name, "wiz-it"));
    await db.delete(s.cloudflareZones).where(eq(s.cloudflareZones.name, ZONE));
    await db
      .delete(s.cloudflareAccounts)
      .where(eq(s.cloudflareAccounts.name, "wiz-it"));
    const serverRows = await db
      .select({ id: s.servers.id })
      .from(s.servers)
      .where(inArray(s.servers.name, ["wiz-it server", "wiz-it restricted"]));
    if (serverRows.length > 0) {
      const serverIds = serverRows.map((r) => r.id);
      await db
        .delete(s.databaseHosts)
        .where(inArray(s.databaseHosts.serverId, serverIds));
      await db.delete(s.servers).where(inArray(s.servers.id, serverIds));
    }
    await db
      .delete(s.users)
      .where(sql`${s.users.email} like 'wiz-it-%@example.test'`);
  }

  async function one<T>(rows: Promise<T[]>): Promise<T> {
    const [row] = await rows;
    if (!row) throw new Error("insert returned no row");
    return row;
  }

  async function sourceEnvironment(
    projectId: string,
    name: string,
    port: number
  ) {
    const env = await one(
      db
        .insert(s.environments)
        .values({
          projectId,
          name,
          slug: name.toLowerCase().replace(/\s+/g, "-"),
          appId: ids.app,
          envFileManaged: true,
          entryPort: port,
        })
        .returning({ id: s.environments.id })
    );
    await db.insert(s.environmentServices).values({
      environmentId: env.id,
      role: "backend",
      serverId: ids.server,
      serviceType: "docker",
      serviceName: `${name.toLowerCase().replace(/\s+/g, "-")}-svc`,
    });
    await db.insert(s.deployTargets).values({
      environmentId: env.id,
      componentKey: "wiz-it",
      serverId: ids.server,
      sourceBranch: "main",
      deployDir: `/deployments/${env.id}`,
      services: ["backend"],
    });
    await db.insert(s.environmentVariables).values(
      [
        {
          name: "APP_NAME",
          kind: "plain" as const,
          value: "Wiz",
          escrow: false,
        },
        {
          name: "SMTP_PASSWORD",
          kind: "secret" as const,
          value: encryptSecret(SECRET_PLAIN),
          escrow: false,
        },
        {
          name: "DATA_ENCRYPTION_KEY",
          kind: "secret" as const,
          value: encryptSecret(KEY_PLAIN),
          escrow: true,
        },
        {
          name: "DB_PASSWORD",
          kind: "generated" as const,
          value: encryptSecret(DB_PASSWORD_PLAIN),
          escrow: false,
        },
        {
          name: "SESSION_SECRET",
          kind: "generated" as const,
          value: encryptSecret(SESSION_PLAIN),
          escrow: false,
        },
      ].map((v) => ({ ...v, environmentId: env.id }))
    );
    return env.id;
  }

  beforeAll(async () => {
    await cleanup();
    const user = (email: string, role: string) =>
      one(
        db
          .insert(s.users)
          .values({ id: crypto.randomUUID(), name: email, email, role })
          .returning({ id: s.users.id })
      );
    ids.maintainer = (
      await user("wiz-it-maintainer@example.test", "engineer")
    ).id;
    ids.contributor = (await user("wiz-it-contributor@example.test", "qa")).id;
    ids.observer = (await user("wiz-it-observer@example.test", "observer")).id;
    const project = (key: string) =>
      one(
        db
          .insert(s.projects)
          .values({ key, name: `Wiz ${key}` })
          .returning({ id: s.projects.id })
      );
    ids.projectA = (await project("WIZA")).id;
    ids.projectB = (await project("WIZB")).id;
    ids.projectC = (await project("WIZC")).id;
    await db.insert(s.projectMembers).values([
      { projectId: ids.projectA, userId: ids.maintainer, role: "engineer" },
      { projectId: ids.projectB, userId: ids.maintainer, role: "viewer" },
      { projectId: ids.projectA, userId: ids.contributor, role: "qa" },
    ]);
    ids.server = (
      await one(
        db
          .insert(s.servers)
          .values({
            name: "wiz-it server",
            host: "192.0.2.10",
            username: "deploy",
            password: "unused",
            placement: "open",
            preflight: {
              runtime: { docker: "27", compose: "2", podman: null },
              registry: null,
              disk: [],
              cloudflared: { systemd: false, containers: [] },
              listeningPorts: [22, 8102],
              publishedPorts: [],
              postgresCandidates: [],
            },
            preflightAt: new Date(),
          })
          .returning({ id: s.servers.id })
      )
    ).id;
    ids.host = (
      await one(
        db
          .insert(s.databaseHosts)
          .values({
            serverId: ids.server,
            containerName: "wiz-it-postgres",
            backupPath: "/backups",
            label: "Wiz shared Postgres",
            network: "wiz-it-net",
          })
          .returning({ id: s.databaseHosts.id })
      )
    ).id;
    ids.ci = (
      await one(
        db
          .insert(s.ciConnections)
          .values({
            name: "wiz-it",
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
          .values({ appKey: "wiz-it", name: "Wiz IT" })
          .returning({ id: s.apps.id })
      )
    ).id;
    await db.insert(s.appComponents).values({
      componentKey: "wiz-it",
      appId: ids.app,
      ciConnectionId: ids.ci,
      repoFullName: "example/wiz-it",
      bundleImage: "wiz-it-deploy",
      notifySecret: encryptSecret("notify"),
    });
    await db.insert(s.appVariableTemplates).values([
      {
        appId: ids.app,
        name: "DB_PASSWORD",
        kind: "generated",
        generatedLength: 40,
      },
      {
        appId: ids.app,
        name: "SESSION_SECRET",
        kind: "generated",
        generatedLength: 48,
      },
      {
        appId: ids.app,
        name: "DATA_ENCRYPTION_KEY",
        kind: "secret",
        required: true,
        escrow: true,
      },
      { appId: ids.app, name: "SMTP_PASSWORD", kind: "secret", required: true },
      {
        appId: ids.app,
        name: "CORS_ORIGINS",
        kind: "plain",
        defaultValue: "{url}",
      },
    ]);
    ids.account = (
      await one(
        db
          .insert(s.cloudflareAccounts)
          .values({ accountId: "acc-wiz", name: "wiz-it", apiToken: "unused" })
          .returning({ id: s.cloudflareAccounts.id })
      )
    ).id;
    ids.zone = (
      await one(
        db
          .insert(s.cloudflareZones)
          .values({ name: ZONE, zoneId: "zone-wiz", apiToken: "unused" })
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
            tunnelId: "tun-wiz",
            name: "wiz-it",
          })
          .returning({ id: s.remoteTunnels.id })
      )
    ).id;
    ids.source = await sourceEnvironment(ids.projectA, "Wiz Source", 8100);
    ids.sourceB = await sourceEnvironment(ids.projectB, "Wiz Source B", 8103);
    ids.sourceC = await sourceEnvironment(ids.projectC, "Wiz Source C", 8104);
    // An admin, and a restricted server whose environment's container has a
    // fixed name (compose `container_name`), not `<dir>-<svc>-1`.
    ids.admin = (
      await one(
        db
          .insert(s.users)
          .values({
            id: crypto.randomUUID(),
            name: "wiz-it-admin",
            email: "wiz-it-admin@example.test",
            role: "admin",
          })
          .returning({ id: s.users.id })
      )
    ).id;
    ids.restricted = (
      await one(
        db
          .insert(s.servers)
          .values({
            name: "wiz-it restricted",
            host: "192.0.2.11",
            username: "deploy",
            password: "unused",
            placement: "restricted",
          })
          .returning({ id: s.servers.id })
      )
    ).id;
    ids.fixedSource = (
      await one(
        db
          .insert(s.environments)
          .values({
            projectId: ids.projectA,
            name: "Wiz Fixed",
            slug: "wiz-fixed",
            appId: ids.app,
            envFileManaged: true,
          })
          .returning({ id: s.environments.id })
      )
    ).id;
    await db.insert(s.environmentServices).values({
      environmentId: ids.fixedSource,
      role: "backend",
      serverId: ids.restricted,
      serviceType: "docker",
      serviceName: "wiz-fixed-api",
    });
    await db.insert(s.deployTargets).values({
      environmentId: ids.fixedSource,
      componentKey: "wiz-it",
      serverId: ids.restricted,
      sourceBranch: "main",
      deployDir: "/deployments/wiz-fixed",
      services: ["api"],
      backupBeforeDeploy: true,
    });
    await db.insert(s.environmentDomains).values({
      environmentId: ids.sourceB,
      kind: "tunnel",
      hostname: `wiz-taken.${ZONE}`,
      zoneId: ids.zone,
      remoteTunnelId: ids.tunnel,
      accessPolicyId: "pol-staff",
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(() => {
    state.user = { id: ids.maintainer, role: "engineer", name: "Wiz IT" };
    state.skipHostnameCheck = false;
    state.enqueued = [];
    state.activity = [];
  });

  const input = (overrides: Record<string, unknown> = {}) => ({
    projectId: ids.projectA,
    appId: ids.app,
    name: "Wiz Staging",
    kind: "qa",
    copyFromEnvironmentId: ids.source,
    server: { serverId: ids.server },
    targets: [
      {
        componentKey: "wiz-it",
        sourceBranch: "release/1.x",
        autoDeploy: true,
        deployDir: "/deployments/wiz-staging",
        services: ["wiza-backend", "wiza-frontend"],
        tagVariable: "IMAGE_TAG",
        healthUrl: "https://wiz-staging.wiz-it.example/health",
        healthTimeoutSeconds: 240,
        backupBeforeDeploy: true,
      },
    ],
    services: [
      { role: "backend", serviceName: "wiza-backend" },
      { role: "frontend", serviceName: "wiza-frontend" },
    ],
    database: {
      kind: "shared",
      databaseHostId: ids.host,
      dbName: "wiza_staging",
      dbRole: "wiza_staging",
      passwordVariable: "DB_PASSWORD",
    },
    variables: [
      { name: "APP_NAME", kind: "plain", copy: true },
      { name: "SMTP_PASSWORD", kind: "secret", copy: true },
      { name: "DATA_ENCRYPTION_KEY", kind: "secret", value: "wiz-new-key" },
      { name: "DB_PASSWORD", kind: "generated", copy: true },
    ],
    domain: {
      kind: "tunnel",
      zoneId: ids.zone,
      label: "wiz-staging",
      accessPolicyId: "pol-staff",
      entryPort: 8101,
    },
    ...overrides,
  });

  const TABLES = [
    s.environments,
    s.environmentServices,
    s.deployTargets,
    s.environmentVariables,
    s.environmentDomains,
    s.provisioningSteps,
    s.runs,
  ];
  async function counts(): Promise<number[]> {
    return Promise.all(
      TABLES.map(async (table) => {
        const [row] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(table);
        return row?.n ?? 0;
      })
    );
  }

  function post(path: string, body: unknown) {
    return app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function expectNoSecret(json: string) {
    for (const plain of [
      SECRET_PLAIN,
      KEY_PLAIN,
      DB_PASSWORD_PLAIN,
      SESSION_PLAIN,
    ]) {
      expect(json).not.toContain(plain);
    }
    expect(json).not.toContain("enc:v1:");
  }

  it("previews a clean setup without writing, suggesting a free port", async () => {
    const before = await counts();
    const res = await post("/api/setup/environments/preview", input());
    expect(res.status).toBe(200);
    const text = await res.text();
    expectNoSecret(text);
    const preview = JSON.parse(text);
    expect(preview.issues).toEqual([]);
    // 8100 is the source's entry port, 8102 listens on the server.
    expect(preview.suggestedEntryPort).toBe(8101);
    expect(preview.slug).toBe("wiz-staging");
    expect(preview.plan.map((step: { kind: string }) => step.kind)).toEqual([
      "prepare_deploy_dir",
      "create_database",
      "access_app",
      "tunnel_route",
      "dns_record",
      "deploy",
    ]);
    expect(preview.plan.at(-1).params.targetId).toBe("wiz-it");
    expect(preview.creates).toEqual([
      "Environment Wiz Staging in Wiz WIZA",
      "Deploy target wiz-it → wiz-it server /deployments/wiz-staging",
      "Shared database wiza_staging on Wiz shared Postgres",
      "6 variables (2 generated, 1 copied secret)",
      `Domain wiz-staging.${ZONE}`,
    ]);
    expect(await counts()).toEqual(before);
  });

  it("creates everything in one go and starts provisioning", async () => {
    const res = await post("/api/setup/environments", input());
    const text = await res.text();
    expect(res.status, text).toBe(201);
    expectNoSecret(text);
    const created = JSON.parse(text);
    expect(created).toMatchObject({
      projectKey: "WIZA",
      envSlug: "wiz-staging",
    });
    expect(typeof created.runId).toBe("string");
    expect(created.provisioningError).toBeUndefined();
    const envId = created.environmentId as string;

    const envs = await db
      .select()
      .from(s.environments)
      .where(eq(s.environments.name, "Wiz Staging"));
    expect(envs).toHaveLength(1);
    expect(envs[0]).toMatchObject({
      id: envId,
      projectId: ids.projectA,
      appId: ids.app,
      kind: "qa",
      ownerId: ids.maintainer,
      envFileManaged: true,
      entryPort: 8101,
      url: `https://wiz-staging.${ZONE}`,
    });

    const services = await db
      .select()
      .from(s.environmentServices)
      .where(eq(s.environmentServices.environmentId, envId));
    const byRole = Object.fromEntries(services.map((x) => [x.role, x]));
    expect(services).toHaveLength(3);
    expect(byRole.db).toMatchObject({
      serverId: ids.server,
      serviceType: "docker",
      serviceName: "wiz-it-postgres",
      dbType: "postgres",
      dbKind: "shared",
      databaseHostId: ids.host,
      dbName: "wiza_staging",
      dbRole: "wiza_staging",
      dbPasswordVariable: "DB_PASSWORD",
      dbBackupPath: "/backups",
    });
    expect(byRole.backend).toMatchObject({ serviceName: "wiza-backend" });
    expect(byRole.frontend).toMatchObject({ serviceName: "wiza-frontend" });

    const targets = await db
      .select()
      .from(s.deployTargets)
      .where(eq(s.deployTargets.environmentId, envId));
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      componentKey: "wiz-it",
      serverId: ids.server,
      sourceBranch: "release/1.x",
      autoDeploy: true,
      deployDir: "/deployments/wiz-staging",
      services: ["wiza-backend", "wiza-frontend"],
      tagVariable: "IMAGE_TAG",
      preStartCommand: null,
      healthUrl: "https://wiz-staging.wiz-it.example/health",
      healthTimeoutSeconds: 240,
      backupBeforeDeploy: true,
    });

    const variables = await db
      .select()
      .from(s.environmentVariables)
      .where(eq(s.environmentVariables.environmentId, envId));
    const v = Object.fromEntries(variables.map((x) => [x.name, x]));
    expect(Object.keys(v).sort()).toEqual([
      "APP_NAME",
      "CORS_ORIGINS",
      "DATA_ENCRYPTION_KEY",
      "DB_PASSWORD",
      "SESSION_SECRET",
      "SMTP_PASSWORD",
    ]);
    const [sourceSmtp] = await db
      .select()
      .from(s.environmentVariables)
      .where(
        sql`${s.environmentVariables.environmentId} = ${ids.source} and ${s.environmentVariables.name} = 'SMTP_PASSWORD'`
      );
    expect(v.SMTP_PASSWORD?.value).toBe(sourceSmtp?.value);
    expect(decryptSecret(v.SMTP_PASSWORD?.value ?? "")).toBe(SECRET_PLAIN);
    const dbPassword = decryptSecret(v.DB_PASSWORD?.value ?? "");
    expect(dbPassword).toHaveLength(40);
    expect(dbPassword).not.toBe(DB_PASSWORD_PLAIN);
    const session = decryptSecret(v.SESSION_SECRET?.value ?? "");
    expect(session).toHaveLength(48);
    expect(session).not.toBe(SESSION_PLAIN);
    expect(v.DATA_ENCRYPTION_KEY).toMatchObject({ escrow: true });
    expect(decryptSecret(v.DATA_ENCRYPTION_KEY?.value ?? "")).toBe(
      "wiz-new-key"
    );
    expect(v.APP_NAME?.value).toBe("Wiz");
    expect(v.CORS_ORIGINS?.value).toBe(`https://wiz-staging.${ZONE}`);

    const [domain] = await db
      .select()
      .from(s.environmentDomains)
      .where(eq(s.environmentDomains.environmentId, envId));
    expect(domain).toMatchObject({
      kind: "tunnel",
      hostname: `wiz-staging.${ZONE}`,
      zoneId: ids.zone,
      remoteTunnelId: ids.tunnel,
      accessPolicyId: "pol-staff",
    });

    const runs = await db
      .select()
      .from(s.runs)
      .where(eq(s.runs.environmentId, envId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: created.runId, kind: "provision" });
    const steps = await db
      .select()
      .from(s.provisioningSteps)
      .where(eq(s.provisioningSteps.environmentId, envId));
    expect(steps).toHaveLength(6);
    expect(state.enqueued).toEqual([
      {
        name: "provision/run.requested",
        payload: { environmentId: envId, runId: created.runId },
      },
    ]);
    const setupEntry = state.activity.find(
      (a) => a.action === "environment.setup"
    );
    expect(setupEntry?.data).toEqual({
      environment: "Wiz Staging",
      project: "WIZA",
      components: "wiz-it",
      variables:
        "APP_NAME, CORS_ORIGINS, DATA_ENCRYPTION_KEY, DB_PASSWORD, SESSION_SECRET, SMTP_PASSWORD",
      // The copy source and the names (never the values) copied from it.
      copiedFrom: "Wiz Source",
      copiedFromId: ids.source,
      copiedVariables: "APP_NAME, SMTP_PASSWORD",
    });
    expectNoSecret(JSON.stringify(state.activity));

    await db.delete(s.environments).where(eq(s.environments.id, envId));
  });

  it("refuses an artifact component, whose target the wizard would make compose", async () => {
    await db
      .update(s.appComponents)
      .set({
        buildSpec: {
          branches: [],
          tagShaLength: 7,
          images: [],
          bundleFiles: [],
          checks: [
            { name: "build", image: "gradle:8", dir: ".", commands: ["x"] },
          ],
          artifact: { kind: "jar", path: "build/libs/app.jar" },
          timeoutMinutes: 60,
        },
      })
      .where(eq(s.appComponents.componentKey, "wiz-it"));
    try {
      const before = await counts();
      const preview = await (
        await post("/api/setup/environments/preview", input())
      ).json();
      expect(preview.issues).toContainEqual({
        field: "targets.0.componentKey",
        code: "targetKindMismatch",
      });
      const res = await post("/api/setup/environments", input());
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "targetKindMismatch" });
      expect(await counts()).toEqual(before);
    } finally {
      await db
        .update(s.appComponents)
        .set({ buildSpec: null })
        .where(eq(s.appComponents.componentKey, "wiz-it"));
    }
  });

  it("refuses a deploy dir inside another environment's static web root", async () => {
    const [sourceC] = await db
      .update(s.deployTargets)
      .set({ kind: "static", services: [], deployDir: "/deployments/wiz-web" })
      .where(eq(s.deployTargets.environmentId, ids.sourceC))
      .returning({ deployDir: s.deployTargets.deployDir });
    expect(sourceC).toBeDefined();
    try {
      const before = await counts();
      const body = input({
        targets: [
          { ...input().targets[0], deployDir: "/deployments/wiz-web/app" },
        ],
      });
      const preview = await (
        await post("/api/setup/environments/preview", body)
      ).json();
      expect(preview.issues).toContainEqual({
        field: "targets.0.deployDir",
        code: "targetInsideStaticRoot",
      });
      const res = await post("/api/setup/environments", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "targetInsideStaticRoot",
      });
      expect(await counts()).toEqual(before);
    } finally {
      await db
        .update(s.deployTargets)
        .set({
          kind: "compose",
          services: ["backend"],
          deployDir: `/deployments/${ids.sourceC}`,
        })
        .where(eq(s.deployTargets.environmentId, ids.sourceC));
    }
  });

  it("refuses a taken label with 409 and writes nothing", async () => {
    const before = await counts();
    const body = input({
      domain: {
        kind: "tunnel",
        zoneId: ids.zone,
        label: "wiz-taken",
        accessPolicyId: "pol-staff",
        entryPort: 8101,
      },
    });
    const preview = await (
      await post("/api/setup/environments/preview", body)
    ).json();
    expect(preview.issues).toEqual([
      { field: "domain.label", code: "domainHostnameTaken" },
    ]);
    const res = await post("/api/setup/environments", body);
    expect(res.status).toBe(409);
    expect(await counts()).toEqual(before);
  });

  it("rolls everything back when the last insert of the transaction fails", async () => {
    const before = await counts();
    state.skipHostnameCheck = true;
    const res = await post(
      "/api/setup/environments",
      input({
        domain: {
          kind: "tunnel",
          zoneId: ids.zone,
          label: "wiz-taken",
          accessPolicyId: "pol-staff",
          entryPort: 8101,
        },
      })
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Another environment uses this hostname",
      code: "domainHostnameTaken",
    });
    expect(await counts()).toEqual(before);
    expect(state.enqueued).toEqual([]);
  });

  it("refuses a QA contributor with 403", async () => {
    state.user = { id: ids.contributor, role: "qa", name: "QA" };
    const before = await counts();
    for (const path of [
      "/api/setup/environments",
      "/api/setup/environments/preview",
    ]) {
      expect((await post(path, input())).status, path).toBe(403);
    }
    expect(await counts()).toEqual(before);
  });

  it("answers 404 for a copy source in a project the caller cannot see", async () => {
    const res = await app.request(
      `/api/setup/environments/copy-source/${ids.sourceC}`
    );
    expect(res.status).toBe(404);
    const create = await post(
      "/api/setup/environments/preview",
      input({ copyFromEnvironmentId: ids.sourceC })
    );
    expect(create.status).toBe(404);
  });

  it("copy-source gives a maintainer names, plain values and copyability only", async () => {
    const res = await app.request(
      `/api/setup/environments/copy-source/${ids.source}`
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expectNoSecret(text);
    const source = JSON.parse(text);
    expect(source.serverId).toBe(ids.server);
    expect(source.database).toEqual({ kind: "none", databaseHostId: null });
    expect(source.variables).toEqual([
      {
        name: "APP_NAME",
        kind: "plain",
        escrow: false,
        hasValue: true,
        copyable: true,
        value: "Wiz",
      },
      {
        name: "DATA_ENCRYPTION_KEY",
        kind: "secret",
        escrow: true,
        hasValue: true,
        copyable: false,
      },
      {
        name: "DB_PASSWORD",
        kind: "generated",
        escrow: false,
        hasValue: true,
        copyable: false,
      },
      {
        name: "SESSION_SECRET",
        kind: "generated",
        escrow: false,
        hasValue: true,
        copyable: false,
      },
      {
        name: "SMTP_PASSWORD",
        kind: "secret",
        escrow: false,
        hasValue: true,
        copyable: true,
      },
    ]);
  });

  it("hides the source's variables from a caller who sees it without secret access", async () => {
    // An observer sees project B with the viewer set: the source is visible,
    // its variables are not — not even their names, kinds or escrow flags
    // (listVariables refuses). With one job role per user, no caller who may
    // create an environment sees a project without variable:read, so the
    // create's secretCopyForbidden refusal is covered by the service test
    // (tests/environment-setup-api.test.ts) only.
    state.user = { id: ids.observer, role: "observer", name: "Observer" };
    const view = await (
      await app.request(`/api/setup/environments/copy-source/${ids.sourceB}`)
    ).json();
    expect(view.variables).toEqual([]);
    expect(view.domain).toEqual({
      kind: "tunnel",
      zoneId: ids.zone,
      accessPolicyId: "pol-staff",
    });
  });

  it("lists the issues the create refuses with, first one first", async () => {
    const body = input({
      targets: [
        {
          componentKey: "wiz-it",
          sourceBranch: "main",
          deployDir: "/deployments/wiz-other",
          services: ["backend"],
        },
      ],
      services: [{ role: "backend", serviceName: "backend" }],
      variables: [{ name: "DB_PASSWORD", kind: "generated" }],
      domain: {
        kind: "tunnel",
        zoneId: ids.zone,
        label: "wiz-other",
        accessPolicyId: null,
        entryPort: 8100,
      },
    });
    const preview = await (
      await post("/api/setup/environments/preview", body)
    ).json();
    expect(preview.issues).toEqual([
      { field: "services.backend", code: "placementServiceName" },
      { field: "variables.DATA_ENCRYPTION_KEY", code: "variableRequired" },
      { field: "variables.SMTP_PASSWORD", code: "variableRequired" },
      { field: "domain.accessPolicyId", code: "domainPublicForbidden" },
    ]);
    expect(preview.plan).toEqual([]);
    expect(preview.creates).toEqual([]);

    const before = await counts();
    const res = await post("/api/setup/environments", body);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/wiza-/);
    expect(await counts()).toEqual(before);

    // Fix the first, and the create refuses with the next.
    const next = await post("/api/setup/environments", {
      ...body,
      services: [{ role: "backend", serviceName: "wiza-backend" }],
    });
    expect(next.status).toBe(409);
    expect((await next.json()).error).toBe(
      "Missing required variables: DATA_ENCRYPTION_KEY"
    );
  });

  describe("a domain check that fails without a code", () => {
    const cases: [string, () => unknown, { field: string; code: string }][] = [
      [
        "a network error out of callCloudflare",
        () => new TypeError("fetch failed"),
        { field: "domain.accessPolicyId", code: "cloudflareUnavailable" },
      ],
      [
        "a Cloudflare API error (502)",
        () => new HTTPException(502, { message: "Cloudflare said no" }),
        { field: "domain.accessPolicyId", code: "cloudflareUnavailable" },
      ],
      [
        "an uncoded 403",
        () => new HTTPException(403, { message: "Forbidden" }),
        { field: "domain.kind", code: "forbidden" },
      ],
      [
        "an uncoded 400",
        () => new HTTPException(400, { message: "Bad" }),
        { field: "domain.kind", code: "invalidInput" },
      ],
    ];
    for (const [label, error, issue] of cases) {
      it(`previews ${label} as a ${issue.code} issue, not a 500`, async () => {
        const errorLog = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});
        vi.mocked(cf.callCloudflare).mockRejectedValueOnce(error());
        const res = await post("/api/setup/environments/preview", input());
        errorLog.mockRestore();
        expect(res.status).toBe(200);
        expect((await res.json()).issues).toEqual([issue]);
      });
    }

    it("the create still answers with the error itself", async () => {
      vi.mocked(cf.callCloudflare).mockRejectedValueOnce(
        new HTTPException(502, { message: "Cloudflare said no" })
      );
      const before = await counts();
      const res = await post("/api/setup/environments", input());
      expect(res.status).toBe(502);
      expect(await counts()).toEqual(before);
    });
  });

  it("flags an entry port another environment on the server uses", async () => {
    const preview = await (
      await post(
        "/api/setup/environments/preview",
        input({
          domain: {
            kind: "tunnel",
            zoneId: ids.zone,
            label: "wiz-port",
            accessPolicyId: "pol-staff",
            entryPort: 8100,
          },
        })
      )
    ).json();
    expect(preview.issues).toEqual([
      { field: "domain.entryPort", code: "domainPortInUse" },
    ]);
    expect(preview.suggestedEntryPort).toBe(8101);
  });

  it("binds an own database container on the deploy server", async () => {
    const res = await post(
      "/api/setup/environments",
      input({
        name: "Wiz Container",
        targets: [
          {
            componentKey: "wiz-it",
            sourceBranch: "main",
            deployDir: "/deployments/wiz-container",
            services: ["app"],
          },
        ],
        services: [{ role: "backend", serviceName: "wiza-app" }],
        database: { kind: "container", serviceName: "wiza-db" },
        variables: [
          { name: "SMTP_PASSWORD", kind: "secret", value: "x" },
          { name: "DATA_ENCRYPTION_KEY", kind: "secret", value: "y" },
        ],
        domain: { kind: "none" },
      })
    );
    const created = await res.json();
    expect(res.status, JSON.stringify(created)).toBe(201);
    const services = await db
      .select()
      .from(s.environmentServices)
      .where(eq(s.environmentServices.environmentId, created.environmentId));
    expect(services.map((x) => x.role).sort()).toEqual(["backend", "db"]);
    expect(services.find((x) => x.role === "db")).toMatchObject({
      serverId: ids.server,
      serviceType: "docker",
      serviceName: "wiza-db",
      dbType: "postgres",
      dbKind: "container",
      databaseHostId: null,
    });
    await db
      .delete(s.environments)
      .where(eq(s.environments.id, created.environmentId));
  });

  const minimal = (overrides: Record<string, unknown>) =>
    input({
      database: { kind: "none" },
      variables: [
        { name: "SMTP_PASSWORD", kind: "secret", value: "x" },
        { name: "DATA_ENCRYPTION_KEY", kind: "secret", value: "y" },
      ],
      domain: { kind: "none" },
      ...overrides,
    });

  it("sets up a second environment of the app in another dir with Compose's container names", async () => {
    const created: string[] = [];
    for (const dir of ["wiza-one", "wiza-two"]) {
      const targets = [
        {
          componentKey: "wiz-it",
          sourceBranch: "main",
          deployDir: `/deployments/${dir}`,
          services: ["backend", "web"],
        },
      ];
      const preview = await (
        await post(
          "/api/setup/environments/preview",
          minimal({
            name: `Wiz ${dir}`,
            copyFromEnvironmentId: null,
            targets,
            entryService: "web",
            services: [],
          })
        )
      ).json();
      expect(preview.suggestedServices).toEqual([
        { role: "frontend", serviceName: `${dir}-web-1` },
        { role: "backend", serviceName: `${dir}-backend-1` },
      ]);
      const res = await post(
        "/api/setup/environments",
        minimal({
          name: `Wiz ${dir}`,
          copyFromEnvironmentId: null,
          targets,
          services: preview.suggestedServices,
        })
      );
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(201);
      created.push(body.environmentId);
    }
    const rows = await db
      .select({
        role: s.environmentServices.role,
        serviceName: s.environmentServices.serviceName,
      })
      .from(s.environmentServices)
      .where(inArray(s.environmentServices.environmentId, created));
    expect(rows.map((r) => `${r.role}:${r.serviceName}`).sort()).toEqual([
      "backend:wiza-one-backend-1",
      "backend:wiza-two-backend-1",
      "frontend:wiza-one-web-1",
      "frontend:wiza-two-web-1",
    ]);
    // Without a copy source the activity names none.
    for (const entry of state.activity.filter(
      (a) => a.action === "environment.setup"
    )) {
      expect(entry.data).not.toHaveProperty("copiedFrom");
      expect(entry.data).not.toHaveProperty("copiedVariables");
    }
    expect(
      state.activity.filter((a) => a.action === "environment.setup")
    ).toHaveLength(2);
    await db.delete(s.environments).where(inArray(s.environments.id, created));
  });

  it("reports a fixed container name copied from the source as in use, also for an admin on a restricted server", async () => {
    state.user = { id: ids.admin, role: "admin", name: "Admin" };
    const targets = [
      {
        componentKey: "wiz-it",
        sourceBranch: "main",
        deployDir: "/deployments/wiz-fixed-2",
        services: ["api"],
      },
    ];
    const base = minimal({
      name: "Wiz Fixed 2",
      copyFromEnvironmentId: ids.fixedSource,
      server: { serverId: ids.restricted },
      targets,
      services: [],
    });
    const first = await (
      await post("/api/setup/environments/preview", base)
    ).json();
    expect(first.suggestedServices).toEqual([
      { role: "backend", serviceName: "wiz-fixed-api" },
    ]);
    const body = { ...base, services: first.suggestedServices };
    const preview = await (
      await post("/api/setup/environments/preview", body)
    ).json();
    expect(preview.issues).toEqual([
      { field: "services.backend", code: "serviceNameInUse" },
    ]);
    const before = await counts();
    const res = await post("/api/setup/environments", body);
    expect(res.status).toBe(409);
    expect(await counts()).toEqual(before);
  });

  it("refuses backup-before-deploy without a shared database, as copied from the source", async () => {
    const view = await (
      await app.request(
        `/api/setup/environments/copy-source/${ids.fixedSource}`
      )
    ).json();
    expect(view.targets[0].backupBeforeDeploy).toBe(true);
    const body = minimal({
      name: "Wiz Backup",
      targets: [
        {
          ...view.targets[0],
          deployDir: "/deployments/wiza-backup",
          preStartCommand: undefined,
          healthUrl: undefined,
        },
      ],
      services: [{ role: "backend", serviceName: "wiza-backup-api-1" }],
    });
    const preview = await (
      await post("/api/setup/environments/preview", body)
    ).json();
    expect(preview.issues).toEqual([
      { field: "targets.0.backupBeforeDeploy", code: "backupNeedsSharedDb" },
    ]);
    const before = await counts();
    expect((await post("/api/setup/environments", body)).status).toBe(400);
    expect(await counts()).toEqual(before);
  });

  it("suggests no entry port for a server that refuses the placement", async () => {
    const preview = await (
      await post(
        "/api/setup/environments/preview",
        minimal({
          name: "Wiz Restricted",
          server: { serverId: ids.restricted },
          targets: [
            {
              componentKey: "wiz-it",
              sourceBranch: "main",
              deployDir: "/deployments/wiza-r",
              services: ["api"],
            },
          ],
          services: [{ role: "backend", serviceName: "wiza-r-api-1" }],
        })
      )
    ).json();
    expect(preview.issues).toContainEqual({
      field: "server.serverId",
      code: "placementForbidden",
    });
    expect(preview.suggestedEntryPort).toBeNull();
  });
  it("sends no value for an escrowed plain variable of the copy source", async () => {
    await db.insert(s.environmentVariables).values({
      environmentId: ids.source,
      name: "WIZ_ESCROW_PLAIN",
      kind: "plain",
      value: "wiz-escrowed-plain-value",
      escrow: true,
    });
    try {
      const res = await app.request(
        `/api/setup/environments/copy-source/${ids.source}`
      );
      const body = await res.json();
      const row = body.variables.find(
        (v: { name: string }) => v.name === "WIZ_ESCROW_PLAIN"
      );
      expect(row).toMatchObject({ escrow: true, copyable: false });
      expect(row).not.toHaveProperty("value");
      expect(JSON.stringify(body)).not.toContain("wiz-escrowed-plain-value");
      // A plain, unescrowed one still comes with its value.
      expect(
        body.variables.find((v: { name: string }) => v.name === "APP_NAME")
      ).toMatchObject({ value: "Wiz" });
    } finally {
      await db
        .delete(s.environmentVariables)
        .where(eq(s.environmentVariables.name, "WIZ_ESCROW_PLAIN"));
    }
  });

  describe("the lists the forms offer for a project", () => {
    const get = (path: string) => app.request(path);

    it("offers a maintainer only the servers that accept them, with the zones and tunnels", async () => {
      const res = await get(`/api/setup/options?projectId=${ids.projectA}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.servers.map((x: { name: string }) => x.name)).toContain(
        "wiz-it server"
      );
      expect(body.servers.map((x: { name: string }) => x.name)).not.toContain(
        "wiz-it restricted"
      );
      expect(body.zones.map((z: { name: string }) => z.name)).toContain(ZONE);
      expect(body.tunnels).toContainEqual({ id: ids.tunnel, name: "wiz-it" });
    });

    it("offers an admin the restricted servers too", async () => {
      state.user = { id: ids.admin, role: "admin", name: "Admin" };
      const body = await (
        await get(`/api/setup/options?projectId=${ids.projectA}`)
      ).json();
      expect(body.servers.map((x: { name: string }) => x.name)).toEqual(
        expect.arrayContaining(["wiz-it server", "wiz-it restricted"])
      );
    });

    it("refuses a contributor and a project the caller cannot see", async () => {
      state.user = { id: ids.contributor, role: "qa", name: "QA" };
      expect(
        (await get(`/api/setup/options?projectId=${ids.projectA}`)).status
      ).toBe(403);
      expect(
        (await get(`/api/setup/access-policies?projectId=${ids.projectA}`))
          .status
      ).toBe(403);
      state.user = { id: ids.maintainer, role: "engineer", name: "Wiz IT" };
      expect(
        (await get(`/api/setup/options?projectId=${ids.projectC}`)).status
      ).toBe(404);
    });

    it("lists the Access policies without the public ones for a maintainer", async () => {
      const res = await get(
        `/api/setup/access-policies?projectId=${ids.projectA}`
      );
      expect(await res.json()).toEqual([{ id: "pol-staff", name: "Staff" }]);
    });

    it("lists every Access policy for an admin", async () => {
      state.user = { id: ids.admin, role: "admin", name: "Admin" };
      const res = await get(
        `/api/setup/access-policies?projectId=${ids.projectA}`
      );
      expect(await res.json()).toEqual([
        { id: "pol-staff", name: "Staff" },
        { id: "pol-open", name: "Open" },
      ]);
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// The New environment API (server/services/new-environment) without a
// database: the context it reads, the order of its writes, and how it maps
// refusals. The services it drives (the setup, app registration, detection,
// builds) are stubbed; their own rules are tested in their own files.

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");

const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";
const APP_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const OPEN_SERVER = "0197f3a0-1b2c-7def-8000-0123456789c1";
const RESTRICTED_SERVER = "0197f3a0-1b2c-7def-8000-0123456789c2";
const DB_HOST = "0197f3a0-1b2c-7def-8000-0123456789d1";
const CI = "0197f3a0-1b2c-7def-8000-0123456789b1";
const ZONE = "0197f3a0-1b2c-7def-8000-0123456789e1";
const ENV_ID = "0197f3a0-1b2c-7def-8000-012345678901";
const TARGET_ID = "0197f3a0-1b2c-7def-8000-012345678902";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  projectRole: "engineer" as string | null,
  orgRole: "member",
  // Rows by table name; the fake db ignores `where` (fixtures are per test).
  rows: {} as Record<string, Row[]>,
  updates: [] as { table: string; values: Row; where: unknown }[],
  inserts: [] as string[],
  apps: [] as Row[],
  calls: [] as string[],
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "user-1", role: state.orgRole },
  })),
}));

vi.mock("@/lib/authz", async () => {
  const { canProject } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    getProjectAccess: vi.fn(async () => ({
      all: false,
      roles: { [PROJECT_ID]: state.projectRole },
    })),
    requireProjectPermission: vi.fn(
      async (_scope: unknown, perms: Parameters<typeof canProject>[1]) => {
        const role = state.projectRole;
        if (!role) throw new HTTPException(404, { message: "Not Found" });
        if (!canProject(role as "viewer", perms)) {
          throw new HTTPException(403, { message: "Forbidden" });
        }
        return {
          session: { user: { id: "user-1", role: state.orgRole } },
          role,
          projectId: PROJECT_ID,
        };
      }
    ),
  };
});

vi.mock("@/lib/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (table: unknown) => {
    const rows = () => state.rows[getTableName(table as never)] ?? [];
    const q: Record<string, unknown> = {};
    for (const m of ["where", "limit", "orderBy", "innerJoin", "leftJoin"]) {
      q[m] = () => q;
    }
    // biome-ignore lint/suspicious/noThenProperty: a drizzle query is awaited
    q.then = (resolve: (r: Row[]) => unknown, reject: () => unknown) =>
      Promise.resolve(rows()).then(resolve, reject);
    return q;
  };
  return {
    db: {
      select: () => ({ from: chain }),
      update: (table: unknown) => ({
        set: (values: Row) => ({
          where: async (where: unknown) => {
            state.updates.push({
              table: getTableName(table as never),
              values,
              where,
            });
          },
        }),
      }),
      insert: (table: unknown) => {
        state.inserts.push(getTableName(table as never));
        throw new Error("unexpected insert");
      },
      transaction: () => {
        throw new Error("unexpected transaction");
      },
    },
  };
});

vi.mock("@/lib/apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apps")>()),
  listApps: vi.fn(async () => state.apps),
}));

vi.mock("@/lib/domains/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/domains/repository")>()),
  listZones: vi.fn(async () => [{ id: ZONE, name: "Example.test" }]),
}));

vi.mock("@/lib/deploy/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deploy/repository")>()),
  flagDeployNextBuild: vi.fn(async (id: string) => {
    state.calls.push(`flag:${id}`);
  }),
}));

const detection = vi.hoisted(() => ({
  composeFile: "compose.yaml",
  composeOverrides: [] as string[],
  projectName: null,
  services: [
    {
      name: "web",
      image: null,
      build: ".",
      ports: [{ host: "8080", container: 80 }],
      profiles: [] as string[],
      containerName: null,
    },
  ],
  dockerfiles: ["Dockerfile"],
  pipeline: { kind: "none" } as
    | { kind: "none" }
    | { kind: "custom"; notifiesPanel: boolean },
  entryService: "web",
  entryContainerPort: 80,
  issues: [] as string[],
}));

vi.mock("@/server/services/setup-detect", () => ({
  detectComponentRepo: vi.fn(async () => {
    state.calls.push("detect");
    return detection;
  }),
}));

vi.mock("@/server/services/preflight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/preflight")>()),
  freeEntryPort: vi.fn(async () => 8104),
}));

vi.mock("@/server/services/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/environments")>()),
  uniqueEnvSlug: vi.fn(async () => "dev"),
}));

vi.mock("@/server/services/environment-domains", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/services/environment-domains")
  >()),
  listProjectAccessPolicies: vi.fn(async () => [
    { id: "pol-other", name: "Contractors" },
    { id: "pol-internal", name: "DSS Internal" },
  ]),
}));

vi.mock("@/server/services/ci-connections", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/services/ci-connections")
  >()),
  listConnectionOptions: vi.fn(async () => [
    { id: CI, name: "Woodpecker", forge: "bitbucket", hasForgeToken: true },
  ]),
  getProviderForConnection: vi.fn(async () => ({
    listRepos: async () => [
      {
        ciRepoId: "",
        fullName: "dss/panel-canary",
        forgeRemoteId: "{r1}",
        active: false,
      },
      {
        ciRepoId: "7",
        fullName: "dss/hris",
        forgeRemoteId: "{r2}",
        active: true,
      },
      {
        ciRepoId: "8",
        fullName: "dss/other-thing",
        forgeRemoteId: "{r3}",
        active: true,
        defaultBranch: "develop",
      },
    ],
  })),
}));

const setup = vi.hoisted(() => ({
  previewEnvironmentSetup: vi.fn(),
  createEnvironmentSetup: vi.fn(),
  getCopySource: vi.fn(),
}));
vi.mock("@/server/services/environment-setup", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/services/environment-setup")
  >()),
  ...setup,
}));

const apps = vi.hoisted(() => ({
  registerSetupApp: vi.fn(),
  addSetupComponents: vi.fn(),
  ensureComponentBranch: vi.fn(),
  triggerComponentBuild: vi.fn(),
}));
vi.mock("@/server/services/apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/apps")>()),
  ...apps,
}));

const { app } = await import("@/server/app");
const { PgDialect } = await import("drizzle-orm/pg-core");
type SQL = import("drizzle-orm").SQL;
const { CodedHTTPException } = await import("@/server/errors");

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const freshInput = {
  projectId: PROJECT_ID,
  name: "Dev",
  repos: [
    { ciConnectionId: CI, repoFullName: "dss/panel-canary", branch: "main" },
  ],
  needsDatabase: false,
  address: { label: "" },
  serverId: OPEN_SERVER,
};

const hrisApp = (pipelineMode: "custom" | "generated") => ({
  id: APP_ID,
  appKey: "hris",
  name: "HRIS",
  components: [
    {
      componentKey: "hris",
      appId: APP_ID,
      ciConnectionId: CI,
      repoFullName: "dss/hris",
      ciRepoId: "7",
      pipelineMode,
      buildSpec:
        pipelineMode === "generated"
          ? {
              branches: ["main"],
              images: [
                { name: "hris", dockerfile: "Dockerfile", context: "." },
              ],
              bundleFiles: [{ from: "compose.yaml", to: "compose.yaml" }],
              checks: [],
              timeoutMinutes: 60,
            }
          : null,
    },
  ],
});

const emptyPreview = {
  issues: [],
  plan: [],
  creates: [],
  suggestedEntryPort: 8104,
  suggestedServices: [],
  slug: "dev",
};

beforeEach(() => {
  state.projectRole = "engineer";
  state.orgRole = "member";
  state.rows = {
    projects: [{ id: PROJECT_ID, key: "PCAN", defaultServerId: null }],
    servers: [
      { id: OPEN_SERVER, name: "dev-1", placement: "open" },
      { id: RESTRICTED_SERVER, name: "prod-1", placement: "restricted" },
    ],
    database_hosts: [{ id: DB_HOST, serverId: OPEN_SERVER }],
    environment_services: [],
    environments: [],
    deploy_targets: [{ id: TARGET_ID }],
  };
  state.updates = [];
  state.inserts = [];
  state.apps = [];
  state.calls = [];
  detection.pipeline = { kind: "none" };
  for (const fn of [...Object.values(setup), ...Object.values(apps)]) {
    fn.mockReset();
  }
  setup.previewEnvironmentSetup.mockImplementation(async () => {
    state.calls.push("preview");
    return emptyPreview;
  });
  setup.createEnvironmentSetup.mockImplementation(async () => {
    state.calls.push("create");
    return {
      environmentId: ENV_ID,
      projectKey: "PCAN",
      envSlug: "dev",
      runId: "run-1",
    };
  });
  apps.registerSetupApp.mockImplementation(
    async (input: { appKey: string }) => {
      state.calls.push("register");
      return {
        app: { id: APP_ID, appKey: input.appKey, name: "x", components: [] },
        pipelineFileFailures: [],
      };
    }
  );
  apps.addSetupComponents.mockImplementation(async (appKey: string) => {
    state.calls.push("addComponents");
    return {
      app: { id: APP_ID, appKey, name: "x", components: [] },
      pipelineFileFailures: [],
    };
  });
  apps.ensureComponentBranch.mockImplementation(async () => {
    state.calls.push("ensureBranch");
    return { added: true, pipelineFileFailures: [] };
  });
  apps.triggerComponentBuild.mockImplementation(async () => {
    state.calls.push("build");
    return { number: 1 };
  });
});

describe("POST /api/setup/new-environment", () => {
  it("creates from a fresh repo", async () => {
    const res = await post("/api/setup/new-environment", freshInput);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      environmentId: ENV_ID,
      envSlug: "dev",
      runId: "run-1",
      buildFailures: [],
      pipelineFileFailures: [],
    });

    // One new app with one generated component, named from the repo.
    expect(apps.registerSetupApp).toHaveBeenCalledTimes(1);
    const registered = apps.registerSetupApp.mock.calls[0]?.[0];
    expect(registered).toMatchObject({
      appKey: "panel-canary",
      components: [
        {
          componentKey: "panel-canary",
          ciConnectionId: CI,
          forgeRemoteId: "{r1}",
          bundleImage: "panel-canary-deploy",
          pipelineMode: "generated",
          buildSpec: { branches: ["main"] },
        },
      ],
    });
    // The build spec is detection's (server-derived); the new environment's
    // branch is the one that builds.
    expect(apps.registerSetupApp.mock.calls[0]?.[1]).toEqual({
      "panel-canary": ["main"],
    });
    expect(apps.addSetupComponents).not.toHaveBeenCalled();

    // The resolved setup, on the registered app.
    const created = setup.createEnvironmentSetup.mock.calls[0]?.[0];
    expect(created).toMatchObject({
      projectId: PROJECT_ID,
      appId: APP_ID,
      name: "Dev",
      server: { serverId: OPEN_SERVER },
      targets: [{ componentKey: "panel-canary", sourceBranch: "main" }],
      domain: {
        kind: "tunnel",
        zoneId: ZONE,
        label: "pcan-dev",
        accessPolicyId: "pol-internal",
        entryPort: 8104,
      },
    });

    // Checked before registering. Provisioning started (runId) and flags
    // the targets itself, after its database and domain steps: never here.
    expect(state.calls).toEqual([
      "detect",
      "preview",
      "register",
      "create",
      "build",
    ]);
    const deploys = await import("@/lib/deploy/repository");
    expect(deploys.flagDeployNextBuild).not.toHaveBeenCalled();
    expect(apps.triggerComponentBuild).toHaveBeenCalledWith(
      "panel-canary",
      "panel-canary",
      "main"
    );
  });

  it("first server choice becomes the project default", async () => {
    const res = await post("/api/setup/new-environment", freshInput);
    expect(res.status).toBe(201);
    expect(state.updates).toMatchObject([
      { table: "projects", values: { defaultServerId: OPEN_SERVER } },
    ]);
    // Only while the project has none: a default set meanwhile stays.
    const { sql, params } = new PgDialect().sqlToQuery(
      state.updates[0]?.where as SQL
    );
    expect(sql).toBe(
      '(("projects"."id" = $1) and (("projects"."default_server_id" is null)))'
    );
    expect(params).toEqual([PROJECT_ID]);
  });

  it("a server manager's restricted choice becomes the default", async () => {
    state.orgRole = "admin";
    const res = await post("/api/setup/new-environment", {
      ...freshInput,
      serverId: RESTRICTED_SERVER,
    });
    expect(res.status).toBe(201);
    expect(state.updates).toMatchObject([
      { table: "projects", values: { defaultServerId: RESTRICTED_SERVER } },
    ]);
  });

  it("an engineer cannot make a restricted server the default", async () => {
    const res = await post("/api/setup/new-environment", {
      ...freshInput,
      serverId: RESTRICTED_SERVER,
    });
    // Not placeable for the engineer: refused before anything is written.
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid" });
    expect(state.updates).toEqual([]);
    expect(setup.createEnvironmentSetup).not.toHaveBeenCalled();
  });

  it("never overwrites a set default, even with another choice", async () => {
    state.orgRole = "admin";
    state.rows.projects = [
      { id: PROJECT_ID, key: "PCAN", defaultServerId: OPEN_SERVER },
    ];
    const res = await post("/api/setup/new-environment", {
      ...freshInput,
      serverId: RESTRICTED_SERVER,
    });
    expect(res.status).toBe(201);
    expect(state.updates).toEqual([]);
  });

  it("keeps an existing project default", async () => {
    state.rows.projects = [
      { id: PROJECT_ID, key: "PCAN", defaultServerId: OPEN_SERVER },
    ];
    const res = await post("/api/setup/new-environment", {
      ...freshInput,
      serverId: undefined,
    });
    expect(res.status).toBe(201);
    expect(state.updates).toEqual([]);
  });

  it("adds the environment branch", async () => {
    state.apps = [hrisApp("generated")];
    const res = await post("/api/setup/new-environment", {
      ...freshInput,
      repos: [{ ciConnectionId: CI, repoFullName: "dss/hris", branch: "uat" }],
    });
    expect(res.status).toBe(201);
    expect(apps.registerSetupApp).not.toHaveBeenCalled();
    expect(apps.addSetupComponents).not.toHaveBeenCalled();
    expect(apps.ensureComponentBranch).toHaveBeenCalledWith(
      "hris",
      "uat",
      PROJECT_ID
    );
    expect(setup.createEnvironmentSetup.mock.calls[0]?.[0]).toMatchObject({
      appId: APP_ID,
      targets: [{ componentKey: "hris", sourceBranch: "uat" }],
    });
    expect(state.calls.indexOf("ensureBranch")).toBeLessThan(
      state.calls.indexOf("create")
    );
  });

  it("adds a new repo to the app of a registered one", async () => {
    state.apps = [hrisApp("custom")];
    const res = await post("/api/setup/new-environment", {
      ...freshInput,
      repos: [
        { ciConnectionId: CI, repoFullName: "dss/hris", branch: "main" },
        {
          ciConnectionId: CI,
          repoFullName: "dss/panel-canary",
          branch: "main",
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(apps.registerSetupApp).not.toHaveBeenCalled();
    expect(apps.addSetupComponents).toHaveBeenCalledWith(
      "hris",
      [
        expect.objectContaining({
          componentKey: "panel-canary",
          forgeRemoteId: "{r1}",
        }),
      ],
      { hris: ["main"], "panel-canary": ["main"] }
    );
    // The new component is not checked against the app before it exists.
    expect(setup.previewEnvironmentSetup.mock.calls[0]?.[0]).toMatchObject({
      appId: APP_ID,
    });
  });

  it("unique violation maps to an issue", async () => {
    for (const [refusal, code] of [
      ["environmentNameTaken", "nameTaken"],
      ["environmentSlugTaken", "nameTaken"],
      ["domainHostnameTaken", "domainTaken"],
    ] as const) {
      setup.createEnvironmentSetup.mockRejectedValueOnce(
        new CodedHTTPException(409, refusal, "taken")
      );
      const res = await post("/api/setup/new-environment", freshInput);
      expect(res.status, refusal).toBe(409);
      expect(await res.json(), refusal).toMatchObject({ code });
    }
  });

  it("refuses before registering when the setup checks fail", async () => {
    setup.previewEnvironmentSetup.mockResolvedValueOnce({
      ...emptyPreview,
      issues: [
        { field: "appId", code: "appNotFound" },
        { field: "name", code: "environmentNameTaken" },
      ],
    });
    const res = await post("/api/setup/new-environment", freshInput);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "nameTaken" });
    expect(apps.registerSetupApp).not.toHaveBeenCalled();
    expect(setup.createEnvironmentSetup).not.toHaveBeenCalled();
  });

  it("a failed registration leaves no environment", async () => {
    apps.registerSetupApp.mockRejectedValueOnce(
      new CodedHTTPException(409, "pipelineFileExists", "exists")
    );
    const res = await post("/api/setup/new-environment", freshInput);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "pipelineFileExists" });
    expect(setup.createEnvironmentSetup).not.toHaveBeenCalled();
  });

  it("returns pipeline file commit failures per branch", async () => {
    const failure = {
      componentKey: "panel-canary",
      branch: "main",
      code: null,
      error: "Branch main does not exist",
    };
    apps.registerSetupApp.mockResolvedValueOnce({
      app: { id: APP_ID, appKey: "panel-canary", name: "x", components: [] },
      pipelineFileFailures: [failure],
    });
    const res = await post("/api/setup/new-environment", freshInput);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ pipelineFileFailures: [failure] });
  });

  it("returns the added branch's pipeline file failure", async () => {
    state.apps = [hrisApp("generated")];
    const failure = {
      componentKey: "hris",
      branch: "uat",
      code: "pipelineFileExists",
      error: "pipelineFileExists",
    };
    apps.ensureComponentBranch.mockResolvedValueOnce({
      added: true,
      pipelineFileFailures: [failure],
    });
    const res = await post("/api/setup/new-environment", {
      ...freshInput,
      repos: [{ ciConnectionId: CI, repoFullName: "dss/hris", branch: "uat" }],
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ pipelineFileFailures: [failure] });
  });

  it("reports a failed first build without failing the create", async () => {
    apps.triggerComponentBuild.mockRejectedValueOnce(
      new CodedHTTPException(409, "componentNotActivated", "no repo")
    );
    const res = await post("/api/setup/new-environment", freshInput);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      environmentId: ENV_ID,
      buildFailures: [
        { componentKey: "panel-canary", code: "componentNotActivated" },
      ],
    });
  });

  it("answers stable codes when a repo cannot be read", async () => {
    const { HTTPException } = await import("hono/http-exception");
    const detect = await import("@/server/services/setup-detect");
    for (const [status, code] of [
      [400, "repoUnreadable"],
      [404, "repoNotFound"],
      [502, "ciUnavailable"],
    ] as const) {
      vi.mocked(detect.detectComponentRepo).mockRejectedValueOnce(
        new HTTPException(status, { message: "x" })
      );
      const res = await post("/api/setup/new-environment/preview", freshInput);
      expect(res.status, code).toBe(status);
      expect(await res.json(), code).toMatchObject({ code });
    }
  });

  it("answers repoNotFound when the CI server no longer lists the repo", async () => {
    const ci = await import("@/server/services/ci-connections");
    vi.mocked(ci.getProviderForConnection).mockResolvedValueOnce({
      listRepos: async () => [],
    } as never);
    const res = await post("/api/setup/new-environment", freshInput);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "repoNotFound" });
    expect(apps.registerSetupApp).not.toHaveBeenCalled();
  });

  it("answers ciUnavailable when the CI server fails", async () => {
    const ci = await import("@/server/services/ci-connections");
    const { CiProviderError } = await import("@/lib/ci/types");
    vi.mocked(ci.getProviderForConnection).mockResolvedValueOnce({
      listRepos: async () => {
        throw new CiProviderError("down", 503);
      },
    } as never);
    const res = await post("/api/setup/new-environment", freshInput);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "ciUnavailable" });
  });

  it("only an integration manager chooses a pipeline", async () => {
    const chosen = {
      ...freshInput,
      advanced: {
        pipelines: [{ repoFullName: "dss/panel-canary", mode: "custom" }],
      },
    };
    for (const path of [
      "/api/setup/new-environment",
      "/api/setup/new-environment/preview",
    ]) {
      const res = await post(path, chosen);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toMatchObject({ code: "pipelineForbidden" });
    }
    expect(state.calls).toEqual([]);
    state.orgRole = "admin";
    const res = await post("/api/setup/new-environment/preview", chosen);
    expect(res.status).toBe(200);
    expect((await res.json()).plan.registrations[0]).toMatchObject({
      pipelineMode: "custom",
      buildSpec: null,
    });
  });

  it("qa cannot create environments", async () => {
    state.projectRole = "qa";
    for (const path of [
      "/api/setup/new-environment",
      "/api/setup/new-environment/preview",
    ]) {
      const res = await post(path, freshInput);
      expect(res.status, path).toBe(403);
    }
    expect(state.calls).toEqual([]);
  });
});

describe("POST /api/setup/new-environment/preview", () => {
  it("does not register anything or write the database", async () => {
    const res = await post("/api/setup/new-environment/preview", freshInput);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.issues).toEqual([]);
    expect(body.plan.summary).toEqual({
      serverName: "dev-1",
      port: 8104,
      databaseName: null,
      url: "https://pcan-dev.example.test",
    });
    // The setup preview ran for the not-yet-registered app, without the
    // refusal its absence causes.
    expect(body.preview).toMatchObject({ issues: [], slug: "dev" });
    expect(apps.registerSetupApp).not.toHaveBeenCalled();
    expect(apps.addSetupComponents).not.toHaveBeenCalled();
    expect(apps.ensureComponentBranch).not.toHaveBeenCalled();
    expect(apps.triggerComponentBuild).not.toHaveBeenCalled();
    expect(setup.createEnvironmentSetup).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
    expect(state.inserts).toEqual([]);
  });

  it("port suggestion survives other issues", async () => {
    // The server has no database host: a shared database is refused.
    state.rows.database_hosts = [];
    const res = await post("/api/setup/new-environment/preview", {
      ...freshInput,
      needsDatabase: true,
      advanced: { database: { kind: "shared" } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.issues).toEqual([
      { field: "database.databaseHostId", code: "required" },
    ]);
    expect(body.plan.summary.port).toBe(8104);
    expect(body.preview).toBeNull();
    expect(setup.previewEnvironmentSetup).not.toHaveBeenCalled();
  });

  it("suggests a database name free of the copy source's", async () => {
    state.apps = [hrisApp("custom")];
    state.rows.environments = [{ appId: APP_ID }];
    // The copy source's own database, on another host.
    state.rows.environment_services = [
      { dbName: "pcan_dev", dbRole: "pcan_dev", dbUser: null },
    ];
    setup.getCopySource.mockResolvedValue({
      environment: { id: ENV_ID, name: "Dev", projectId: PROJECT_ID },
      serverId: OPEN_SERVER,
      targets: [
        {
          componentKey: "hris",
          sourceBranch: "main",
          autoDeploy: true,
          deployDir: "/deployments/pcan-dev",
          services: ["web"],
          tagVariable: "IMAGE_TAG",
          preStartCommand: null,
          healthUrl: null,
          healthTimeoutSeconds: 180,
          backupBeforeDeploy: false,
        },
      ],
      database: { kind: "shared", databaseHostId: DB_HOST },
      domain: { kind: "none", zoneId: null, accessPolicyId: null },
      variables: [],
    });
    const res = await post("/api/setup/new-environment/preview", {
      ...freshInput,
      copyFromEnvironmentId: ENV_ID,
      repos: [],
      needsDatabase: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.summary.databaseName).toBe("pcan_dev2");
    expect(body.plan.setup.targets).toMatchObject([
      { componentKey: "hris", sourceBranch: "main" },
    ]);
  });

  it("asks for an Access policy when Cloudflare cannot be read", async () => {
    const domains = await import("@/server/services/environment-domains");
    vi.mocked(domains.listProjectAccessPolicies).mockRejectedValueOnce(
      new Error("fetch failed")
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post("/api/setup/new-environment/preview", freshInput);
    errors.mockRestore();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.issues).toEqual([
      { field: "domain.accessPolicyId", code: "required" },
    ]);
  });

  it("offers only placeable servers", async () => {
    const res = await post("/api/setup/new-environment/preview", {
      ...freshInput,
      serverId: RESTRICTED_SERVER,
    });
    const body = await res.json();
    expect(body.plan.issues).toContainEqual({
      field: "serverId",
      code: "invalid",
    });
    expect(body.preview).toBeNull();
  });
});

describe("GET /api/setup/repos", () => {
  it("lists matching repos with the app that owns each", async () => {
    state.apps = [hrisApp("custom")];
    const res = await app.request("/api/setup/repos?q=h");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        ciConnectionId: CI,
        repoFullName: "dss/hris",
        appKey: "hris",
        appName: "HRIS",
        componentKey: "hris",
        // The CI server does not know it: the usual name.
        defaultBranch: "main",
      },
      {
        ciConnectionId: CI,
        repoFullName: "dss/other-thing",
        appKey: null,
        appName: null,
        componentKey: null,
        defaultBranch: "develop",
      },
    ]);
  });

  it("names a repo's non-artifact component when it builds several", async () => {
    // The artifact component's app sorts first.
    state.apps = [
      {
        id: "0197f3a0-1b2c-7def-8000-0123456789b0",
        appKey: "aaa-legacy",
        name: "Legacy",
        components: [
          {
            ...hrisApp("custom").components[0],
            componentKey: "hris-legacy-web",
            appId: "0197f3a0-1b2c-7def-8000-0123456789b0",
            pipelineMode: "generated",
            buildSpec: {
              branches: [],
              images: [],
              bundleFiles: [],
              artifact: { kind: "static", path: "dist" },
              checks: [
                { name: "b", image: "oven/bun:1", dir: ".", commands: ["x"] },
              ],
              timeoutMinutes: 60,
            },
          },
        ],
      },
      hrisApp("custom"),
    ];
    const res = await app.request("/api/setup/repos?q=hris");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([
      { repoFullName: "dss/hris", appKey: "hris", componentKey: "hris" },
    ]);
  });

  it("refuses a user who may not register repos", async () => {
    state.projectRole = "qa";
    const res = await app.request("/api/setup/repos?q=");
    expect(res.status).toBe(403);
  });
});

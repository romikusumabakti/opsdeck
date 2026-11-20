import { beforeEach, describe, expect, it, vi } from "vitest";

const CONN = "0197f3a0-1b2c-7def-8000-0123456789c1";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  orgRole: "qa" as string,
  projectRoles: {} as Record<string, string>,
  apps: [] as Row[],
  components: [] as Row[],
  calls: [] as string[],
  // The component's deploy targets (componentTargetBranches).
  targetBranches: [] as { projectId: string; sourceBranch: string }[],
  insertError: null as Error | null,
  secretWriteError: null as Error | null,
  // The newest stored pipeline URL of the component's builds.
  storedPipelineUrl: null as string | null,
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "user-1", role: state.orgRole },
    session: { signInMethod: "passkey" },
  })),
  getServerSession: vi.fn(async () => ({
    user: { id: "user-1", role: state.orgRole },
    session: { signInMethod: "passkey" },
  })),
}));

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

vi.mock("@/lib/authz", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/authz")>();
  const { canOrg } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    ...real,
    getProjectAccess: vi.fn(async () => ({
      all: false,
      roles: { ...state.projectRoles },
    })),
    requireOrgPermission: vi.fn(async (perms: Parameters<typeof canOrg>[1]) => {
      if (!canOrg(state.orgRole, perms)) {
        throw new HTTPException(403, { message: "Forbidden" });
      }
      return {
        user: { id: "user-1", role: state.orgRole },
        session: { signInMethod: "passkey" },
      };
    }),
  };
});

// Nothing here reaches the database: lib/apps and lib/service-catalog are
// faked over `state` below.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => {
      throw new Error("no database in this test");
    },
  },
}));

vi.mock("@/lib/apps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/apps")>();
  const strip = ({ notifySecret: _secret, ...rest }: Row) => rest;
  return {
    ...actual,
    appKeyExists: vi.fn(async (key: string) =>
      state.apps.some((a) => a.appKey === key)
    ),
    takenComponentKeys: vi.fn(async (keys: string[]) =>
      keys.filter((k) => state.components.some((c) => c.componentKey === k))
    ),
    linkedCiRepos: vi.fn(async (connectionId: string) =>
      state.components
        .filter((c) => c.ciConnectionId === connectionId)
        .map((c) => ({
          componentKey: c.componentKey,
          ciRepoId: c.ciRepoId,
          repoFullName: c.repoFullName,
        }))
    ),
    // Mirrors the SQL merge: one branch's entry is replaced, a failure keeps
    // that branch's last sha.
    setPipelineFileCommit: vi.fn(
      async (
        componentKey: string,
        branch: string,
        result: { sha: string } | { error: string }
      ) => {
        const c = state.components.find((x) => x.componentKey === componentKey);
        if (!c) return;
        const commits = (c.pipelineFileCommits ?? {}) as Record<
          string,
          { sha?: string; error?: string; at: string }
        >;
        const previous = commits[branch]?.sha;
        const at = new Date().toISOString();
        c.pipelineFileCommits = {
          ...commits,
          [branch]:
            "sha" in result
              ? { sha: result.sha, at }
              : {
                  ...(previous ? { sha: previous } : {}),
                  error: result.error,
                  at,
                },
        };
      }
    ),
    setNotifySecret: vi.fn(async (componentKey: string, value: string) => {
      state.calls.push("panel-secret");
      if (state.secretWriteError) throw state.secretWriteError;
      const c = state.components.find((x) => x.componentKey === componentKey);
      if (c) c.notifySecret = value;
    }),
    componentTargetBranches: vi.fn(async () => [...state.targetBranches]),
    latestComponentPipelineUrl: vi.fn(async () => state.storedPipelineUrl),
    // A service is found by key alone, with or without a legacy app.
    getComponent: vi.fn(async (componentKey: string) =>
      state.components.find((x) => x.componentKey === componentKey)
    ),
    getApp: vi.fn(async (appKey: string) => {
      const app = state.apps.find((a) => a.appKey === appKey);
      if (!app) return undefined;
      return {
        ...app,
        components: state.components
          .filter((c) => c.appId === app.id)
          .map(strip),
      };
    }),
  };
});

// The services layer over the same rows: registration inserts app-less rows.
vi.mock("@/lib/service-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/service-catalog")>();
  const asService = ({ notifySecret: _secret, appId: _app, ...rest }: Row) => ({
    key: rest.componentKey,
    ...rest,
  });
  return {
    ...actual,
    insertServices: vi.fn(async (rows: Row[]) => {
      state.calls.push("insert");
      if (state.insertError) throw state.insertError;
      for (const row of rows) {
        state.components.push({
          pipelineFileCommits: null,
          createdAt: new Date(),
          ...row,
          appId: null,
        });
      }
    }),
    getService: vi.fn(async (key: string) => {
      const c = state.components.find((x) => x.componentKey === key);
      return c ? asService(c) : null;
    }),
    listServices: vi.fn(async () => state.components.map(asService)),
    // The usage queries are covered on a real Postgres (services-scratch).
    listServiceOverview: vi.fn(async () =>
      state.components.map((c) => ({
        ...asService(c),
        ciConnectionName: "Woodpecker",
        projectCount: 2,
        environmentCount: 3,
        lastBuild: {
          branch: "main",
          tag: "main-abc1234",
          receivedAt: new Date(),
        },
      }))
    ),
    getServiceDetail: vi.fn(async (key: string) => {
      const c = state.components.find((x) => x.componentKey === key);
      return c
        ? {
            ...asService(c),
            ciConnectionName: "Woodpecker",
            lastBuild: null,
            projects: [{ id: "p1", key: "KES", name: "Kestrel" }],
            environments: [],
          }
        : null;
    }),
    legacyAppServices: vi.fn(async (key: string) => {
      const app = state.apps.find((a) => a.appKey === key);
      return state.components
        .filter((c) => (app ? c.appId === app.id : c.componentKey === key))
        .map((c) => ({ key: c.componentKey, repoFullName: c.repoFullName }));
    }),
  };
});

const provider = vi.hoisted(() => ({
  listRepos: vi.fn(),
  activateRepo: vi.fn(),
  updateRepoSettings: vi.fn(),
  upsertRepoSecret: vi.fn(),
  triggerPipeline: vi.fn(),
  listActivePipelines: vi.fn(),
}));

const connections = vi.hoisted(() => ({
  getProviderForConnection: vi.fn(),
  getForgeCredentials: vi.fn(),
  listConnectionOptions: vi.fn(),
}));
vi.mock("@/server/services/ci-connections", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...connections,
}));

const forge = vi.hoisted(() => ({
  commitFile: vi.fn(),
  branchExists: vi.fn(),
  readRepoFileOrLarge: vi.fn(),
  FILE_TOO_LARGE: Symbol("too-large"),
}));
vi.mock("@/lib/ci/forges/bitbucket", () => forge);

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { decryptSecret, encryptSecret } = await import("@/lib/secrets");
const { CiProviderError } = await import("@/lib/ci/types");
const { app } = await import("@/server/app");

const SPEC = {
  branches: ["main", "release/1.x"],
  tagShaLength: 7,
  images: [
    { name: "hris-backend", dockerfile: "backend/Dockerfile", context: "." },
  ],
  bundleFiles: [{ from: "deploy/compose.yaml", to: "compose.yaml" }],
  checks: [],
  timeoutMinutes: 45,
};

/** The item at `index`, failing the test when it is missing. */
function at<T>(items: readonly T[], index = 0): T {
  const item = items[index];
  if (item === undefined) throw new Error(`No item at ${index}`);
  return item;
}

function component(extra: Row = {}) {
  return {
    componentKey: "hris",
    ciConnectionId: CONN,
    forgeRemoteId: "{abc-123}",
    bundleImage: "hris-deploy",
    pipelineMode: "generated",
    buildSpec: SPEC,
    ...extra,
  };
}

function body(extra: Row = {}, comp: Row = {}) {
  return { services: [component(comp)], ...extra };
}

function send(method: string, path: string, payload?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

function existingComponent(extra: Row = {}) {
  return {
    componentKey: "accounting",
    appId: "0197f3a0-1b2c-7def-8000-0123456789a9",
    ciConnectionId: CONN,
    repoFullName: "acme/acme-accounting",
    ciRepoId: "1",
    bundleImage: "accounting-deploy",
    notifySecret: encryptSecret("old-notify-secret"),
    notifySecretName: "menara_notify",
    pipelineMode: "generated",
    buildSpec: SPEC,
    pipelineFileCommits: null,
    createdAt: new Date(),
    ...extra,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DEPLOY_REGISTRY", "192.168.10.113:5000");
  // Generated pipelines are for admins; maintainer cases set their role.
  state.orgRole = "admin";
  state.projectRoles = {};
  state.apps = [];
  state.components = [];
  state.calls = [];
  state.targetBranches = [];
  state.insertError = null;
  state.secretWriteError = null;
  state.storedPipelineUrl = null;
  connections.getProviderForConnection.mockResolvedValue(provider);
  connections.getForgeCredentials.mockResolvedValue({
    forge: "bitbucket",
    auth: { username: "ci-bot", token: "forge-token" },
  });
  connections.listConnectionOptions.mockResolvedValue([
    { id: CONN, name: "Woodpecker", forge: "bitbucket", hasForgeToken: true },
  ]);
  provider.activateRepo.mockImplementation(async (id: string) => {
    state.calls.push(`activate:${id}`);
    return {
      ciRepoId: "42",
      fullName: "acme/hris",
      forgeRemoteId: id,
      active: true,
    };
  });
  provider.updateRepoSettings.mockImplementation(async (id: string) => {
    state.calls.push(`settings:${id}`);
  });
  provider.upsertRepoSecret.mockImplementation(async (id: string) => {
    state.calls.push(`secret:${id}`);
  });
  forge.branchExists.mockResolvedValue(true);
  forge.readRepoFileOrLarge.mockResolvedValue(null);
  provider.listRepos.mockResolvedValue([]);
  forge.commitFile.mockImplementation(
    async (_auth: unknown, _repo: string, branch: string) => {
      state.calls.push(`commit:${branch}`);
      return { sha: `sha-${branch}` };
    }
  );
});

describe("permissions", () => {
  it("a member with only contributor roles gets 403 on every registrant route", async () => {
    state.orgRole = "qa";
    state.projectRoles = { "project-1": "qa" };
    state.apps = [{ id: "0197f3a0-1b2c-7def-8000-0123456789a9", appKey: "a" }];
    state.components = [
      existingComponent({ appId: "0197f3a0-1b2c-7def-8000-0123456789a9" }),
    ];
    expect((await send("POST", "/api/service-catalog", body())).status).toBe(
      403
    );
    expect(
      (await send("GET", `/api/ci-connections/${CONN}/repos`)).status
    ).toBe(403);
    expect((await send("GET", "/api/ci-connections/options")).status).toBe(403);
    const preview = new URLSearchParams({
      q: JSON.stringify({ componentKey: "hris", buildSpec: SPEC }),
    });
    expect(
      (await send("GET", `/api/service-catalog/pipeline-preview?${preview}`))
        .status
    ).toBe(403);
    expect(
      (await send("POST", "/api/service-catalog/accounting/rotate-secret"))
        .status
    ).toBe(403);
    expect(
      (
        await send(
          "POST",
          "/api/service-catalog/accounting/commit-pipeline-file"
        )
      ).status
    ).toBe(403);
    expect(provider.activateRepo).not.toHaveBeenCalled();
    expect(provider.upsertRepoSecret).not.toHaveBeenCalled();
  });

  it("a maintainer gets 403 on rotate-secret and commit-pipeline-file", async () => {
    state.orgRole = "engineer";
    state.projectRoles = { "project-1": "engineer" };
    state.apps = [{ id: "0197f3a0-1b2c-7def-8000-0123456789a9", appKey: "a" }];
    state.components = [existingComponent()];
    expect(
      (await send("POST", "/api/service-catalog/accounting/rotate-secret"))
        .status
    ).toBe(403);
    expect(
      (
        await send(
          "POST",
          "/api/service-catalog/accounting/commit-pipeline-file"
        )
      ).status
    ).toBe(403);
    expect(provider.upsertRepoSecret).not.toHaveBeenCalled();
    expect(forge.commitFile).not.toHaveBeenCalled();
  });

  it("any signed-in user may list services and resolve an old app URL", async () => {
    state.orgRole = "qa";
    state.projectRoles = {};
    expect((await send("GET", "/api/service-catalog")).status).toBe(200);
    expect(
      (await send("GET", "/api/service-catalog/legacy-apps/acme")).status
    ).toBe(200);
  });

  it("a maintainer gets 403 on the overview and a service's page", async () => {
    state.orgRole = "engineer";
    state.components = [existingComponent()];
    expect((await send("GET", "/api/service-catalog/overview")).status).toBe(
      403
    );
    expect((await send("GET", "/api/service-catalog/accounting")).status).toBe(
      403
    );
  });
});

describe("GET /api/service-catalog/overview and /:componentKey", () => {
  it("lists usage and the last build for an admin, never a notify secret", async () => {
    state.components = [existingComponent()];
    const res = await send("GET", "/api/service-catalog/overview");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('"notifySecret"');
    expect(text).not.toContain("enc:v1:");
    expect(JSON.parse(text)).toEqual([
      expect.objectContaining({
        key: "accounting",
        projectCount: 2,
        environmentCount: 3,
        lastBuild: expect.objectContaining({ tag: "main-abc1234" }),
      }),
    ]);
  });

  it("answers a service's page, or 404 for an unknown key", async () => {
    state.components = [existingComponent()];
    const res = await send("GET", "/api/service-catalog/accounting");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      key: "accounting",
      projects: [{ key: "KES" }],
    });
    expect((await send("GET", "/api/service-catalog/nope")).status).toBe(404);
  });
});

describe("GET /api/service-catalog/legacy-apps/:appKey", () => {
  it("answers the old app's services by key and repository", async () => {
    state.apps = [
      { id: "0197f3a0-1b2c-7def-8000-0123456789a9", appKey: "acme", name: "A" },
    ];
    state.components = [
      existingComponent(),
      existingComponent({ componentKey: "billing", appId: null }),
    ];
    const res = await send("GET", "/api/service-catalog/legacy-apps/acme");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      services: [{ key: "accounting", repoFullName: "acme/acme-accounting" }],
    });
  });
});

describe("GET /api/service-catalog", () => {
  it("lists every service, with or without an app, never its notify secret", async () => {
    state.components = [
      existingComponent(),
      existingComponent({ componentKey: "billing", appId: null }),
    ];
    const res = await send("GET", "/api/service-catalog");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('"notifySecret"');
    expect(text).not.toContain("enc:v1:");
    expect(JSON.parse(text).map((s: Row) => s.key)).toEqual([
      "accounting",
      "billing",
    ]);
  });
});

describe("removed /api/apps routes", () => {
  it.each([
    ["GET", "/api/apps"],
    ["POST", "/api/apps"],
    ["GET", "/api/apps/pipeline-preview"],
    ["POST", "/api/apps/a/components/accounting/build"],
    ["GET", "/api/apps/a/components/accounting/builds/active?branch=main"],
    ["POST", "/api/apps/a/components/accounting/rotate-secret"],
    ["POST", "/api/apps/a/components/accounting/commit-pipeline-file"],
  ])("%s %s is gone (moved to /api/service-catalog)", async (method, path) => {
    state.components = [existingComponent()];
    expect(
      (await send(method, path, method === "POST" ? {} : undefined)).status
    ).toBe(404);
    expect(provider.activateRepo).not.toHaveBeenCalled();
    expect(provider.upsertRepoSecret).not.toHaveBeenCalled();
    expect(provider.triggerPipeline).not.toHaveBeenCalled();
  });
});

describe("POST /api/service-catalog (register services)", () => {
  it("calls the provider in order and stores an encrypted secret", async () => {
    const res = await send("POST", "/api/service-catalog", body());
    expect(res.status).toBe(201);
    expect(state.calls).toEqual([
      "activate:{abc-123}",
      "settings:42",
      "secret:42",
      "insert",
      "commit:main",
      "commit:release/1.x",
    ]);
    // The configuration extension is not used: registration clears it.
    expect(provider.updateRepoSettings).toHaveBeenCalledWith("42", {
      timeoutMinutes: 45,
      cancelPreviousOnPush: true,
      configExtensionEndpoint: null,
    });
    const [, name, secret, events] = at(provider.upsertRepoSecret.mock.calls);
    expect(name).toBe("menara_notify");
    expect(events).toEqual(["push", "manual"]);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    const stored = state.components.find((c) => c.componentKey === "hris");
    expect(stored).toMatchObject({
      ciConnectionId: CONN,
      repoFullName: "acme/hris",
      ciRepoId: "42",
      bundleImage: "hris-deploy",
      pipelineMode: "generated",
      pipelineFileCommits: {
        main: { sha: "sha-main", at: expect.any(String) },
        "release/1.x": { sha: "sha-release/1.x", at: expect.any(String) },
      },
    });
    expect(stored?.notifySecret).not.toBe(secret);
    expect(decryptSecret(stored?.notifySecret as string)).toBe(secret);

    const text = await res.text();
    expect(text).not.toContain(secret);
    // The secret's Woodpecker name (notifySecretName) is public.
    expect(text).not.toContain('"notifySecret"');

    expect(forge.commitFile).toHaveBeenCalledTimes(2);
    const [auth, repo, branch, path, content] = at(forge.commitFile.mock.calls);
    expect(auth).toEqual({ username: "ci-bot", token: "forge-token" });
    expect(repo).toBe("acme/hris");
    expect(branch).toBe("main");
    expect(path).toBe(".woodpecker.yaml");
    expect(content).toContain("hris-deploy");
    expect(at(forge.commitFile.mock.calls, 1)[2]).toBe("release/1.x");
  });

  it("clears the configuration extension for custom components too", async () => {
    const res = await send(
      "POST",
      "/api/service-catalog",
      body({}, { pipelineMode: "custom", buildSpec: undefined })
    );
    expect(res.status).toBe(201);
    expect(
      at(provider.updateRepoSettings.mock.calls)[1].configExtensionEndpoint
    ).toBeNull();
  });

  it("refuses an engineer a generated component (403 pipelineForbidden)", async () => {
    state.orgRole = "engineer";
    state.projectRoles = { "project-1": "engineer" };
    const res = await send("POST", "/api/service-catalog", body());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "pipelineForbidden" });
    expect(provider.activateRepo).not.toHaveBeenCalled();
    expect(forge.commitFile).not.toHaveBeenCalled();
    expect(state.components).toHaveLength(0);
  });

  it("refuses infra a generated component (403 pipelineForbidden)", async () => {
    state.orgRole = "infra";
    const res = await send("POST", "/api/service-catalog", body());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "pipelineForbidden" });
    expect(provider.activateRepo).not.toHaveBeenCalled();
  });

  it("lets a maintainer register a custom component (201)", async () => {
    state.orgRole = "engineer";
    state.projectRoles = { "project-1": "engineer" };
    const res = await send(
      "POST",
      "/api/service-catalog",
      body({}, { pipelineMode: "custom", buildSpec: undefined })
    );
    expect(res.status).toBe(201);
    expect(state.components).toHaveLength(1);
    expect(forge.commitFile).not.toHaveBeenCalled();
  });

  it("uses a 60 minute timeout and commits nothing for custom components", async () => {
    const res = await send(
      "POST",
      "/api/service-catalog",
      body({}, { pipelineMode: "custom", buildSpec: undefined })
    );
    expect(res.status).toBe(201);
    expect(at(provider.updateRepoSettings.mock.calls)[1].timeoutMinutes).toBe(
      60
    );
    expect(forge.commitFile).not.toHaveBeenCalled();
  });

  it("reuses a repo Woodpecker already has active (Review Focus 3)", async () => {
    provider.activateRepo.mockImplementation(async (id: string) => {
      state.calls.push(`activate:${id}`);
      // What the provider returns after Woodpecker's 409: the existing repo.
      return {
        ciRepoId: "6",
        fullName: "acme/hris",
        forgeRemoteId: id,
        active: true,
      };
    });
    const res = await send("POST", "/api/service-catalog", body());
    expect(res.status).toBe(201);
    expect(provider.activateRepo).toHaveBeenCalledTimes(1);
    expect(at(provider.updateRepoSettings.mock.calls)[0]).toBe("6");
    expect(state.components).toHaveLength(1);
    expect(at(state.components).ciRepoId).toBe("6");
  });

  it("answers 502 naming the step and inserts nothing when Woodpecker fails", async () => {
    provider.upsertRepoSecret.mockRejectedValue(
      new CiProviderError(
        "Woodpecker POST /api/repos/42/secrets failed with 500",
        500
      )
    );
    const res = await send("POST", "/api/service-catalog", body());
    expect(res.status).toBe(502);
    const { error } = await res.json();
    expect(error).toContain("notify secret");
    expect(error).toContain("failed with 500");
    expect(state.calls).not.toContain("insert");
    expect(state.components).toHaveLength(0);
  });

  it("answers 502 for a failed activation without touching settings", async () => {
    provider.activateRepo.mockRejectedValue(
      new CiProviderError("Woodpecker POST /api/repos failed with 500", 500)
    );
    const res = await send("POST", "/api/service-catalog", body());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Activating/);
    expect(provider.updateRepoSettings).not.toHaveBeenCalled();
    expect(state.components).toHaveLength(0);
  });

  it("records a failed branch and still commits the others (Review Focus 4)", async () => {
    forge.commitFile.mockImplementation(
      async (_auth: unknown, _repo: string, branch: string) => {
        state.calls.push(`commit:${branch}`);
        if (branch === "main") {
          throw new CiProviderError(
            "Bitbucket POST acme/hris/src failed with 403: branch is protected",
            403
          );
        }
        return { sha: `sha-${branch}` };
      }
    );
    const res = await send("POST", "/api/service-catalog", body());
    expect(res.status).toBe(201);
    expect(state.calls).toContain("commit:release/1.x");
    const created = await res.json();
    expect(created.services[0].pipelineFileCommits).toEqual({
      main: {
        error:
          "Bitbucket POST acme/hris/src failed with 403: branch is protected",
        at: expect.any(String),
      },
      "release/1.x": { sha: "sha-release/1.x", at: expect.any(String) },
    });
    expect(state.components).toHaveLength(1);
  });

  it("records a missing branch without committing and still commits the others", async () => {
    forge.branchExists.mockImplementation(
      async (_auth: unknown, _repo: string, branch: string) =>
        branch !== "release/1.x"
    );
    const res = await send("POST", "/api/service-catalog", body());
    expect(res.status).toBe(201);
    expect(state.calls).toContain("commit:main");
    expect(state.calls).not.toContain("commit:release/1.x");
    expect(forge.commitFile).toHaveBeenCalledTimes(1);
    const commits = at(state.components).pipelineFileCommits as Record<
      string,
      Row
    >;
    expect(commits.main).toMatchObject({ sha: "sha-main" });
    expect(commits["release/1.x"]).toEqual({
      error: "Branch release/1.x does not exist",
      at: expect.any(String),
    });
  });

  it("keeps the registration when an unexpected error hits one branch", async () => {
    forge.commitFile.mockImplementation(
      async (_auth: unknown, _repo: string, branch: string) => {
        if (branch === "main") throw new Error("socket hang up");
        return { sha: `sha-${branch}` };
      }
    );
    const res = await send("POST", "/api/service-catalog", body());
    expect(res.status).toBe(201);
    const commits = at(state.components).pipelineFileCommits as Row;
    expect(commits.main).toMatchObject({
      error: "The commit failed unexpectedly",
    });
    expect(commits["release/1.x"]).toMatchObject({ sha: "sha-release/1.x" });
  });

  it("records a missing forge token on every branch", async () => {
    connections.getForgeCredentials.mockResolvedValue({
      forge: "bitbucket",
      auth: null,
    });
    const res = await send("POST", "/api/service-catalog", body());
    expect(res.status).toBe(201);
    expect(forge.commitFile).not.toHaveBeenCalled();
    const commits = at(state.components).pipelineFileCommits as Record<
      string,
      Row
    >;
    expect(Object.keys(commits)).toEqual(["main", "release/1.x"]);
    expect(commits.main?.error).toMatch(/forge token/);
    expect(commits["release/1.x"]?.error).toMatch(/forge token/);
  });

  it("registers services without an app: app_id null, no app row (service-first)", async () => {
    const res = await send("POST", "/api/service-catalog", body());
    expect(res.status).toBe(201);
    expect(state.apps).toHaveLength(0);
    expect(at(state.components)).toMatchObject({
      componentKey: "hris",
      appId: null,
    });
    const created = await res.json();
    expect(created.services.map((s: Row) => s.key)).toEqual(["hris"]);
    expect(created.pipelineFileFailures).toEqual([]);
  });

  it("answers 409 for an existing component key", async () => {
    state.components = [existingComponent({ componentKey: "hris" })];
    const res = await send("POST", "/api/service-catalog", body());
    expect(res.status).toBe(409);
    expect(provider.activateRepo).not.toHaveBeenCalled();
  });

  it("registers another service of a linked repository under its own notify secret, keeping the repo settings", async () => {
    state.components = [existingComponent({ ciRepoId: "42" })];
    const res = await send(
      "POST",
      "/api/service-catalog",
      body({}, { pipelineMode: "custom", buildSpec: undefined })
    );
    expect(res.status).toBe(201);
    // The repository's first service applied the settings; they stay.
    expect(provider.updateRepoSettings).not.toHaveBeenCalled();
    const [repoId, name] = at(provider.upsertRepoSecret.mock.calls);
    expect(repoId).toBe("42");
    expect(name).toBe("menara_notify_hris");
    expect(
      state.components.find((c) => c.componentKey === "hris")
    ).toMatchObject({ notifySecretName: "menara_notify_hris", appId: null });
  });

  it("registers several services of one repository in one go, the first under the default secret", async () => {
    const res = await send("POST", "/api/service-catalog", {
      services: [
        component({ pipelineMode: "custom", buildSpec: undefined }),
        component({
          componentKey: "hris-worker",
          bundleImage: "hris-worker-deploy",
          pipelineMode: "custom",
          buildSpec: undefined,
        }),
      ],
    });
    expect(res.status).toBe(201);
    expect(provider.updateRepoSettings).toHaveBeenCalledTimes(1);
    expect(provider.upsertRepoSecret.mock.calls.map((call) => call[1])).toEqual(
      ["menara_notify", "menara_notify_hris_worker"]
    );
    expect(
      state.components.map((c) => [c.componentKey, c.notifySecretName])
    ).toEqual([
      ["hris", "menara_notify"],
      ["hris-worker", "menara_notify_hris_worker"],
    ]);
  });

  it("refuses two generated services of one repository on the same branch (400)", async () => {
    const res = await send("POST", "/api/service-catalog", {
      services: [
        component(),
        component({
          componentKey: "hris-worker",
          bundleImage: "hris-worker-deploy",
          buildSpec: {
            ...SPEC,
            branches: ["main"],
            images: [
              { name: "hris-worker", dockerfile: "Dockerfile", context: "." },
            ],
          },
        }),
      ],
    });
    expect(res.status).toBe(400);
    expect(provider.activateRepo).not.toHaveBeenCalled();
  });

  it("maps a unique violation on insert to 409 that says to rotate", async () => {
    state.insertError = Object.assign(new Error("dup"), { code: "23505" });
    const res = await send("POST", "/api/service-catalog", body());
    expect(res.status).toBe(409);
    // The losing request has already replaced the Woodpecker secret.
    expect((await res.json()).error).toBe(
      "A service was registered meanwhile. Woodpecker may now hold a notify secret Menara does not know: rotate the notify secret of hris on its service page."
    );
  });

  it("lets a registrant preview the generated pipeline", async () => {
    const preview = new URLSearchParams({
      q: JSON.stringify({ componentKey: "hris", buildSpec: SPEC }),
    });
    const res = await send(
      "GET",
      `/api/service-catalog/pipeline-preview?${preview}`
    );
    expect(res.status).toBe(200);
    expect((await res.json()).yaml).toContain("hris-deploy");
  });

  it("rejects a bundle image other than <componentKey>-deploy", async () => {
    const res = await send(
      "POST",
      "/api/service-catalog",
      body({}, { bundleImage: "something-else" })
    );
    expect(res.status).toBe(400);
  });

  it("rejects a build image named like the bundle image", async () => {
    const res = await send(
      "POST",
      "/api/service-catalog",
      body(
        {},
        {
          buildSpec: {
            ...SPEC,
            images: [
              { name: "hris-deploy", dockerfile: "Dockerfile", context: "." },
            ],
          },
        }
      )
    );
    expect(res.status).toBe(400);
    expect(provider.activateRepo).not.toHaveBeenCalled();
  });

  it("requires a build spec exactly when the mode is generated", async () => {
    expect(
      (
        await send(
          "POST",
          "/api/service-catalog",
          body({}, { buildSpec: undefined })
        )
      ).status
    ).toBe(400);
    expect(
      (
        await send(
          "POST",
          "/api/service-catalog",
          body({}, { pipelineMode: "custom" })
        )
      ).status
    ).toBe(400);
  });
});

describe("GET /api/ci-connections/:id/repos", () => {
  it("marks repos already linked to a component", async () => {
    state.components = [existingComponent()];
    provider.listRepos.mockResolvedValue([
      {
        ciRepoId: "1",
        fullName: "acme/acme-accounting",
        forgeRemoteId: "{a}",
        active: true,
      },
      {
        ciRepoId: "",
        fullName: "acme/new",
        forgeRemoteId: "{b}",
        active: false,
      },
    ]);
    const res = await send("GET", `/api/ci-connections/${CONN}/repos`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        ciRepoId: "1",
        fullName: "acme/acme-accounting",
        forgeRemoteId: "{a}",
        active: true,
        linkedComponentKey: "accounting",
      },
      {
        ciRepoId: "",
        fullName: "acme/new",
        forgeRemoteId: "{b}",
        active: false,
        linkedComponentKey: null,
      },
    ]);
  });

  it("lets infra list repos", async () => {
    state.orgRole = "infra";
    state.projectRoles = {};
    provider.listRepos.mockResolvedValue([]);
    expect(
      (await send("GET", `/api/ci-connections/${CONN}/repos`)).status
    ).toBe(200);
  });
});

describe("POST rotate-secret (Review Focus 5)", () => {
  const PATH = "/api/service-catalog/accounting/rotate-secret";

  beforeEach(() => {
    state.apps = [
      { id: "0197f3a0-1b2c-7def-8000-0123456789a9", appKey: "a", name: "A" },
    ];
    state.components = [existingComponent()];
  });

  it("updates Woodpecker first, then the Panel, for an admin", async () => {
    const res = await send("POST", PATH);
    expect(res.status).toBe(200);
    expect(state.calls).toEqual(["secret:1", "panel-secret"]);
    const [, name, secret, events] = at(provider.upsertRepoSecret.mock.calls);
    expect(name).toBe("menara_notify");
    expect(events).toEqual(["push", "manual"]);
    expect(decryptSecret(at(state.components).notifySecret as string)).toBe(
      secret
    );
    expect(await res.text()).not.toContain(secret);
  });

  it("reports a Woodpecker failure and leaves the Panel secret", async () => {
    const before = at(state.components).notifySecret;
    provider.upsertRepoSecret.mockRejectedValue(
      new CiProviderError("Woodpecker GET failed with 500", 500)
    );
    const res = await send("POST", PATH);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      "Woodpecker secret not updated; Menara secret unchanged"
    );
    expect(state.calls).not.toContain("panel-secret");
    expect(at(state.components).notifySecret).toBe(before);
  });

  it("reports a Panel failure after Woodpecker succeeded", async () => {
    state.secretWriteError = new Error("connection lost");
    const res = await send("POST", PATH);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe(
      "Woodpecker has the new secret but Menara does not — rotate again"
    );
  });

  it("answers 404 for an unknown service", async () => {
    const res = await send(
      "POST",
      "/api/service-catalog/no-such-service/rotate-secret"
    );
    expect(res.status).toBe(404);
    expect(provider.upsertRepoSecret).not.toHaveBeenCalled();
  });

  it("rotates the secret of a service registered without an app", async () => {
    state.apps = [];
    state.components = [existingComponent({ appId: null })];
    expect((await send("POST", PATH)).status).toBe(200);
    expect(state.calls).toEqual(["secret:1", "panel-secret"]);
  });

  it("answers 409 when the component has no CI repo", async () => {
    state.components = [existingComponent({ ciRepoId: null })];
    expect((await send("POST", PATH)).status).toBe(409);
  });
});

describe("POST commit-pipeline-file", () => {
  const PATH = "/api/service-catalog/accounting/commit-pipeline-file";

  beforeEach(() => {
    state.apps = [
      { id: "0197f3a0-1b2c-7def-8000-0123456789a9", appKey: "a", name: "A" },
    ];
    state.components = [
      existingComponent({
        pipelineFileCommits: {
          main: { sha: "old-main", error: "expired token", at: "x" },
          "release/1.x": { error: "expired token", at: "x" },
        },
      }),
    ];
  });

  it("retries every branch and clears the errors", async () => {
    const res = await send("POST", PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      componentKey: "accounting",
      pipelineFileCommits: {
        main: { sha: "sha-main" },
        "release/1.x": { sha: "sha-release/1.x" },
      },
    });
    expect(state.calls).toEqual(["commit:main", "commit:release/1.x"]);
    expect(at(forge.commitFile.mock.calls)[1]).toBe("acme/acme-accounting");
  });

  it("retries only the branch given in ?branch=", async () => {
    const res = await send(
      "POST",
      `${PATH}?${new URLSearchParams({ branch: "release/1.x" })}`
    );
    expect(res.status).toBe(200);
    expect(state.calls).toEqual(["commit:release/1.x"]);
    const commits = (await res.json()).pipelineFileCommits;
    expect(commits["release/1.x"]).toMatchObject({ sha: "sha-release/1.x" });
    expect(commits.main).toMatchObject({ error: "expired token" });
  });

  it("answers 400 for a branch the build spec does not build", async () => {
    const res = await send("POST", `${PATH}?branch=develop`);
    expect(res.status).toBe(400);
    expect(forge.commitFile).not.toHaveBeenCalled();
  });

  it("stores the new reason and keeps the last sha when the retry fails", async () => {
    forge.commitFile.mockRejectedValue(
      new CiProviderError(
        "Bitbucket POST acme/acme-accounting/src failed with 401",
        401
      )
    );
    const res = await send("POST", PATH);
    expect(res.status).toBe(200);
    const commits = (await res.json()).pipelineFileCommits;
    expect(commits.main).toMatchObject({ sha: "old-main" });
    expect(commits.main.error).toContain("401");
    expect(commits["release/1.x"].error).toContain("401");
  });

  it("answers 409 for a custom component", async () => {
    state.components = [
      existingComponent({ pipelineMode: "custom", buildSpec: null }),
    ];
    expect((await send("POST", PATH)).status).toBe(409);
    expect(forge.commitFile).not.toHaveBeenCalled();
  });
});

describe("POST build", () => {
  const PATH = "/api/service-catalog/accounting/build";
  const APP_ROW = {
    id: "0197f3a0-1b2c-7def-8000-0123456789a9",
    appKey: "a",
    createdAt: new Date(),
  };

  beforeEach(() => {
    state.apps = [APP_ROW];
    state.components = [existingComponent()];
    provider.triggerPipeline.mockResolvedValue({ number: 12 });
  });

  it("lets an admin start a build and records it", async () => {
    const res = await send("POST", PATH, { branch: "main" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ number: 12 });
    expect(provider.triggerPipeline).toHaveBeenCalledWith("1", "main");
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "app.build.trigger",
        data: expect.objectContaining({
          component: "accounting",
          branch: "main",
          number: 12,
        }),
      })
    );
  });

  it("lets a maintainer build the branch a target of the component deploys in their project", async () => {
    state.orgRole = "engineer";
    state.projectRoles = { "project-1": "engineer" };
    state.targetBranches = [{ projectId: "project-1", sourceBranch: "main" }];
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(200);
    expect(provider.triggerPipeline).toHaveBeenCalledWith("1", "main");
  });

  it("refuses a maintainer a branch no target of the component deploys", async () => {
    state.orgRole = "engineer";
    state.projectRoles = { "project-1": "engineer" };
    state.targetBranches = [{ projectId: "project-1", sourceBranch: "main" }];
    expect((await send("POST", PATH, { branch: "feature/x" })).status).toBe(
      403
    );
    expect(provider.triggerPipeline).not.toHaveBeenCalled();
  });

  it("refuses a maintainer a branch deployed only in another project", async () => {
    state.orgRole = "engineer";
    state.projectRoles = { "project-1": "engineer" };
    state.targetBranches = [
      { projectId: "project-1", sourceBranch: "main" },
      { projectId: "project-2", sourceBranch: "release" },
    ];
    expect((await send("POST", PATH, { branch: "release" })).status).toBe(403);
    expect(provider.triggerPipeline).not.toHaveBeenCalled();
  });

  it("refuses a maintainer a service with no target registered over an hour ago", async () => {
    state.components = [
      existingComponent({ createdAt: new Date(Date.now() - 2 * 3600_000) }),
    ];
    state.orgRole = "engineer";
    state.projectRoles = { "project-1": "engineer" };
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(403);
  });

  it("lets an admin build any branch once the service has targets", async () => {
    state.targetBranches = [{ projectId: "project-1", sourceBranch: "main" }];
    expect((await send("POST", PATH, { branch: "feature/x" })).status).toBe(
      200
    );
  });

  it("refuses a maintainer of another project once the service has targets", async () => {
    state.orgRole = "engineer";
    state.projectRoles = { "project-2": "engineer" };
    state.targetBranches = [{ projectId: "project-1", sourceBranch: "main" }];
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(403);
    expect(provider.triggerPipeline).not.toHaveBeenCalled();
  });

  it("refuses a contributor of the service's project", async () => {
    state.orgRole = "qa";
    state.projectRoles = { "project-1": "qa" };
    state.targetBranches = [{ projectId: "project-1", sourceBranch: "main" }];
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(403);
  });

  it("lets a registrant start the first build of a fresh service with no target", async () => {
    state.orgRole = "engineer";
    state.projectRoles = { "project-2": "engineer" };
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(200);
  });

  it("refuses a maintainer for an old service with no target, but not an admin", async () => {
    state.components = [
      existingComponent({ createdAt: new Date(Date.now() - 2 * 3600_000) }),
    ];
    state.orgRole = "engineer";
    state.projectRoles = { "project-2": "engineer" };
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(403);
    expect(provider.triggerPipeline).not.toHaveBeenCalled();
    state.orgRole = "admin";
    state.projectRoles = {};
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(200);
  });

  it("refuses a non-registrant for a service with no target", async () => {
    state.orgRole = "qa";
    state.projectRoles = { "project-2": "qa" };
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(403);
  });

  it("answers 409 (componentNotActivated) when the component has no repository", async () => {
    state.components = [existingComponent({ ciRepoId: null })];
    const res = await send("POST", PATH, { branch: "main" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This component has no Woodpecker repository",
      code: "componentNotActivated",
    });
    expect(provider.triggerPipeline).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown service", async () => {
    const res = await send("POST", "/api/service-catalog/zzz/build", {
      branch: "main",
    });
    expect(res.status).toBe(404);
  });

  it("lets a registrant start the first build of a fresh service registered without an app", async () => {
    state.apps = [];
    state.components = [existingComponent({ appId: null })];
    state.orgRole = "engineer";
    state.projectRoles = { "project-2": "engineer" };
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(200);
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "app.build.trigger",
        entityType: "service",
        data: { component: "accounting", branch: "main", number: 12 },
      })
    );
  });

  it("names the step when Woodpecker refuses", async () => {
    provider.triggerPipeline.mockRejectedValue(
      new CiProviderError("no such branch", 404)
    );
    const res = await send("POST", PATH, { branch: "nope" });
    expect(res.status).toBe(502);
  });
});

describe("GET active build", () => {
  const PATH = "/api/service-catalog/accounting/builds/active?branch=main";
  const APP_ROW = {
    id: "0197f3a0-1b2c-7def-8000-0123456789a9",
    appKey: "a",
    createdAt: new Date(),
  };
  const RUNNING = [{ number: 14 }, { number: 11 }];

  beforeEach(() => {
    state.apps = [APP_ROW];
    state.components = [existingComponent()];
    provider.listActivePipelines.mockResolvedValue(RUNNING);
  });

  it("answers the newest active pipeline of the branch to an admin", async () => {
    const res = await send("GET", PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ number: 14, url: null });
    expect(provider.listActivePipelines).toHaveBeenCalledWith("1", "main");
  });

  it("links the pipeline from the public URL a stored build of the component carries", async () => {
    state.storedPipelineUrl = "https://ci.example.net/repos/1/pipeline/9";
    const res = await send("GET", PATH);
    expect(await res.json()).toEqual({
      number: 14,
      url: "https://ci.example.net/repos/1/pipeline/14",
    });
  });

  it("gives no link without a stored pipeline URL of the component", async () => {
    state.storedPipelineUrl = null;
    const res = await send("GET", PATH);
    expect(await res.json()).toEqual({ number: 14, url: null });
  });

  it("gives no link from a stored URL of another repository or shape", async () => {
    state.storedPipelineUrl = "https://ci.example.net/repos/7/pipeline/9";
    expect(await (await send("GET", PATH)).json()).toEqual({
      number: 14,
      url: null,
    });
    state.storedPipelineUrl = "javascript:alert(1)//repos/1/pipeline/9";
    expect(await (await send("GET", PATH)).json()).toEqual({
      number: 14,
      url: null,
    });
  });

  it("answers null when nothing is running", async () => {
    provider.listActivePipelines.mockResolvedValue([]);
    const res = await send("GET", PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("lets a viewer of a project where a target deploys the branch see it", async () => {
    state.orgRole = "qa";
    state.projectRoles = { "project-1": "viewer" };
    state.targetBranches = [{ projectId: "project-1", sourceBranch: "main" }];
    const res = await send("GET", PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ number: 14, url: null });
  });

  it("refuses a branch no target of the component deploys", async () => {
    state.orgRole = "engineer";
    state.projectRoles = { "project-1": "engineer" };
    state.targetBranches = [
      { projectId: "project-1", sourceBranch: "release" },
    ];
    expect((await send("GET", PATH)).status).toBe(403);
    expect(provider.listActivePipelines).not.toHaveBeenCalled();
  });

  it("refuses a member of another project", async () => {
    state.orgRole = "engineer";
    state.projectRoles = { "project-2": "engineer" };
    state.targetBranches = [{ projectId: "project-1", sourceBranch: "main" }];
    expect((await send("GET", PATH)).status).toBe(403);
    expect(provider.listActivePipelines).not.toHaveBeenCalled();
  });

  it("refuses a member when the component has no target", async () => {
    state.orgRole = "engineer";
    state.projectRoles = { "project-1": "engineer" };
    expect((await send("GET", PATH)).status).toBe(403);
  });

  it("answers null for a component without a repository", async () => {
    state.components = [existingComponent({ ciRepoId: null })];
    const res = await send("GET", PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    expect(provider.listActivePipelines).not.toHaveBeenCalled();
  });

  it("answers null and logs when Woodpecker fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    provider.listActivePipelines.mockRejectedValue(
      new CiProviderError("Woodpecker GET failed with 500", 500)
    );
    const res = await send("GET", PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("answers null and logs when the connection has no provider", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    connections.getProviderForConnection.mockRejectedValue(
      new Error("This CI connection has no API token")
    );
    const res = await send("GET", PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("answers 400 without a branch", async () => {
    const res = await send(
      "GET",
      "/api/service-catalog/accounting/builds/active"
    );
    expect(res.status).toBe(400);
  });

  it("answers 404 for an unknown service", async () => {
    const res = await send(
      "GET",
      "/api/service-catalog/zzz/builds/active?branch=main"
    );
    expect(res.status).toBe(404);
  });
});

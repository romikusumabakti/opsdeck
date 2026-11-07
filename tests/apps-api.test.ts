import { beforeEach, describe, expect, it, vi } from "vitest";

const CONN = "0197f3a0-1b2c-7def-8000-0123456789c1";
const APP_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  orgRole: "member" as string,
  projectRoles: {} as Record<string, string>,
  apps: [] as Row[],
  components: [] as Row[],
  calls: [] as string[],
  envProjects: [] as string[],
  // The component's deploy targets (componentTargetBranches).
  targetBranches: [] as { projectId: string; sourceBranch: string }[],
  insertError: null as Error | null,
  secretWriteError: null as Error | null,
  selectedFields: [] as unknown[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "user-1", role: state.orgRole },
  })),
  getServerSession: vi.fn(async () => ({
    user: { id: "user-1", role: state.orgRole },
  })),
}));

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

vi.mock("@/lib/authz", async () => {
  const { canOrg } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    getProjectAccess: vi.fn(async () => ({
      all: false,
      roles: { ...state.projectRoles },
    })),
    requireOrgPermission: vi.fn(async (perms: Parameters<typeof canOrg>[1]) => {
      if (!canOrg(state.orgRole, perms)) {
        throw new HTTPException(403, { message: "Forbidden" });
      }
      return { user: { id: "user-1", role: state.orgRole } };
    }),
  };
});

// Only listApps reaches the database: it projects the component columns, and
// the fake honours that projection, so a select of the whole row would leak
// the secret into the response exactly as production would.
vi.mock("@/lib/db", () => ({
  db: {
    select: (fields: { component: Record<string, unknown> }) => {
      state.selectedFields.push(fields);
      const keys = Object.keys(fields.component);
      return {
        from: () => ({
          leftJoin: () => ({
            orderBy: async () =>
              state.apps.flatMap(
                (app): { app: Row; component: Row | null }[] => {
                  const comps = state.components.filter(
                    (c) => c.appId === app.id
                  );
                  const project = (c: Row) =>
                    Object.fromEntries(keys.map((k) => [k, c[k]]));
                  return comps.length === 0
                    ? [{ app, component: null }]
                    : comps.map((c) => ({ app, component: project(c) }));
                }
              ),
          }),
        }),
      };
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
    insertAppWithComponents: vi.fn(
      async (app: { appKey: string; name: string }, components: Row[]) => {
        state.calls.push("insert");
        if (state.insertError) throw state.insertError;
        state.apps.push({ id: APP_ID, ...app });
        for (const c of components) {
          state.components.push({
            pipelineFileCommits: null,
            ...c,
            appId: APP_ID,
          });
        }
      }
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
    projectIdsWithAppEnvironment: vi.fn(async () => [...state.envProjects]),
    componentTargetBranches: vi.fn(async () => [...state.targetBranches]),
    getComponent: vi.fn(async (componentKey: string) => {
      const c = state.components.find((x) => x.componentKey === componentKey);
      const app = c && state.apps.find((a) => a.id === c.appId);
      return c && app ? { ...c, app } : undefined;
    }),
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

const provider = vi.hoisted(() => ({
  listRepos: vi.fn(),
  activateRepo: vi.fn(),
  updateRepoSettings: vi.fn(),
  upsertRepoSecret: vi.fn(),
  triggerPipeline: vi.fn(),
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
  return {
    appKey: "hris",
    name: "HRIS",
    components: [component(comp)],
    ...extra,
  };
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
    repoFullName: "dss-consulting/dplk-accounting",
    ciRepoId: "1",
    bundleImage: "accounting-deploy",
    notifySecret: encryptSecret("old-notify-secret"),
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
  state.envProjects = [];
  state.targetBranches = [];
  state.insertError = null;
  state.secretWriteError = null;
  state.selectedFields = [];
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
      fullName: "dss-consulting/hris",
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
  forge.commitFile.mockImplementation(
    async (_auth: unknown, _repo: string, branch: string) => {
      state.calls.push(`commit:${branch}`);
      return { sha: `sha-${branch}` };
    }
  );
});

describe("permissions", () => {
  it("a member with only contributor roles gets 403 on every registrant route", async () => {
    state.orgRole = "member";
    state.projectRoles = { "project-1": "contributor" };
    state.apps = [{ id: "0197f3a0-1b2c-7def-8000-0123456789a9", appKey: "a" }];
    state.components = [
      existingComponent({ appId: "0197f3a0-1b2c-7def-8000-0123456789a9" }),
    ];
    expect((await send("POST", "/api/apps", body())).status).toBe(403);
    expect(
      (await send("GET", `/api/ci-connections/${CONN}/repos`)).status
    ).toBe(403);
    expect((await send("GET", "/api/ci-connections/options")).status).toBe(403);
    const preview = new URLSearchParams({
      q: JSON.stringify({ componentKey: "hris", buildSpec: SPEC }),
    });
    expect(
      (await send("GET", `/api/apps/pipeline-preview?${preview}`)).status
    ).toBe(403);
    expect(
      (await send("POST", "/api/apps/a/components/accounting/rotate-secret"))
        .status
    ).toBe(403);
    expect(
      (
        await send(
          "POST",
          "/api/apps/a/components/accounting/commit-pipeline-file"
        )
      ).status
    ).toBe(403);
    expect(provider.activateRepo).not.toHaveBeenCalled();
    expect(provider.upsertRepoSecret).not.toHaveBeenCalled();
  });

  it("a maintainer gets 403 on rotate-secret and commit-pipeline-file", async () => {
    state.orgRole = "member";
    state.projectRoles = { "project-1": "maintainer" };
    state.apps = [{ id: "0197f3a0-1b2c-7def-8000-0123456789a9", appKey: "a" }];
    state.components = [existingComponent()];
    expect(
      (await send("POST", "/api/apps/a/components/accounting/rotate-secret"))
        .status
    ).toBe(403);
    expect(
      (
        await send(
          "POST",
          "/api/apps/a/components/accounting/commit-pipeline-file"
        )
      ).status
    ).toBe(403);
    expect(provider.upsertRepoSecret).not.toHaveBeenCalled();
    expect(forge.commitFile).not.toHaveBeenCalled();
  });

  it("any signed-in user may list apps", async () => {
    state.projectRoles = {};
    expect((await send("GET", "/api/apps")).status).toBe(200);
  });
});

describe("GET /api/apps", () => {
  it("never returns notifySecret and includes pipeline file state", async () => {
    const commits = {
      main: { sha: "abc1234", at: "2026-11-05T01:00:00.000Z" },
      "release/1.x": {
        error: "Bitbucket POST failed with 403",
        at: "2026-11-05T01:00:00.000Z",
      },
    };
    state.apps = [
      { id: "0197f3a0-1b2c-7def-8000-0123456789a9", appKey: "a", name: "A" },
    ];
    state.components = [existingComponent({ pipelineFileCommits: commits })];
    const res = await send("GET", "/api/apps");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("notifySecret");
    expect(text).not.toContain("enc:v1:");
    const [entry] = JSON.parse(text);
    expect(entry.components[0]).toMatchObject({
      componentKey: "accounting",
      pipelineMode: "generated",
      pipelineFileCommits: commits,
    });
  });
});

describe("POST /api/apps", () => {
  it("calls the provider in order and stores an encrypted secret", async () => {
    const res = await send("POST", "/api/apps", body());
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
    expect(name).toBe("opsdeck_notify");
    expect(events).toEqual(["push", "manual"]);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    const stored = state.components.find((c) => c.componentKey === "hris");
    expect(stored).toMatchObject({
      ciConnectionId: CONN,
      repoFullName: "dss-consulting/hris",
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
    expect(text).not.toContain("notifySecret");

    expect(forge.commitFile).toHaveBeenCalledTimes(2);
    const [auth, repo, branch, path, content] = at(forge.commitFile.mock.calls);
    expect(auth).toEqual({ username: "ci-bot", token: "forge-token" });
    expect(repo).toBe("dss-consulting/hris");
    expect(branch).toBe("main");
    expect(path).toBe(".woodpecker.yaml");
    expect(content).toContain("hris-deploy");
    expect(at(forge.commitFile.mock.calls, 1)[2]).toBe("release/1.x");
  });

  it("clears the configuration extension for custom components too", async () => {
    const res = await send(
      "POST",
      "/api/apps",
      body({}, { pipelineMode: "custom", buildSpec: undefined })
    );
    expect(res.status).toBe(201);
    expect(
      at(provider.updateRepoSettings.mock.calls)[1].configExtensionEndpoint
    ).toBeNull();
  });

  it("refuses a generated component from a maintainer (403) before Woodpecker", async () => {
    state.orgRole = "member";
    state.projectRoles = { "project-1": "maintainer" };
    const res = await send("POST", "/api/apps", body());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Only admins can register a component with a generated pipeline"
    );
    expect(provider.activateRepo).not.toHaveBeenCalled();
    expect(state.components).toHaveLength(0);
  });

  it("lets a maintainer register a custom component (201)", async () => {
    state.orgRole = "member";
    state.projectRoles = { "project-1": "maintainer" };
    const res = await send(
      "POST",
      "/api/apps",
      body({}, { pipelineMode: "custom", buildSpec: undefined })
    );
    expect(res.status).toBe(201);
    expect(state.components).toHaveLength(1);
    expect(forge.commitFile).not.toHaveBeenCalled();
  });

  it("uses a 60 minute timeout and commits nothing for custom components", async () => {
    const res = await send(
      "POST",
      "/api/apps",
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
        fullName: "dss-consulting/hris",
        forgeRemoteId: id,
        active: true,
      };
    });
    const res = await send("POST", "/api/apps", body());
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
    const res = await send("POST", "/api/apps", body());
    expect(res.status).toBe(502);
    const { error } = await res.json();
    expect(error).toContain("notify secret");
    expect(error).toContain("failed with 500");
    expect(state.calls).not.toContain("insert");
    expect(state.apps).toHaveLength(0);
    expect(state.components).toHaveLength(0);
  });

  it("answers 502 for a failed activation without touching settings", async () => {
    provider.activateRepo.mockRejectedValue(
      new CiProviderError("Woodpecker POST /api/repos failed with 500", 500)
    );
    const res = await send("POST", "/api/apps", body());
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
            "Bitbucket POST dss-consulting/hris/src failed with 403: branch is protected",
            403
          );
        }
        return { sha: `sha-${branch}` };
      }
    );
    const res = await send("POST", "/api/apps", body());
    expect(res.status).toBe(201);
    expect(state.calls).toContain("commit:release/1.x");
    const created = await res.json();
    expect(created.components[0].pipelineFileCommits).toEqual({
      main: {
        error:
          "Bitbucket POST dss-consulting/hris/src failed with 403: branch is protected",
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
    const res = await send("POST", "/api/apps", body());
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
    const res = await send("POST", "/api/apps", body());
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
    const res = await send("POST", "/api/apps", body());
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

  it("answers 409 for an existing app key before calling Woodpecker", async () => {
    state.apps = [{ id: APP_ID, appKey: "hris", name: "HRIS" }];
    const res = await send("POST", "/api/apps", body());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("App hris already exists");
    expect(provider.activateRepo).not.toHaveBeenCalled();
  });

  it("answers 409 for an existing component key", async () => {
    state.components = [existingComponent({ componentKey: "hris" })];
    const res = await send("POST", "/api/apps", body());
    expect(res.status).toBe(409);
    expect(provider.activateRepo).not.toHaveBeenCalled();
  });

  it("answers 409 when the repo is already linked to a component", async () => {
    state.components = [existingComponent({ ciRepoId: "42" })];
    const res = await send("POST", "/api/apps", body());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("accounting");
    expect(provider.updateRepoSettings).not.toHaveBeenCalled();
    expect(provider.upsertRepoSecret).not.toHaveBeenCalled();
    expect(state.calls).not.toContain("insert");
  });

  it("maps a unique violation on insert to 409 that says to rotate", async () => {
    state.insertError = Object.assign(new Error("dup"), { code: "23505" });
    const res = await send("POST", "/api/apps", body());
    expect(res.status).toBe(409);
    // The losing request has already replaced the Woodpecker secret.
    expect((await res.json()).error).toBe(
      "The app, a component or a repository was registered meanwhile. Woodpecker may now hold a notify secret the Panel does not know: rotate the notify secret of hris on its app page."
    );
  });

  it("lets a registrant preview the generated pipeline", async () => {
    const preview = new URLSearchParams({
      q: JSON.stringify({ componentKey: "hris", buildSpec: SPEC }),
    });
    const res = await send("GET", `/api/apps/pipeline-preview?${preview}`);
    expect(res.status).toBe(200);
    expect((await res.json()).yaml).toContain("hris-deploy");
  });

  it("rejects a bundle image other than <componentKey>-deploy", async () => {
    const res = await send(
      "POST",
      "/api/apps",
      body({}, { bundleImage: "something-else" })
    );
    expect(res.status).toBe(400);
  });

  it("rejects a build image named like the bundle image", async () => {
    const res = await send(
      "POST",
      "/api/apps",
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
      (await send("POST", "/api/apps", body({}, { buildSpec: undefined })))
        .status
    ).toBe(400);
    expect(
      (await send("POST", "/api/apps", body({}, { pipelineMode: "custom" })))
        .status
    ).toBe(400);
  });
});

describe("GET /api/ci-connections/:id/repos", () => {
  it("marks repos already linked to a component", async () => {
    state.components = [existingComponent()];
    provider.listRepos.mockResolvedValue([
      {
        ciRepoId: "1",
        fullName: "dss-consulting/dplk-accounting",
        forgeRemoteId: "{a}",
        active: true,
      },
      {
        ciRepoId: "",
        fullName: "dss-consulting/new",
        forgeRemoteId: "{b}",
        active: false,
      },
    ]);
    const res = await send("GET", `/api/ci-connections/${CONN}/repos`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        ciRepoId: "1",
        fullName: "dss-consulting/dplk-accounting",
        forgeRemoteId: "{a}",
        active: true,
        linkedComponentKey: "accounting",
      },
      {
        ciRepoId: "",
        fullName: "dss-consulting/new",
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
  const PATH = "/api/apps/a/components/accounting/rotate-secret";

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
    expect(name).toBe("opsdeck_notify");
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
      "Woodpecker secret not updated; Panel secret unchanged"
    );
    expect(state.calls).not.toContain("panel-secret");
    expect(at(state.components).notifySecret).toBe(before);
  });

  it("reports a Panel failure after Woodpecker succeeded", async () => {
    state.secretWriteError = new Error("connection lost");
    const res = await send("POST", PATH);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe(
      "Woodpecker has the new secret but the Panel does not — rotate again"
    );
  });

  it("answers 404 when the component belongs to another app", async () => {
    const res = await send(
      "POST",
      "/api/apps/other/components/accounting/rotate-secret"
    );
    expect(res.status).toBe(404);
    expect(provider.upsertRepoSecret).not.toHaveBeenCalled();
  });

  it("answers 409 when the component has no CI repo", async () => {
    state.components = [existingComponent({ ciRepoId: null })];
    expect((await send("POST", PATH)).status).toBe(409);
  });
});

describe("POST commit-pipeline-file", () => {
  const PATH = "/api/apps/a/components/accounting/commit-pipeline-file";

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
    expect(at(forge.commitFile.mock.calls)[1]).toBe(
      "dss-consulting/dplk-accounting"
    );
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
        "Bitbucket POST dss-consulting/dplk-accounting/src failed with 401",
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
  const PATH = "/api/apps/a/components/accounting/build";
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
    state.orgRole = "member";
    state.projectRoles = { "project-1": "maintainer" };
    state.envProjects = ["project-1"];
    state.targetBranches = [{ projectId: "project-1", sourceBranch: "main" }];
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(200);
    expect(provider.triggerPipeline).toHaveBeenCalledWith("1", "main");
  });

  it("refuses a maintainer a branch no target of the component deploys", async () => {
    state.orgRole = "member";
    state.projectRoles = { "project-1": "maintainer" };
    state.envProjects = ["project-1"];
    state.targetBranches = [{ projectId: "project-1", sourceBranch: "main" }];
    expect((await send("POST", PATH, { branch: "feature/x" })).status).toBe(
      403
    );
    expect(provider.triggerPipeline).not.toHaveBeenCalled();
  });

  it("refuses a maintainer a branch deployed only in another project", async () => {
    state.orgRole = "member";
    state.projectRoles = { "project-1": "maintainer", "project-2": "viewer" };
    state.envProjects = ["project-1", "project-2"];
    state.targetBranches = [
      { projectId: "project-1", sourceBranch: "main" },
      { projectId: "project-2", sourceBranch: "release" },
    ];
    expect((await send("POST", PATH, { branch: "release" })).status).toBe(403);
    expect(provider.triggerPipeline).not.toHaveBeenCalled();
  });

  it("refuses a maintainer when the app's environments have no target of this component", async () => {
    state.orgRole = "member";
    state.projectRoles = { "project-1": "maintainer" };
    state.envProjects = ["project-1"];
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(403);
  });

  it("lets an admin build any branch once the app has environments", async () => {
    state.envProjects = ["project-1"];
    state.targetBranches = [{ projectId: "project-1", sourceBranch: "main" }];
    expect((await send("POST", PATH, { branch: "feature/x" })).status).toBe(
      200
    );
  });

  it("refuses a maintainer of another project once the app has environments", async () => {
    state.orgRole = "member";
    state.projectRoles = { "project-2": "maintainer" };
    state.envProjects = ["project-1"];
    state.targetBranches = [{ projectId: "project-1", sourceBranch: "main" }];
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(403);
    expect(provider.triggerPipeline).not.toHaveBeenCalled();
  });

  it("refuses a contributor of the app's project", async () => {
    state.orgRole = "member";
    state.projectRoles = { "project-1": "contributor" };
    state.envProjects = ["project-1"];
    state.targetBranches = [{ projectId: "project-1", sourceBranch: "main" }];
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(403);
  });

  it("lets a registrant start the first build of a fresh app with no environment", async () => {
    state.orgRole = "member";
    state.projectRoles = { "project-2": "maintainer" };
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(200);
  });

  it("refuses a maintainer for an old app with no environment, but not an admin", async () => {
    state.apps = [
      { ...APP_ROW, createdAt: new Date(Date.now() - 2 * 3600_000) },
    ];
    state.orgRole = "member";
    state.projectRoles = { "project-2": "maintainer" };
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(403);
    expect(provider.triggerPipeline).not.toHaveBeenCalled();
    state.orgRole = "admin";
    state.projectRoles = {};
    expect((await send("POST", PATH, { branch: "main" })).status).toBe(200);
  });

  it("refuses a non-registrant for an app with no environment", async () => {
    state.orgRole = "member";
    state.projectRoles = { "project-2": "contributor" };
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

  it("answers 404 for a component of another app", async () => {
    const res = await send(
      "POST",
      "/api/apps/zzz/components/accounting/build",
      {
        branch: "main",
      }
    );
    expect(res.status).toBe(404);
  });

  it("names the step when Woodpecker refuses", async () => {
    provider.triggerPipeline.mockRejectedValue(
      new CiProviderError("no such branch", 404)
    );
    const res = await send("POST", PATH, { branch: "nope" });
    expect(res.status).toBe(502);
  });
});

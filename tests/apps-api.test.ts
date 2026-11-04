import { beforeEach, describe, expect, it, vi } from "vitest";

const CONN = "0197f3a0-1b2c-7def-8000-0123456789c1";
const APP_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const ENDPOINT = `https://panel.dssconsulting.id/api/ci/config/${CONN}`;

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  orgRole: "member" as string,
  projectRoles: {} as Record<string, string>,
  apps: [] as Row[],
  components: [] as Row[],
  calls: [] as string[],
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
            fallbackCommittedSha: null,
            fallbackCommitError: null,
            ...c,
            appId: APP_ID,
          });
        }
      }
    ),
    setFallbackCommitResult: vi.fn(
      async (
        componentKey: string,
        result: { sha: string } | { error: string }
      ) => {
        const c = state.components.find((x) => x.componentKey === componentKey);
        if (!c) return;
        if ("sha" in result) {
          c.fallbackCommittedSha = result.sha;
          c.fallbackCommitError = null;
        } else {
          c.fallbackCommitError = result.error;
        }
      }
    ),
    setNotifySecret: vi.fn(async (componentKey: string, value: string) => {
      state.calls.push("panel-secret");
      if (state.secretWriteError) throw state.secretWriteError;
      const c = state.components.find((x) => x.componentKey === componentKey);
      if (c) c.notifySecret = value;
    }),
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
  fetchExtensionPublicKey: vi.fn(),
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
  getDefaultBranch: vi.fn(),
}));
vi.mock("@/lib/ci/forges/bitbucket", () => forge);

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { decryptSecret, encryptSecret } = await import("@/lib/secrets");
const { CiProviderError } = await import("@/lib/ci/types");
const { app } = await import("@/server/app");

const SPEC = {
  branches: ["main"],
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
    fallbackCommittedSha: null,
    fallbackCommitError: null,
    createdAt: new Date(),
    ...extra,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DEPLOY_REGISTRY", "192.168.56.113:5000");
  state.orgRole = "member";
  state.projectRoles = { "project-1": "maintainer" };
  state.apps = [];
  state.components = [];
  state.calls = [];
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
  forge.getDefaultBranch.mockResolvedValue("main");
  forge.commitFile.mockImplementation(async () => {
    state.calls.push("commit");
    return { sha: "abc1234def" };
  });
});

describe("permissions", () => {
  it("a member with only contributor roles gets 403 on every registrant route", async () => {
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
      (await send("POST", "/api/apps/a/components/accounting/commit-fallback"))
        .status
    ).toBe(403);
    expect(provider.activateRepo).not.toHaveBeenCalled();
    expect(provider.upsertRepoSecret).not.toHaveBeenCalled();
  });

  it("any signed-in user may list apps", async () => {
    state.projectRoles = {};
    expect((await send("GET", "/api/apps")).status).toBe(200);
  });
});

describe("GET /api/apps", () => {
  it("never returns notifySecret and includes pipeline and fallback state", async () => {
    state.apps = [
      { id: "0197f3a0-1b2c-7def-8000-0123456789a9", appKey: "a", name: "A" },
    ];
    state.components = [
      existingComponent({
        fallbackCommittedSha: "abc1234",
        fallbackCommitError: "Bitbucket POST failed with 403",
      }),
    ];
    const res = await send("GET", "/api/apps");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("notifySecret");
    expect(text).not.toContain("enc:v1:");
    const [entry] = JSON.parse(text);
    expect(entry.components[0]).toMatchObject({
      componentKey: "accounting",
      pipelineMode: "generated",
      fallbackCommittedSha: "abc1234",
      fallbackCommitError: "Bitbucket POST failed with 403",
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
      "commit",
    ]);
    expect(provider.updateRepoSettings).toHaveBeenCalledWith("42", {
      timeoutMinutes: 45,
      cancelPreviousOnPush: true,
      configExtensionEndpoint: ENDPOINT,
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
      fallbackCommittedSha: "abc1234def",
      fallbackCommitError: null,
    });
    expect(stored?.notifySecret).not.toBe(secret);
    expect(decryptSecret(stored?.notifySecret as string)).toBe(secret);

    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("notifySecret");

    const [auth, repo, branch, path, content] = at(forge.commitFile.mock.calls);
    expect(auth).toEqual({ username: "ci-bot", token: "forge-token" });
    expect(repo).toBe("dss-consulting/hris");
    expect(branch).toBe("main");
    expect(path).toBe(".woodpecker.yaml");
    expect(content).toContain("hris-deploy");
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

  it("keeps the registration when the forge commit fails (Review Focus 4)", async () => {
    forge.commitFile.mockRejectedValue(
      new CiProviderError(
        "Bitbucket POST dss-consulting/hris/src failed with 403: branch is protected",
        403
      )
    );
    const res = await send("POST", "/api/apps", body());
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.components[0]).toMatchObject({
      fallbackCommittedSha: null,
      fallbackCommitError:
        "Bitbucket POST dss-consulting/hris/src failed with 403: branch is protected",
    });
    expect(state.components).toHaveLength(1);
  });

  it("records a missing forge token as the fallback error", async () => {
    connections.getForgeCredentials.mockResolvedValue({
      forge: "bitbucket",
      auth: null,
    });
    const res = await send("POST", "/api/apps", body());
    expect(res.status).toBe(201);
    expect(forge.commitFile).not.toHaveBeenCalled();
    expect(at(state.components).fallbackCommitError).toMatch(/forge token/);
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

  it("updates Woodpecker first, then the Panel", async () => {
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

describe("POST commit-fallback", () => {
  const PATH = "/api/apps/a/components/accounting/commit-fallback";

  beforeEach(() => {
    state.apps = [
      { id: "0197f3a0-1b2c-7def-8000-0123456789a9", appKey: "a", name: "A" },
    ];
    state.components = [
      existingComponent({ fallbackCommitError: "expired token" }),
    ];
  });

  it("retries the commit and clears the error", async () => {
    const res = await send("POST", PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      componentKey: "accounting",
      fallbackCommittedSha: "abc1234def",
      fallbackCommitError: null,
    });
    expect(at(forge.commitFile.mock.calls)[1]).toBe(
      "dss-consulting/dplk-accounting"
    );
  });

  it("stores the new reason when the retry fails", async () => {
    forge.getDefaultBranch.mockRejectedValue(
      new CiProviderError(
        "Bitbucket GET dss-consulting/dplk-accounting failed with 401",
        401
      )
    );
    const res = await send("POST", PATH);
    expect(res.status).toBe(200);
    expect((await res.json()).fallbackCommitError).toContain("401");
  });

  it("answers 409 for a custom component", async () => {
    state.components = [
      existingComponent({ pipelineMode: "custom", buildSpec: null }),
    ];
    expect((await send("POST", PATH)).status).toBe(409);
    expect(forge.commitFile).not.toHaveBeenCalled();
  });
});

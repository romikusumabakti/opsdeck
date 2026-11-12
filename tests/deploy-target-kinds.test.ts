import { beforeEach, describe, expect, it, vi } from "vitest";

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const TARGET_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789c1";

const state = vi.hoisted(() => ({ role: "engineer" as string }));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/authz", async () => {
  const { canProject } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    requireProjectPermission: vi.fn(
      async (_scope: unknown, perms: Parameters<typeof canProject>[1]) => {
        if (!canProject(state.role as "viewer", perms)) {
          throw new HTTPException(403, { message: "Forbidden" });
        }
        return {
          session: { user: { id: "user-1" } },
          role: state.role,
          projectId: "project-1",
        };
      }
    ),
  };
});

const repo = vi.hoisted(() => ({
  getTarget: vi.fn(),
  getTagState: vi.fn(),
  listTargetsForEnvironment: vi.fn(),
  findBuild: vi.fn(),
  upsertTarget: vi.fn(),
  supersedeHeldDeployments: vi.fn(),
  deleteTarget: vi.fn(),
  environmentUsesServer: vi.fn(),
  listTargetDirsOnMachine: vi.fn(),
  getDeployLock: vi.fn(),
  getEnvironmentForLock: vi.fn(),
}));
vi.mock("@/lib/deploy/repository", () => repo);

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

const apps = vi.hoisted(() => ({
  getComponent: vi.fn(),
  assertTargetMatchesEnvironmentApp: vi.fn(),
}));
vi.mock("@/lib/apps", () => apps);

// No teardown under way (lib/teardown/guard has its own tests).
vi.mock("@/lib/teardown/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/teardown/guard")>()),
  tearingDownIn: async () => teardown.blocks,
  holdEnvironmentExclusive: async () => {},
}));
const teardown = vi.hoisted(() => ({ blocks: false, running: false }));

// The app adoption and the target insert share one transaction.
const txState = vi.hoisted(() => ({ tx: { marker: "tx" } }));
vi.mock("@/lib/db", () => ({
  db: {
    transaction: async (fn: (tx: unknown) => unknown) => fn(txState.tx),
  },
}));

const projectSources = vi.hoisted(() => ({
  recordTargetSourceIn: vi.fn(),
  ensureProjectSourceIn: vi.fn(),
}));
vi.mock("@/lib/project-sources", () => projectSources);

const variables = vi.hoisted(() => ({ getVariable: vi.fn() }));
vi.mock("@/lib/variables/repository", () => variables);

const deployments = vi.hoisted(() => ({ requestDeployment: vi.fn() }));
vi.mock("@/server/services/deployments", () => deployments);

const { app } = await import("@/server/app");

const base = {
  environmentId: ENV_ID,
  componentKey: "core-web",
  serverId: SERVER_ID,
  sourceBranch: "kestrel/development",
};
const jarTarget = {
  ...base,
  kind: "jar",
  deployDir: "/opt/core",
  jarName: "core-web-service.jar",
  systemdUnit: "core-web",
};
const staticTarget = { ...base, kind: "static", deployDir: "/var/www/core" };

const { jarNameSchema, systemdUnitSchema } = await import(
  "@/lib/deploy/validation"
);
const { insertDeployTargetIn } = await import("@/server/services/deploys");

const OTHER_ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e2";
const OTHER_ID = "0197f3a0-1b2c-7def-8000-0123456789a2";

/** The component's artifact kind, as assertTargetMatchesEnvironmentApp returns it. */
function componentArtifact(kind: "jar" | "static" | null) {
  apps.assertTargetMatchesEnvironmentApp.mockResolvedValue(kind);
}

/** The targets already on the machine (any environment). */
function onMachine(
  ...targets: { kind: string; deployDir: string; environmentId?: string }[]
) {
  repo.listTargetDirsOnMachine.mockResolvedValue(
    targets.map((t, i) => ({
      id: `0197f3a0-1b2c-7def-8000-00000000000${i}`,
      environmentId: t.environmentId ?? OTHER_ENV_ID,
      ...t,
    }))
  );
}

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const patch = (body: unknown) =>
  send("PATCH", `/api/deploys/targets/${TARGET_ID}`, body);

beforeEach(() => {
  vi.resetAllMocks();
  state.role = "engineer";
  repo.getTarget.mockResolvedValue({ id: TARGET_ID, ...base, kind: "jar" });
  repo.getEnvironmentForLock.mockResolvedValue({
    id: ENV_ID,
    name: "Core",
    ownerId: null,
  });
  apps.getComponent.mockResolvedValue({ componentKey: "core-web" });
  apps.assertTargetMatchesEnvironmentApp.mockResolvedValue(null);
  repo.environmentUsesServer.mockResolvedValue(true);
  repo.listTargetDirsOnMachine.mockResolvedValue([]);
  repo.upsertTarget.mockImplementation(async (input: object) => ({
    id: TARGET_ID,
    ...input,
  }));
});

describe("jarNameSchema and systemdUnitSchema", () => {
  it("jar names", () => {
    for (const ok of [
      "core-web-service.jar",
      "acc-backend-api-0.0.1-SNAPSHOT.jar",
    ]) {
      expect(jarNameSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["../x.jar", "x.war", "a/b.jar", ".x.jar", "x.jar "]) {
      expect(jarNameSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("systemd units are given without the .service suffix", () => {
    for (const ok of ["core-web", "app@1", "a.b_c-d"]) {
      expect(systemdUnitSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["core.service", "-x", "a b", "a;b", ""]) {
      expect(systemdUnitSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("create", () => {
  it("compose without kind still works and stores kind compose", async () => {
    const res = await send("POST", "/api/deploys/targets", {
      ...base,
      deployDir: "/opt/accounting",
      services: ["backend"],
    });
    expect(res.status).toBe(200);
    expect(repo.upsertTarget).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "compose", services: ["backend"] }),
      txState.tx
    );
  });

  it("a jar target stores empty services and its jar fields", async () => {
    componentArtifact("jar");
    const res = await send("POST", "/api/deploys/targets", jarTarget);
    expect(res.status).toBe(200);
    expect(repo.upsertTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "jar",
        services: [],
        jarName: "core-web-service.jar",
        systemdUnit: "core-web",
        healthUrl: null,
        healthTimeoutSeconds: 180,
      }),
      txState.tx
    );
    expect(variables.getVariable).not.toHaveBeenCalled();
  });

  it("a static target stores empty services and no jar fields", async () => {
    componentArtifact("static");
    const res = await send("POST", "/api/deploys/targets", staticTarget);
    expect(res.status).toBe(200);
    const stored = repo.upsertTarget.mock.calls[0]?.[0];
    expect(stored).toMatchObject({ kind: "static", services: [] });
    expect(stored.jarName ?? null).toBeNull();
    expect(stored.systemdUnit ?? null).toBeNull();
    expect(stored.healthUrl ?? null).toBeNull();
  });

  it.each([
    ["jar without systemdUnit", { ...jarTarget, systemdUnit: undefined }],
    ["jar without jarName", { ...jarTarget, jarName: undefined }],
    ["jar with services", { ...jarTarget, services: ["backend"] }],
    ["static with jarName", { ...staticTarget, jarName: "x.jar" }],
    ["static with systemdUnit", { ...staticTarget, systemdUnit: "x" }],
    ["static with healthUrl", { ...staticTarget, healthUrl: "https://a.b/" }],
    ["unknown kind", { ...staticTarget, kind: "war" }],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await send("POST", "/api/deploys/targets", body);
    expect(res.status).toBe(400);
    expect(repo.upsertTarget).not.toHaveBeenCalled();
  });
});

describe("the target kind follows the component's artifact", () => {
  const composeTarget = {
    ...base,
    deployDir: "/opt/accounting",
    services: ["backend"],
  };
  it.each([
    ["compose", "a jar component", "jar", composeTarget],
    ["compose", "a static component", "static", composeTarget],
    ["jar", "a static component", "static", jarTarget],
    ["jar", "a container component", null, jarTarget],
    ["static", "a jar component", "jar", staticTarget],
    ["static", "a container component", null, staticTarget],
  ] as const)(
    "refuses a %s target for %s with 409 targetKindMismatch",
    async (_kind, _label, artifact, body) => {
      componentArtifact(artifact);
      const res = await send("POST", "/api/deploys/targets", body);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "targetKindMismatch" });
      expect(repo.upsertTarget).not.toHaveBeenCalled();
    }
  );

  it("refuses the setup wizard's compose row for an artifact component", async () => {
    componentArtifact("jar");
    // What environment-setup's targetRow passes: kind forced to compose.
    const row = {
      ...base,
      kind: "compose" as const,
      deployDir: "/deployments/core",
      services: ["backend"],
      tagVariable: "IMAGE_TAG",
      autoDeploy: false,
      healthTimeoutSeconds: 180,
      backupBeforeDeploy: false,
      preStartCommand: null,
      healthUrl: null,
    };
    await expect(
      insertDeployTargetIn(txState.tx as never, row)
    ).rejects.toMatchObject({ status: 409, code: "targetKindMismatch" });
    expect(repo.upsertTarget).not.toHaveBeenCalled();
  });
});

describe("a static web root never holds another target's dir", () => {
  const portalJar = {
    ...base,
    kind: "jar",
    deployDir: "/deployments/customer-portal",
    jarName: "portal.jar",
    systemdUnit: "portal",
  };
  const portalWeb = (deployDir: string) => ({
    ...base,
    kind: "static",
    deployDir,
  });

  it.each([
    [
      "equals a jar dir of another env",
      "/deployments/customer-portal",
      "jar",
      OTHER_ENV_ID,
    ],
    [
      "is the parent of a jar dir of the same env",
      "/deployments/customer-portal",
      "jar",
      ENV_ID,
      "/deployments/customer-portal/app",
    ],
    [
      "contains a compose dir of another env",
      "/deployments/customer-portal",
      "compose",
      OTHER_ENV_ID,
      "/deployments/customer-portal/a/b",
    ],
    [
      "equals another static root",
      "/deployments/customer-portal",
      "static",
      ENV_ID,
    ],
  ])(
    "refuses a static root that %s with 400 staticRootContainsTarget",
    async (_label, root, kind, environmentId, otherDir = root) => {
      componentArtifact("static");
      onMachine({ kind, deployDir: otherDir, environmentId });
      const res = await send("POST", "/api/deploys/targets", portalWeb(root));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "staticRootContainsTarget",
      });
      expect(repo.listTargetDirsOnMachine).toHaveBeenCalledWith(
        SERVER_ID,
        txState.tx
      );
      expect(repo.upsertTarget).not.toHaveBeenCalled();
    }
  );

  it("accepts the web root inside the jar dir (the legacy layout)", async () => {
    componentArtifact("static");
    onMachine({ kind: "jar", deployDir: "/deployments/customer-portal" });
    const res = await send(
      "POST",
      "/api/deploys/targets",
      portalWeb("/deployments/customer-portal/web")
    );
    expect(res.status).toBe(200);
  });

  it.each([
    [
      "a jar dir equal to",
      "jar",
      "/deployments/customer-portal/web",
      OTHER_ENV_ID,
    ],
    ["a jar dir inside", "jar", "/deployments/customer-portal/web/api", ENV_ID],
    [
      "a compose dir inside",
      "compose",
      "/deployments/customer-portal/web/x",
      OTHER_ENV_ID,
    ],
    [
      "a static root inside",
      "static",
      "/deployments/customer-portal/web/x",
      ENV_ID,
    ],
  ])(
    "refuses %s a static root with 400 targetInsideStaticRoot",
    async (_label, kind, deployDir, environmentId) => {
      componentArtifact(kind === "compose" ? null : (kind as "jar" | "static"));
      onMachine({
        kind: "static",
        deployDir: "/deployments/customer-portal/web",
        environmentId,
      });
      const body =
        kind === "compose"
          ? { ...base, deployDir, services: ["backend"] }
          : kind === "jar"
            ? { ...portalJar, deployDir }
            : portalWeb(deployDir);
      const res = await send("POST", "/api/deploys/targets", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "targetInsideStaticRoot",
      });
      expect(repo.upsertTarget).not.toHaveBeenCalled();
    }
  );

  it("refuses an update that moves a static root over the jar dir", async () => {
    repo.getTarget.mockResolvedValue({
      id: TARGET_ID,
      ...base,
      kind: "static",
      deployDir: "/deployments/customer-portal/web",
    });
    onMachine({ kind: "jar", deployDir: "/deployments/customer-portal" });
    const res = await patch({ deployDir: "/deployments/customer-portal" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "staticRootContainsTarget",
    });
    expect(repo.upsertTarget).not.toHaveBeenCalled();
  });

  it("refuses an update that moves a jar dir into another env's static root", async () => {
    repo.getTarget.mockResolvedValue({
      id: TARGET_ID,
      ...base,
      kind: "jar",
      deployDir: "/deployments/core",
      jarName: "a.jar",
      systemdUnit: "a",
    });
    onMachine({
      kind: "static",
      deployDir: "/deployments/customer-portal/web",
      environmentId: OTHER_ENV_ID,
    });
    const res = await patch({
      deployDir: "/deployments/customer-portal/web/core",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "targetInsideStaticRoot" });
  });

  it("checks an update moved to another server against that machine", async () => {
    repo.getTarget.mockResolvedValue({
      id: TARGET_ID,
      ...base,
      kind: "static",
      deployDir: "/deployments/customer-portal",
    });
    onMachine({ kind: "jar", deployDir: "/deployments/customer-portal/x" });
    const res = await patch({ serverId: OTHER_ID });
    expect(res.status).toBe(400);
    expect(repo.listTargetDirsOnMachine).toHaveBeenCalledWith(
      OTHER_ID,
      txState.tx
    );
  });

  it("ignores the target's own row on update", async () => {
    repo.getTarget.mockResolvedValue({
      id: TARGET_ID,
      ...base,
      kind: "static",
      deployDir: "/deployments/customer-portal/web",
    });
    repo.listTargetDirsOnMachine.mockResolvedValue([
      {
        id: TARGET_ID,
        environmentId: ENV_ID,
        kind: "static",
        deployDir: "/deployments/customer-portal/web",
      },
    ]);
    const res = await patch({ deployDir: "/deployments/customer-portal/www" });
    expect(res.status).toBe(200);
  });

  it("does not look up the machine for an update that keeps dir and server", async () => {
    repo.getTarget.mockResolvedValue({
      id: TARGET_ID,
      ...base,
      kind: "static",
    });
    const res = await patch({ autoDeploy: true });
    expect(res.status).toBe(200);
    expect(repo.listTargetDirsOnMachine).not.toHaveBeenCalled();
  });
});

describe("update", () => {
  it("rejects any kind with 400 'Target kind cannot change'", async () => {
    for (const kind of ["jar", "static"]) {
      const res = await patch({ kind });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Target kind cannot change");
    }
    expect(repo.upsertTarget).not.toHaveBeenCalled();
  });

  it("a jar target accepts its own fields and logs them", async () => {
    repo.getTarget.mockResolvedValue({
      id: TARGET_ID,
      ...base,
      kind: "jar",
      jarName: "a.jar",
      systemdUnit: "a",
    });
    const res = await patch({ jarName: "b.jar", systemdUnit: "b" });
    expect(res.status).toBe(200);
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          changes: 'jarName: "a.jar" → "b.jar"; systemdUnit: "a" → "b"',
        }),
      })
    );
  });

  it.each([
    ["jar", { services: ["a"] }],
    ["jar", { tagVariable: "IMAGE_TAG" }],
    ["jar", { preStartCommand: "x" }],
    ["jar", { backupBeforeDeploy: true }],
    ["static", { jarName: "x.jar" }],
    ["static", { healthUrl: "https://a.b/" }],
    ["compose", { jarName: "x.jar" }],
    ["compose", { systemdUnit: "x" }],
  ])("a %s target rejects %j with 400", async (kind, body) => {
    repo.getTarget.mockResolvedValue({ id: TARGET_ID, ...base, kind });
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(repo.upsertTarget).not.toHaveBeenCalled();
  });

  it("insertDeployTargetIn adds the component's app to the project's sources and seeds its branch, in the same transaction", async () => {
    componentArtifact(null);
    await insertDeployTargetIn(txState.tx as never, {
      ...base,
      kind: "compose",
      deployDir: "/opt/core",
      services: ["app"],
      tagVariable: "IMAGE_TAG",
      autoDeploy: false,
      healthTimeoutSeconds: 180,
      backupBeforeDeploy: false,
      preStartCommand: null,
      healthUrl: null,
    });
    expect(projectSources.recordTargetSourceIn).toHaveBeenCalledWith(
      txState.tx,
      {
        environmentId: ENV_ID,
        componentKey: "core-web",
        sourceBranch: "kestrel/development",
      }
    );
  });
});

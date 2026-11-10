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
  apps.assertTargetMatchesEnvironmentApp.mockResolvedValue(undefined);
  repo.environmentUsesServer.mockResolvedValue(true);
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
});

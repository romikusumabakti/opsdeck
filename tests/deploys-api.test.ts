import { beforeEach, describe, expect, it, vi } from "vitest";

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const OTHER_ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e2";
const TARGET_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789c1";
const OTHER_SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789c2";
const BUILD_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";
const TAG = "origin-sucor-development-abc1234";
const PREVIOUS_TAG = "origin-sucor-development-0000001";

const state = vi.hoisted(() => ({ role: "maintainer" as string }));

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
  deleteTarget: vi.fn(),
  environmentUsesServer: vi.fn(),
}));
vi.mock("@/lib/deploy/repository", () => repo);

const apps = vi.hoisted(() => ({
  getComponent: vi.fn(),
  assertTargetMatchesEnvironmentApp: vi.fn(),
}));
vi.mock("@/lib/apps", () => apps);

const deployments = vi.hoisted(() => ({ requestDeployment: vi.fn() }));
vi.mock("@/server/services/deployments", () => deployments);

const { app } = await import("@/server/app");
const { requireProjectPermission } = await import("@/lib/authz");

const target = {
  id: TARGET_ID,
  environmentId: ENV_ID,
  componentKey: "dplk-accounting",
  serverId: SERVER_ID,
  sourceBranch: "sucor/development",
};

const newTarget = {
  environmentId: ENV_ID,
  componentKey: "dplk-accounting",
  serverId: SERVER_ID,
  sourceBranch: "sucor/development",
  deployDir: "/opt/accounting",
  services: ["backend", "frontend"],
};

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DEPLOY_REGISTRY", "192.168.56.113:5000");
  state.role = "maintainer";
  repo.getTarget.mockResolvedValue(target);
  apps.getComponent.mockResolvedValue({ componentKey: "dplk-accounting" });
  apps.assertTargetMatchesEnvironmentApp.mockResolvedValue(undefined);
  repo.environmentUsesServer.mockImplementation(
    async (_env: string, server: string) => server === SERVER_ID
  );
  repo.upsertTarget.mockImplementation(async (input: object) => ({
    id: TARGET_ID,
    ...input,
  }));
  repo.findBuild.mockImplementation(async (_app: string, tag: string) =>
    tag === TAG
      ? { id: BUILD_ID, tag, branch: "sucor/development" }
      : tag === "origin-main-1111111"
        ? { id: "other", tag, branch: "main" }
        : null
  );
  repo.getTagState.mockResolvedValue({
    currentTag: TAG,
    currentStatus: "success",
    previousTag: PREVIOUS_TAG,
  });
  deployments.requestDeployment.mockResolvedValue({
    deploymentId: "dep-1",
    runId: "run-1",
  });
});

describe("permissions", () => {
  it("contributor gets 403 on deploy, rollback and target create", async () => {
    state.role = "contributor";
    expect(
      (
        await send("POST", "/api/deploys/deploy", {
          targetId: TARGET_ID,
          tag: TAG,
        })
      ).status
    ).toBe(403);
    expect(
      (await send("POST", "/api/deploys/rollback", { targetId: TARGET_ID }))
        .status
    ).toBe(403);
    expect((await send("POST", "/api/deploys/targets", newTarget)).status).toBe(
      403
    );
    expect(deployments.requestDeployment).not.toHaveBeenCalled();
    expect(repo.upsertTarget).not.toHaveBeenCalled();
  });

  it("any project role can list targets", async () => {
    state.role = "viewer";
    const res = await send(
      "GET",
      `/api/deploys/targets?environmentId=${ENV_ID}`
    );
    expect(res.status).toBe(200);
    expect(repo.listTargetsForEnvironment).toHaveBeenCalledWith(ENV_ID);
  });

  it("contributor cannot update or delete a target", async () => {
    state.role = "contributor";
    expect(
      (
        await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, {
          autoDeploy: true,
        })
      ).status
    ).toBe(403);
    expect(
      (await send("DELETE", `/api/deploys/targets/${TARGET_ID}`)).status
    ).toBe(403);
    expect(repo.deleteTarget).not.toHaveBeenCalled();
  });
});

describe("authorization scope", () => {
  // The target belongs to OTHER_ENV_ID; the request names ENV_ID where it can.
  // Permission must be checked against the target's own environment.
  beforeEach(() => {
    repo.getTarget.mockResolvedValue({
      ...target,
      environmentId: OTHER_ENV_ID,
    });
  });

  function scopes() {
    return vi.mocked(requireProjectPermission).mock.calls.map((c) => c[0]);
  }

  it("deploy checks the target's environment", async () => {
    const res = await send("POST", "/api/deploys/deploy", {
      targetId: TARGET_ID,
      tag: TAG,
      environmentId: ENV_ID,
    });
    expect(res.status).toBe(200);
    expect(scopes()).toEqual([{ environmentId: OTHER_ENV_ID }]);
  });

  it("rollback checks the target's environment", async () => {
    const res = await send("POST", "/api/deploys/rollback", {
      targetId: TARGET_ID,
      environmentId: ENV_ID,
    });
    expect(res.status).toBe(200);
    expect(scopes()).toEqual([{ environmentId: OTHER_ENV_ID }]);
  });

  it("update checks the target's environment", async () => {
    const res = await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, {
      autoDeploy: true,
    });
    expect(res.status).toBe(200);
    expect(scopes()).toEqual([{ environmentId: OTHER_ENV_ID }]);
  });

  it("delete checks the target's environment", async () => {
    const res = await send(
      "DELETE",
      `/api/deploys/targets/${TARGET_ID}?environmentId=${ENV_ID}`
    );
    expect(res.status).toBe(200);
    expect(scopes()).toEqual([{ environmentId: OTHER_ENV_ID }]);
  });
});

describe("deploy", () => {
  it("deploys a built tag with trigger manual", async () => {
    const res = await send("POST", "/api/deploys/deploy", {
      targetId: TARGET_ID,
      tag: TAG,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deploymentId: "dep-1", runId: "run-1" });
    expect(deployments.requestDeployment).toHaveBeenCalledWith({
      targetId: TARGET_ID,
      tag: TAG,
      trigger: "manual",
      userId: "user-1",
      buildId: BUILD_ID,
    });
  });

  it("deploy of a tag not built for the target branch is 404", async () => {
    for (const tag of ["origin-unknown-2222222", "origin-main-1111111"]) {
      const res = await send("POST", "/api/deploys/deploy", {
        targetId: TARGET_ID,
        tag,
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Build not found" });
    }
    expect(deployments.requestDeployment).not.toHaveBeenCalled();
  });

  it('deploy with tag "latest" is 400', async () => {
    for (const tag of ["latest", "LATEST", "a;rm -rf /", "x".repeat(129)]) {
      const res = await send("POST", "/api/deploys/deploy", {
        targetId: TARGET_ID,
        tag,
      });
      expect(res.status).toBe(400);
    }
    expect(deployments.requestDeployment).not.toHaveBeenCalled();
  });

  it("is 503 when DEPLOY_REGISTRY is unset", async () => {
    vi.stubEnv("DEPLOY_REGISTRY", "");
    const res = await send("POST", "/api/deploys/deploy", {
      targetId: TARGET_ID,
      tag: TAG,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Deploy disabled" });
  });

  it("is 404 for an unknown target", async () => {
    repo.getTarget.mockResolvedValue(null);
    const res = await send("POST", "/api/deploys/deploy", {
      targetId: TARGET_ID,
      tag: TAG,
    });
    expect(res.status).toBe(404);
  });
});

describe("rollback", () => {
  it("rollback without previous tag is 409", async () => {
    repo.getTagState.mockResolvedValue({
      currentTag: TAG,
      currentStatus: "success",
      previousTag: null,
    });
    const res = await send("POST", "/api/deploys/rollback", {
      targetId: TARGET_ID,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "No previous successful deploy",
    });
    expect(deployments.requestDeployment).not.toHaveBeenCalled();
  });

  it("rollback deploys previousTag with trigger rollback", async () => {
    const res = await send("POST", "/api/deploys/rollback", {
      targetId: TARGET_ID,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deploymentId: "dep-1", runId: "run-1" });
    expect(repo.getTagState).toHaveBeenCalledWith(TARGET_ID);
    expect(deployments.requestDeployment).toHaveBeenCalledWith({
      targetId: TARGET_ID,
      tag: PREVIOUS_TAG,
      trigger: "rollback",
      userId: "user-1",
      buildId: null,
    });
  });

  it("rollback passes the build id when the previous tag's build is known", async () => {
    repo.getTagState.mockResolvedValue({
      currentTag: PREVIOUS_TAG,
      currentStatus: "failed",
      previousTag: TAG,
    });
    const res = await send("POST", "/api/deploys/rollback", {
      targetId: TARGET_ID,
    });
    expect(res.status).toBe(200);
    expect(deployments.requestDeployment).toHaveBeenCalledWith({
      targetId: TARGET_ID,
      tag: TAG,
      trigger: "rollback",
      userId: "user-1",
      buildId: BUILD_ID,
    });
  });

  it("is 503 when DEPLOY_REGISTRY is unset", async () => {
    vi.stubEnv("DEPLOY_REGISTRY", "");
    const res = await send("POST", "/api/deploys/rollback", {
      targetId: TARGET_ID,
    });
    expect(res.status).toBe(503);
  });
});

describe("target configuration", () => {
  it("creates a target", async () => {
    const res = await send("POST", "/api/deploys/targets", newTarget);
    expect(res.status).toBe(200);
    expect(repo.upsertTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        ...newTarget,
        autoDeploy: false,
        tagVariable: "IMAGE_TAG",
        healthTimeoutSeconds: 180,
        backupBeforeDeploy: false,
        preStartCommand: null,
        healthUrl: null,
      })
    );
  });

  it('target create rejects deployDir with ".."', async () => {
    const res = await send("POST", "/api/deploys/targets", {
      ...newTarget,
      deployDir: "/opt/../etc",
    });
    expect(res.status).toBe(400);
    expect(repo.upsertTarget).not.toHaveBeenCalled();
  });

  it("rejects a server not used by the environment", async () => {
    const res = await send("POST", "/api/deploys/targets", {
      ...newTarget,
      serverId: OTHER_SERVER_ID,
    });
    expect(res.status).toBe(400);
    expect(repo.upsertTarget).not.toHaveBeenCalled();
  });

  it("rejects a component of another app than the environment's with 409", async () => {
    const { HTTPException } = await import("hono/http-exception");
    apps.assertTargetMatchesEnvironmentApp.mockRejectedValue(
      new HTTPException(409, {
        message: "Component belongs to another app than this environment",
      })
    );
    const res = await send("POST", "/api/deploys/targets", newTarget);
    expect(res.status).toBe(409);
    expect(apps.assertTargetMatchesEnvironmentApp).toHaveBeenCalledWith(
      ENV_ID,
      "dplk-accounting"
    );
    expect(repo.upsertTarget).not.toHaveBeenCalled();
  });

  it("rejects an unknown component with 404", async () => {
    apps.getComponent.mockResolvedValue(null);
    const res = await send("POST", "/api/deploys/targets", newTarget);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Component not found" });
  });

  it("answers 409 for a second target of the same app", async () => {
    repo.upsertTarget.mockRejectedValue({ code: "23505" });
    const res = await send("POST", "/api/deploys/targets", newTarget);
    expect(res.status).toBe(409);
  });

  it.each([
    ["healthTimeoutSeconds below 60", { healthTimeoutSeconds: 59 }],
    ["healthTimeoutSeconds above 900", { healthTimeoutSeconds: 901 }],
    ["deployDir /", { deployDir: "/" }],
    ["deployDir with one segment", { deployDir: "/etc" }],
    ["no services", { services: [] }],
    [
      "more than 20 services",
      { services: Array.from({ length: 21 }, (_, i) => `s${i}`) },
    ],
    ["duplicate services", { services: ["backend", "backend"] }],
    ["a newline in preStartCommand", { preStartCommand: "a\nb" }],
    ["a long preStartCommand", { preStartCommand: "x".repeat(501) }],
    ["a non-http healthUrl", { healthUrl: "ftp://example.test/health" }],
    ["a bad tagVariable", { tagVariable: "bad-name" }],
  ])("create rejects %s", async (_name, patch) => {
    const res = await send("POST", "/api/deploys/targets", {
      ...newTarget,
      ...patch,
    });
    expect(res.status).toBe(400);
    expect(repo.upsertTarget).not.toHaveBeenCalled();
  });

  it("update cannot change componentKey or environmentId", async () => {
    for (const patch of [
      { componentKey: "other" },
      { environmentId: ENV_ID },
    ]) {
      const res = await send(
        "PATCH",
        `/api/deploys/targets/${TARGET_ID}`,
        patch
      );
      expect(res.status).toBe(400);
    }
    expect(repo.upsertTarget).not.toHaveBeenCalled();
  });

  it("update applies the changes and re-checks the server", async () => {
    const ok = await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, {
      autoDeploy: true,
      healthUrl: null,
    });
    expect(ok.status).toBe(200);
    expect(repo.upsertTarget).toHaveBeenCalledWith({
      id: TARGET_ID,
      autoDeploy: true,
      healthUrl: null,
    });
    const bad = await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, {
      serverId: OTHER_SERVER_ID,
    });
    expect(bad.status).toBe(400);
  });

  it("deletes a target", async () => {
    const res = await send("DELETE", `/api/deploys/targets/${TARGET_ID}`);
    expect(res.status).toBe(200);
    expect(repo.deleteTarget).toHaveBeenCalledWith(TARGET_ID);
  });
});

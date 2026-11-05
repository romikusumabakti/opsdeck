import { beforeEach, describe, expect, it, vi } from "vitest";

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const OTHER_ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e2";
const TARGET_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789c1";
const OTHER_SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789c2";
const BUILD_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";
const TAG = "origin-kestrel-development-abc1234";
const PREVIOUS_TAG = "origin-kestrel-development-0000001";

const state = vi.hoisted(() => ({ role: "maintainer" as string }));

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
const { requireProjectPermission } = await import("@/lib/authz");

const target = {
  id: TARGET_ID,
  environmentId: ENV_ID,
  componentKey: "dplk-accounting",
  serverId: SERVER_ID,
  sourceBranch: "kestrel/development",
};

const newTarget = {
  environmentId: ENV_ID,
  componentKey: "dplk-accounting",
  serverId: SERVER_ID,
  sourceBranch: "kestrel/development",
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
  vi.stubEnv("DEPLOY_REGISTRY", "192.168.10.113:5000");
  state.role = "maintainer";
  repo.getTarget.mockResolvedValue(target);
  repo.getDeployLock.mockResolvedValue(null);
  repo.getEnvironmentForLock.mockResolvedValue({
    id: ENV_ID,
    name: "Kestrel Dev",
    ownerId: null,
  });
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
      ? { id: BUILD_ID, tag, branch: "kestrel/development" }
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
    status: "queued",
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

describe("deploy lock", () => {
  const lock = {
    environmentId: ENV_ID,
    lockedBy: "0197f3a0-1b2c-7def-8000-0123456789f1",
    lockerName: "Owner Olga",
    reason: "UAT with the client",
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
  };

  it("refuses a manual deploy while locked with a 409 naming the lock", async () => {
    repo.getDeployLock.mockResolvedValue(lock);
    const res = await send("POST", "/api/deploys/deploy", {
      targetId: TARGET_ID,
      tag: TAG,
    });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toContain("Owner Olga");
    expect(error).toContain("UAT with the client");
    expect(deployments.requestDeployment).not.toHaveBeenCalled();
  });

  it("refuses a rollback while locked, translated", async () => {
    repo.getDeployLock.mockResolvedValue(lock);
    const res = await app.request("/api/deploys/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Locale": "id" },
      body: JSON.stringify({ targetId: TARGET_ID }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("dikunci");
    expect(deployments.requestDeployment).not.toHaveBeenCalled();
  });

  it("an expired lock does not block", async () => {
    repo.getDeployLock.mockResolvedValue({
      ...lock,
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await send("POST", "/api/deploys/deploy", {
      targetId: TARGET_ID,
      tag: TAG,
    });
    expect(res.status).toBe(200);
    expect(deployments.requestDeployment).toHaveBeenCalledTimes(1);
  });

  it("checks the lock only after the permission check", async () => {
    repo.getDeployLock.mockResolvedValue(lock);
    state.role = "contributor";
    const res = await send("POST", "/api/deploys/deploy", {
      targetId: TARGET_ID,
      tag: TAG,
    });
    expect(res.status).toBe(403);
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
      }),
      txState.tx
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
    const { COMPONENT_OTHER_APP_MESSAGE } = await import("@/lib/deploy/errors");
    apps.assertTargetMatchesEnvironmentApp.mockRejectedValue(
      new HTTPException(409, { message: COMPONENT_OTHER_APP_MESSAGE })
    );
    const res = await send("POST", "/api/deploys/targets", newTarget);
    expect(res.status).toBe(409);
    // The dialog tells this 409 from the duplicate-target one by this message.
    expect(await res.json()).toEqual({ error: COMPONENT_OTHER_APP_MESSAGE });
    expect(apps.assertTargetMatchesEnvironmentApp).toHaveBeenCalledWith(
      ENV_ID,
      "dplk-accounting",
      txState.tx
    );
    expect(repo.upsertTarget).not.toHaveBeenCalled();
  });

  it("adopts the app and inserts the target in one transaction", async () => {
    const res = await send("POST", "/api/deploys/targets", newTarget);
    expect(res.status).toBe(200);
    expect(apps.assertTargetMatchesEnvironmentApp).toHaveBeenCalledWith(
      ENV_ID,
      "dplk-accounting",
      txState.tx
    );
    expect(repo.upsertTarget).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: ENV_ID }),
      txState.tx
    );
  });

  it("answers a duplicate target with a 409 that differs from the other-app one", async () => {
    const { COMPONENT_OTHER_APP_MESSAGE } = await import("@/lib/deploy/errors");
    repo.upsertTarget.mockRejectedValue(
      Object.assign(new Error("duplicate key value"), { code: "23505" })
    );
    const res = await send("POST", "/api/deploys/targets", newTarget);
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toBe(
      "This component already has a target in the environment"
    );
    expect(error).not.toBe(COMPONENT_OTHER_APP_MESSAGE);
  });

  // The deploy writes the tag variable itself: a variable of the same name
  // would be overwritten (and the .env render refuses the pair).
  it("refuses a tag variable named like a variable of the environment (409)", async () => {
    const { TAG_VARIABLE_IS_VARIABLE_MESSAGE } = await import(
      "@/lib/deploy/errors"
    );
    variables.getVariable.mockImplementation(
      async (environmentId: string, name: string) =>
        environmentId === ENV_ID && name === "APP_TAG"
          ? { name: "APP_TAG" }
          : undefined
    );
    const created = await send("POST", "/api/deploys/targets", {
      ...newTarget,
      tagVariable: "APP_TAG",
    });
    expect(created.status).toBe(409);
    expect(await created.json()).toEqual({
      error: TAG_VARIABLE_IS_VARIABLE_MESSAGE,
    });
    const updated = await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, {
      tagVariable: "APP_TAG",
    });
    expect(updated.status).toBe(409);
    expect(repo.upsertTarget).not.toHaveBeenCalled();
    // Other names are fine.
    expect(
      (
        await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, {
          tagVariable: "IMAGE_TAG",
        })
      ).status
    ).toBe(200);
    expect(variables.getVariable).toHaveBeenCalledWith(ENV_ID, "IMAGE_TAG");
  });

  it("rejects reserved prefixes as a tag variable name (400)", async () => {
    for (const tagVariable of ["COMPOSE_TAG", "DOCKER_TAG", "BUILDKIT_TAG"]) {
      const created = await send("POST", "/api/deploys/targets", {
        ...newTarget,
        tagVariable,
      });
      expect(created.status, tagVariable).toBe(400);
      const updated = await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, {
        tagVariable,
      });
      expect(updated.status, tagVariable).toBe(400);
    }
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
    expect(repo.upsertTarget).toHaveBeenCalledWith(
      { id: TARGET_ID, autoDeploy: true, healthUrl: null },
      txState.tx
    );
    const bad = await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, {
      serverId: OTHER_SERVER_ID,
    });
    expect(bad.status).toBe(400);
  });

  // Held builds would otherwise deploy on unlock although the target no
  // longer auto-deploys, or builds from the old branch.
  it.each([
    ["auto-deploy is turned off", { autoDeploy: false }],
    ["the source branch changes", { sourceBranch: "kestrel/demo" }],
  ])(
    "supersedes the target's held deployments when %s, in the update's transaction",
    async (_label, patch) => {
      const res = await send(
        "PATCH",
        `/api/deploys/targets/${TARGET_ID}`,
        patch
      );
      expect(res.status).toBe(200);
      expect(repo.upsertTarget).toHaveBeenCalledWith(
        { id: TARGET_ID, ...patch },
        txState.tx
      );
      expect(repo.supersedeHeldDeployments).toHaveBeenCalledWith(
        TARGET_ID,
        txState.tx
      );
    }
  );

  it.each([
    ["auto-deploy stays on", { autoDeploy: true }],
    ["the branch is unchanged", { sourceBranch: "kestrel/development" }],
    ["other fields change", { healthTimeoutSeconds: 60 }],
  ])("keeps held deployments when %s", async (_label, patch) => {
    const res = await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, patch);
    expect(res.status).toBe(200);
    expect(repo.supersedeHeldDeployments).not.toHaveBeenCalled();
  });

  it("deletes a target", async () => {
    const res = await send("DELETE", `/api/deploys/targets/${TARGET_ID}`);
    expect(res.status).toBe(200);
    expect(repo.deleteTarget).toHaveBeenCalledWith(TARGET_ID);
  });
});

describe("target audit", () => {
  const full = {
    ...target,
    autoDeploy: false,
    deployDir: "/opt/accounting",
    services: ["backend"],
    tagVariable: "IMAGE_TAG",
    preStartCommand: "echo secret-token",
    healthUrl: null,
    healthTimeoutSeconds: 180,
    backupBeforeDeploy: false,
  };

  beforeEach(() => {
    repo.getTarget.mockResolvedValue(full);
  });

  function entries() {
    return activity.recordActivity.mock.calls.map((c) => c[0]);
  }

  it("records a create with actor, environment and component", async () => {
    const res = await send("POST", "/api/deploys/targets", newTarget);
    expect(res.status).toBe(200);
    expect(entries()).toEqual([
      {
        actorId: "user-1",
        action: "deployTarget.created",
        entityType: "environment",
        entityId: ENV_ID,
        data: { environment: "Kestrel Dev", component: "dplk-accounting" },
      },
    ]);
  });

  it("records no create that failed", async () => {
    repo.upsertTarget.mockRejectedValue(
      Object.assign(new Error("dup"), { code: "23505" })
    );
    await send("POST", "/api/deploys/targets", newTarget);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("records an update with the changed field names and safe old → new values", async () => {
    const res = await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, {
      autoDeploy: true,
      sourceBranch: "kestrel/demo",
      // Unchanged: left out.
      deployDir: "/opt/accounting",
      services: ["backend", "frontend"],
      healthUrl: "http://localhost:8080/health",
      healthTimeoutSeconds: 60,
      backupBeforeDeploy: true,
      preStartCommand: "echo other-secret",
      serverId: SERVER_ID,
    });
    expect(res.status).toBe(200);
    const [entry] = entries();
    expect(entry).toMatchObject({
      actorId: "user-1",
      action: "deployTarget.updated",
      entityType: "environment",
      entityId: ENV_ID,
      data: {
        environment: "Kestrel Dev",
        component: "dplk-accounting",
        fields:
          "sourceBranch, autoDeploy, services, preStartCommand, healthUrl, healthTimeoutSeconds, backupBeforeDeploy",
        changes:
          'sourceBranch: "kestrel/development" → "kestrel/demo"; autoDeploy: false → true; ' +
          'services: ["backend"] → ["backend","frontend"]; preStartCommand: changed; ' +
          'healthUrl: null → "http://localhost:8080/health"; healthTimeoutSeconds: 180 → 60; ' +
          "backupBeforeDeploy: false → true",
      },
    });
    // The pre-start command never reaches the log.
    expect(JSON.stringify(entries())).not.toContain("secret");
  });

  it("logs a health URL as origin and path only, never credentials or a query", async () => {
    repo.getTarget.mockResolvedValue({
      ...full,
      healthUrl: "https://old:secret@h/old?key=xyz#frag",
    });
    const res = await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, {
      healthUrl: "https://u:p@h/x?token=abc",
    });
    expect(res.status).toBe(200);
    const data = entries()[0]?.data;
    expect(data).toMatchObject({
      fields: "healthUrl",
      changes: 'healthUrl: "https://h/old" → "https://h/x"',
    });
    const recorded = JSON.stringify(entries());
    for (const leak of [
      "u:p",
      "p@",
      "token",
      "abc",
      "old:secret",
      "key=",
      "frag",
    ]) {
      expect(recorded).not.toContain(leak);
    }
  });

  it("logs a health URL it cannot parse as changed", async () => {
    repo.getTarget.mockResolvedValue({ ...full, healthUrl: "not a url" });
    await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, {
      healthUrl: null,
    });
    expect(entries()[0]?.data).toMatchObject({ changes: "healthUrl: changed" });
  });

  it("a failing environment lookup falls back to the id and never fails the request", async () => {
    repo.getEnvironmentForLock.mockRejectedValue(new Error("db blip"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const created = await send("POST", "/api/deploys/targets", newTarget);
    const updated = await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, {
      autoDeploy: true,
    });
    const deleted = await send("DELETE", `/api/deploys/targets/${TARGET_ID}`);
    error.mockRestore();
    expect([created.status, updated.status, deleted.status]).toEqual([
      200, 200, 200,
    ]);
    expect(entries().map((e) => e.data.environment)).toEqual([
      ENV_ID,
      ENV_ID,
      ENV_ID,
    ]);
  });

  it("names a server change without its ids", async () => {
    repo.environmentUsesServer.mockResolvedValue(true);
    await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, {
      serverId: OTHER_SERVER_ID,
    });
    expect(entries()[0]?.data).toMatchObject({
      fields: "serverId",
      changes: "serverId: changed",
    });
  });

  it("records no update when nothing changed", async () => {
    const res = await send("PATCH", `/api/deploys/targets/${TARGET_ID}`, {
      autoDeploy: false,
      tagVariable: "IMAGE_TAG",
    });
    expect(res.status).toBe(200);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("records a delete", async () => {
    const res = await send("DELETE", `/api/deploys/targets/${TARGET_ID}`);
    expect(res.status).toBe(200);
    expect(entries()).toEqual([
      {
        actorId: "user-1",
        action: "deployTarget.deleted",
        entityType: "environment",
        entityId: ENV_ID,
        data: { environment: "Kestrel Dev", component: "dplk-accounting" },
      },
    ]);
  });
});

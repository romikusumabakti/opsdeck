import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  insertBuildIfNew: vi.fn(),
  findAutoTargets: vi.fn(),
}));
vi.mock("@/lib/deploy/repository", () => repo);

const apps = vi.hoisted(() => ({ getComponent: vi.fn() }));
vi.mock("@/lib/apps", () => apps);

const deployments = vi.hoisted(() => ({ requestDeployment: vi.fn() }));
vi.mock("@/server/services/deployments", () => deployments);

const ci = vi.hoisted(() => ({
  getProviderForConnection: vi.fn(),
  getPipeline: vi.fn(),
}));
vi.mock("@/server/services/ci-connections", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProviderForConnection: ci.getProviderForConnection,
}));

const { verifySignature } = await import("@/lib/deploy/signature");
const { app } = await import("@/server/app");

const SECRET = "test-notify-secret-0123456789abcdef";
const BUILD_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";
const TARGET_A = "0197f3a0-1b2c-7def-8000-0123456789a1";
const TARGET_B = "0197f3a0-1b2c-7def-8000-0123456789a2";
const TAG = "origin-kestrel-development-abc1234";

const notification = {
  app: "dplk-accounting",
  branch: "kestrel/development",
  tag: TAG,
  commit: "abc1234def5678",
  pipelineUrl: "https://ci.example.test/repos/1/pipeline/42",
};

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function deliver(body: string, signature?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (signature !== undefined) headers["X-Opsdeck-Signature"] = signature;
  return app.request("/api/deploy-hooks/builds", {
    method: "POST",
    headers,
    body,
  });
}

beforeEach(() => {
  vi.stubEnv("DEPLOY_REGISTRY", "192.168.10.113:5000");
  apps.getComponent.mockImplementation(async (componentKey: string) =>
    // A secret without the enc:v1: prefix decrypts to itself (legacy rows).
    componentKey === "dplk-accounting"
      ? {
          componentKey,
          notifySecret: SECRET,
          ciConnectionId: "conn-1",
          ciRepoId: "1",
        }
      : null
  );
  ci.getProviderForConnection.mockResolvedValue({
    getPipeline: ci.getPipeline,
  });
  ci.getPipeline.mockResolvedValue({
    sender: "romi",
    authorEmail: "romi@example.test",
    message: "fix: thing",
  });
  repo.insertBuildIfNew.mockResolvedValue({
    build: { id: BUILD_ID },
    created: true,
  });
  repo.findAutoTargets.mockResolvedValue([{ id: TARGET_A }, { id: TARGET_B }]);
  deployments.requestDeployment.mockImplementation(
    async (input: { targetId: string }) => ({
      deploymentId: `dep-${input.targetId}`,
      runId: `run-${input.targetId}`,
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("verifySignature", () => {
  const body = JSON.stringify(notification);

  it("accepts the right HMAC and rejects wrong, missing, non-hex and wrong-length", () => {
    const good = sign(body);
    expect(verifySignature(body, good, SECRET)).toBe(true);

    expect(verifySignature(body, sign(body, "other-secret"), SECRET)).toBe(
      false
    );
    expect(verifySignature(`${body} `, good, SECRET)).toBe(false);
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, "", SECRET)).toBe(false);
    expect(verifySignature(body, good.slice("sha256=".length), SECRET)).toBe(
      false
    );
    expect(verifySignature(body, `sha1=${"a".repeat(64)}`, SECRET)).toBe(false);
    expect(verifySignature(body, `sha256=${"z".repeat(64)}`, SECRET)).toBe(
      false
    );
    expect(verifySignature(body, good.slice(0, -2), SECRET)).toBe(false);
    expect(verifySignature(body, `${good}00`, SECRET)).toBe(false);
    expect(verifySignature(body, ` ${good}`, SECRET)).toBe(false);
  });
});

describe("POST /api/deploy-hooks/builds", () => {
  it("401 with identical body for unknown app, missing signature, bad signature; nothing recorded", async () => {
    const known = JSON.stringify(notification);
    const unknown = JSON.stringify({ ...notification, app: "no-such-app" });
    const responses = await Promise.all([
      deliver(unknown, sign(unknown)),
      deliver(known),
      deliver(known, sign(known, "wrong-secret")),
      deliver(known, "sha256=not-hex"),
      deliver(JSON.stringify({ ...notification, app: 42 }), sign(known)),
    ]);

    const bodies = await Promise.all(responses.map((r) => r.text()));
    for (const [i, res] of responses.entries()) {
      expect(res.status).toBe(401);
      expect(bodies[i]).toBe(JSON.stringify({ error: "Unauthorized" }));
      expect(res.headers.get("content-type")).toBe(
        responses[0]?.headers.get("content-type")
      );
    }
    expect(repo.insertBuildIfNew).not.toHaveBeenCalled();
    expect(deployments.requestDeployment).not.toHaveBeenCalled();
  });

  it("401, the same as an unknown app, when the stored secret cannot be decrypted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    apps.getComponent.mockResolvedValue({
      componentKey: "dplk-accounting",
      notifySecret: "enc:v1:bm90LWEtcmVhbC1jaXBoZXJ0ZXh0",
    });
    const body = JSON.stringify(notification);
    const res = await deliver(body, sign(body));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("dplk-accounting"),
      expect.anything()
    );
    expect(repo.insertBuildIfNew).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('400 for tag "latest" and tag "a;b" with a valid signature', async () => {
    for (const tag of ["latest", "LATEST", "a;b", "a".repeat(129)]) {
      const body = JSON.stringify({ ...notification, tag });
      const res = await deliver(body, sign(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid request" });
    }
    expect(repo.insertBuildIfNew).not.toHaveBeenCalled();
  });

  it("400 for a body that is not JSON", async () => {
    const body = "{not json";
    const res = await deliver(body, sign(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request" });
  });

  it("413 for a body over the size cap, before any lookup", async () => {
    const body = JSON.stringify({ ...notification, pad: "x".repeat(20_000) });
    const res = await deliver(body, sign(body));
    expect(res.status).toBe(413);
    expect(apps.getComponent).not.toHaveBeenCalled();
  });

  it("202 and one auto deployment per matching target on first delivery", async () => {
    const body = JSON.stringify(notification);
    const res = await deliver(body, sign(body));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      buildId: BUILD_ID,
      created: true,
      deploymentIds: [`dep-${TARGET_A}`, `dep-${TARGET_B}`],
    });
    expect(repo.insertBuildIfNew).toHaveBeenCalledWith({
      componentKey: "dplk-accounting",
      branch: "kestrel/development",
      tag: TAG,
      commitSha: "abc1234def5678",
      pipelineUrl: notification.pipelineUrl,
      pushedBy: "romi",
      commitAuthorEmail: "romi@example.test",
      commitMessage: "fix: thing",
    });
    expect(ci.getProviderForConnection).toHaveBeenCalledWith("conn-1");
    expect(ci.getPipeline).toHaveBeenCalledWith("1", 42);
    expect(repo.findAutoTargets).toHaveBeenCalledWith(
      "dplk-accounting",
      "kestrel/development"
    );
    expect(deployments.requestDeployment).toHaveBeenCalledTimes(2);
    for (const targetId of [TARGET_A, TARGET_B]) {
      expect(deployments.requestDeployment).toHaveBeenCalledWith({
        targetId,
        tag: TAG,
        trigger: "auto",
        userId: null,
        buildId: BUILD_ID,
      });
    }
  });

  it("maps the hook's app field to the component key", async () => {
    const body = JSON.stringify(notification);
    await deliver(body, sign(body));
    expect(repo.insertBuildIfNew).toHaveBeenCalledWith(
      expect.objectContaining({ componentKey: "dplk-accounting" })
    );
    expect(repo.findAutoTargets.mock.calls[0]?.[0]).toBe("dplk-accounting");
  });

  it("records the build and requests the other targets when one request fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    deployments.requestDeployment.mockImplementation(
      async (input: { targetId: string }) => {
        if (input.targetId === TARGET_A) throw new Error("boom");
        return { deploymentId: `dep-${input.targetId}`, runId: "run" };
      }
    );
    const body = JSON.stringify(notification);
    const res = await deliver(body, sign(body));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      buildId: BUILD_ID,
      created: true,
      deploymentIds: [`dep-${TARGET_B}`],
    });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0])).not.toContain(SECRET);
    errors.mockRestore();
  });

  it("stores a missing pipelineUrl as null", async () => {
    const { pipelineUrl: _omit, ...rest } = notification;
    const body = JSON.stringify(rest);
    const res = await deliver(body, sign(body));
    expect(res.status).toBe(202);
    expect(repo.insertBuildIfNew).toHaveBeenCalledWith(
      expect.objectContaining({ pipelineUrl: null, pushedBy: null })
    );
    expect(ci.getPipeline).not.toHaveBeenCalled();
  });

  it("replayed build: created=false, requestDeployment not called", async () => {
    repo.insertBuildIfNew.mockResolvedValue({
      build: { id: BUILD_ID },
      created: false,
    });
    const body = JSON.stringify(notification);
    const res = await deliver(body, sign(body));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      buildId: BUILD_ID,
      created: false,
      deploymentIds: [],
    });
    expect(repo.findAutoTargets).not.toHaveBeenCalled();
    expect(deployments.requestDeployment).not.toHaveBeenCalled();
  });

  it("503 when DEPLOY_REGISTRY unset", async () => {
    vi.stubEnv("DEPLOY_REGISTRY", "");
    const body = JSON.stringify(notification);
    const res = await deliver(body, sign(body));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Deploy disabled" });
    expect(apps.getComponent).not.toHaveBeenCalled();
    expect(repo.insertBuildIfNew).not.toHaveBeenCalled();
  });
});

describe("build actors on notify", () => {
  const NULLS = {
    pushedBy: null,
    commitAuthorEmail: null,
    commitMessage: null,
  };

  async function deliverOk() {
    const body = JSON.stringify(notification);
    const res = await deliver(body, sign(body));
    expect(res.status).toBe(202);
    return res.json();
  }

  function expectRecordedWithNulls() {
    expect(repo.insertBuildIfNew).toHaveBeenCalledWith(
      expect.objectContaining({ tag: TAG, ...NULLS })
    );
    expect(deployments.requestDeployment).toHaveBeenCalledTimes(2);
  }

  it("records the build with null actors and still deploys when the CI API fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { CiProviderError } = await import("@/lib/ci/types");
    ci.getPipeline.mockRejectedValue(
      new CiProviderError(
        "Woodpecker GET /api/repos/1/pipelines/42 unreachable",
        0
      )
    );
    await expect(deliverOk()).resolves.toMatchObject({
      created: true,
      deploymentIds: [`dep-${TARGET_A}`, `dep-${TARGET_B}`],
    });
    expectRecordedWithNulls();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("records nulls when the connection cannot give a provider (no token)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ci.getProviderForConnection.mockRejectedValue(new Error("no token"));
    await deliverOk();
    expectRecordedWithNulls();
    warn.mockRestore();
  });

  it("gives up after 5 s and records nulls when the CI API hangs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    ci.getPipeline.mockReturnValue(new Promise(() => {}));
    const body = JSON.stringify(notification);
    const pending = deliver(body, sign(body));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(repo.insertBuildIfNew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(202);
    expectRecordedWithNulls();
    warn.mockRestore();
  });

  it("does not fetch a pipeline URL of another repo", async () => {
    const other = {
      ...notification,
      pipelineUrl: "https://ci.example.test/repos/9/pipeline/42",
    };
    const body = JSON.stringify(other);
    const res = await deliver(body, sign(body));
    expect(res.status).toBe(202);
    expect(ci.getProviderForConnection).not.toHaveBeenCalled();
    expect(ci.getPipeline).not.toHaveBeenCalled();
    expect(repo.insertBuildIfNew).toHaveBeenCalledWith(
      expect.objectContaining(NULLS)
    );
  });

  it("does not fetch when the component has no CI connection", async () => {
    apps.getComponent.mockResolvedValue({
      componentKey: "dplk-accounting",
      notifySecret: SECRET,
      ciConnectionId: null,
      ciRepoId: null,
    });
    await deliverOk();
    expect(ci.getProviderForConnection).not.toHaveBeenCalled();
    expect(repo.insertBuildIfNew).toHaveBeenCalledWith(
      expect.objectContaining(NULLS)
    );
  });

  it("stores the commit email and message when the forge sends no pusher (Bitbucket)", async () => {
    ci.getPipeline.mockResolvedValue({
      sender: null,
      authorEmail: "Romi@dss.test",
      message: "fix: thing",
    });
    await deliverOk();
    expect(repo.insertBuildIfNew).toHaveBeenCalledWith(
      expect.objectContaining({
        pushedBy: null,
        commitAuthorEmail: "Romi@dss.test",
        commitMessage: "fix: thing",
      })
    );
  });

  it("truncates the pusher to 200 and the message to 500 characters", async () => {
    ci.getPipeline.mockResolvedValue({
      sender: "s".repeat(300),
      authorEmail: `${"e".repeat(400)}@example.test`,
      message: "m".repeat(800),
    });
    await deliverOk();
    const stored = repo.insertBuildIfNew.mock.calls[0]?.[0];
    expect(stored.pushedBy).toBe("s".repeat(200));
    expect(stored.commitAuthorEmail).toHaveLength(320);
    expect(stored.commitMessage).toBe("m".repeat(500));
  });
});

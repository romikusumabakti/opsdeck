import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  getDeployApp: vi.fn(),
  insertBuildIfNew: vi.fn(),
  findAutoTargets: vi.fn(),
}));
vi.mock("@/lib/deploy/repository", () => repo);

const deployments = vi.hoisted(() => ({ requestDeployment: vi.fn() }));
vi.mock("@/server/services/deployments", () => deployments);

const { verifySignature } = await import("@/lib/deploy/signature");
const { app } = await import("@/server/app");

const SECRET = "test-notify-secret-0123456789abcdef";
const BUILD_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";
const TARGET_A = "0197f3a0-1b2c-7def-8000-0123456789a1";
const TARGET_B = "0197f3a0-1b2c-7def-8000-0123456789a2";
const TAG = "origin-sucor-development-abc1234";

const notification = {
  app: "dplk-accounting",
  branch: "sucor/development",
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
  vi.stubEnv("DEPLOY_REGISTRY", "192.168.56.113:5000");
  repo.getDeployApp.mockImplementation(async (appKey: string) =>
    appKey === "dplk-accounting" ? { appKey, notifySecretPlain: SECRET } : null
  );
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
    expect(repo.getDeployApp).not.toHaveBeenCalled();
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
      appKey: "dplk-accounting",
      branch: "sucor/development",
      tag: TAG,
      commitSha: "abc1234def5678",
      pipelineUrl: notification.pipelineUrl,
    });
    expect(repo.findAutoTargets).toHaveBeenCalledWith(
      "dplk-accounting",
      "sucor/development"
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
      expect.objectContaining({ pipelineUrl: null })
    );
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
    expect(repo.getDeployApp).not.toHaveBeenCalled();
    expect(repo.insertBuildIfNew).not.toHaveBeenCalled();
  });
});

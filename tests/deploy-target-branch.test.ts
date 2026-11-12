import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Choosing a deploy target's source branch commits a generated component's
 * pipeline file to that branch (the commit builds it) and flags a manual
 * target to deploy that build.
 */

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const TARGET_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789c1";
const CONN = "0197f3a0-1b2c-7def-8000-0123456789c2";
const NOTIFY = "opsdeck_notify_core_web";
const SKIP = "[CI SKIP]";

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));
vi.mock("@/lib/authz", () => ({
  getProjectAccess: vi.fn(),
  requireOrgPermission: vi.fn(),
  requireProjectPermission: vi.fn(async () => ({
    session: { user: { id: "user-1" } },
    role: "engineer",
    projectId: "project-1",
  })),
}));

const repo = vi.hoisted(() => ({
  getTarget: vi.fn(),
  upsertTarget: vi.fn(),
  supersedeHeldDeployments: vi.fn(),
  environmentUsesServer: vi.fn(),
  listTargetDirsOnMachine: vi.fn(),
  getEnvironmentForLock: vi.fn(),
}));
vi.mock("@/lib/deploy/repository", () => repo);
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));

const apps = vi.hoisted(() => ({
  getComponent: vi.fn(),
  appendBuildSpecBranch: vi.fn(),
  setPipelineFileCommit: vi.fn(),
  assertTargetMatchesEnvironmentApp: vi.fn(),
}));
vi.mock("@/lib/apps", () => apps);

// The silent project-sources insert needs a real tx; its own tests cover it.
vi.mock("@/lib/project-sources", () => ({
  recordTargetSourceIn: vi.fn(),
  ensureProjectSourceIn: vi.fn(),
}));

const forge = vi.hoisted(() => ({
  branchExists: vi.fn(),
  commitFile: vi.fn(),
  readRepoFileOrLarge: vi.fn(),
  getForgeCredentials: vi.fn(),
}));
vi.mock("@/lib/ci/forges/bitbucket", () => ({
  branchExists: forge.branchExists,
  commitFile: forge.commitFile,
  readRepoFileOrLarge: forge.readRepoFileOrLarge,
  FILE_TOO_LARGE: Symbol("too-large"),
}));
vi.mock("@/server/services/ci-connections", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/services/ci-connections")
  >()),
  getForgeCredentials: forge.getForgeCredentials,
}));

vi.mock("@/lib/teardown/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/teardown/guard")>()),
  tearingDownIn: async () => false,
}));
vi.mock("@/lib/db", () => ({
  db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
}));
vi.mock("@/lib/variables/repository", () => ({ getVariable: vi.fn() }));
vi.mock("@/server/services/deployments", () => ({
  requestDeployment: vi.fn(),
}));

const { app } = await import("@/server/app");
const { buildSpecSchema } = await import("@/lib/ci/build-spec");

const IMAGE_SPEC = buildSpecSchema.parse({
  branches: ["main"],
  images: [{ name: "core-web", dockerfile: "Dockerfile", context: "." }],
  bundleFiles: [{ from: "compose.yaml", to: "compose.yaml" }],
});
const ARTIFACT_SPEC = buildSpecSchema.parse({
  branches: [],
  artifact: { kind: "jar", path: "build/libs" },
  checks: [
    {
      name: "gradle-build",
      image: "docker.io/library/eclipse-temurin:21",
      dir: ".",
      commands: ["./gradlew bootJar"],
    },
  ],
});

function component(overrides: object = {}) {
  return {
    componentKey: "core-web",
    ciConnectionId: CONN,
    repoFullName: "dss/core-web",
    pipelineMode: "generated",
    buildSpec: IMAGE_SPEC,
    notifySecretName: NOTIFY,
    pipelineFileCommits: null,
    app: { appKey: "core" },
    ...overrides,
  };
}

const target = {
  id: TARGET_ID,
  environmentId: ENV_ID,
  componentKey: "core-web",
  serverId: SERVER_ID,
  kind: "compose",
  sourceBranch: "main",
  autoDeploy: false,
  deployNextBuild: false,
};

function send(method: string, path: string, body: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const patch = (body: unknown) =>
  send("PATCH", `/api/deploys/targets/${TARGET_ID}`, body);
const create = (body: object = {}) =>
  send("POST", "/api/deploys/targets", {
    environmentId: ENV_ID,
    componentKey: "core-web",
    serverId: SERVER_ID,
    sourceBranch: "feat/x",
    deployDir: "/opt/core",
    services: ["core-web"],
    ...body,
  });

/** The fields of the target write (insert or update). */
const written = () => repo.upsertTarget.mock.calls[0]?.[0];
const committedBranches = () => forge.commitFile.mock.calls.map((c) => c[2]);

beforeEach(() => {
  vi.stubEnv("DEPLOY_REGISTRY", "registry.example.com");
  vi.clearAllMocks();
  repo.getTarget.mockResolvedValue(target);
  repo.environmentUsesServer.mockResolvedValue(true);
  repo.getEnvironmentForLock.mockResolvedValue({ id: ENV_ID, name: "Core" });
  repo.upsertTarget.mockImplementation(async (input: object) => ({
    ...target,
    ...input,
  }));
  apps.assertTargetMatchesEnvironmentApp.mockResolvedValue(null);
  repo.listTargetDirsOnMachine.mockResolvedValue([]);
  apps.appendBuildSpecBranch.mockResolvedValue(true);
  apps.getComponent.mockResolvedValue(component());
  forge.getForgeCredentials.mockResolvedValue({
    forge: "bitbucket",
    auth: { username: "u", token: "t" },
  });
  forge.branchExists.mockResolvedValue(true);
  forge.readRepoFileOrLarge.mockResolvedValue(null);
  forge.commitFile.mockResolvedValue({ sha: "abc" });
});

describe("changing a target's source branch", () => {
  it("adds the branch to the build spec and commits once to it, with a building message", async () => {
    // Re-read after the append: the stored spec now lists the branch.
    apps.getComponent.mockResolvedValueOnce(component()).mockResolvedValueOnce(
      component({
        buildSpec: { ...IMAGE_SPEC, branches: ["main", "feat/x"] },
      })
    );
    const res = await patch({ sourceBranch: "feat/x" });
    expect(res.status).toBe(200);
    expect(apps.appendBuildSpecBranch).toHaveBeenCalledWith(
      "core-web",
      "feat/x"
    );
    expect(committedBranches()).toEqual(["feat/x"]);
    const [, repoName, , path, yaml, message] =
      forge.commitFile.mock.calls[0] ?? [];
    expect(repoName).toBe("dss/core-web");
    expect(path).toBe(".woodpecker.yaml");
    expect(yaml).toContain("feat/x");
    // The stored notify secret name (Task 4), not the default.
    expect(yaml).toContain(`from_secret: ${NOTIFY}`);
    expect(message).toMatch(/^ci: update \.woodpecker\.yaml/);
    expect(message).not.toContain(SKIP);
    expect(apps.setPipelineFileCommit).toHaveBeenCalledWith(
      "core-web",
      "feat/x",
      { sha: "abc" }
    );
    // Existing response fields stay; the failures are added.
    expect(await res.json()).toMatchObject({
      id: TARGET_ID,
      sourceBranch: "feat/x",
      pipelineFileFailures: [],
    });
  });

  it("flags a manual target to deploy the next build, in the same update", async () => {
    await patch({ sourceBranch: "feat/x" });
    expect(repo.upsertTarget).toHaveBeenCalledTimes(1);
    expect(written()).toMatchObject({
      id: TARGET_ID,
      sourceBranch: "feat/x",
      deployNextBuild: true,
    });
  });

  it("does not flag an auto-deploy target", async () => {
    repo.getTarget.mockResolvedValue({ ...target, autoDeploy: true });
    await patch({ sourceBranch: "feat/x" });
    expect(written()).not.toHaveProperty("deployNextBuild");
    expect(committedBranches()).toEqual(["feat/x"]);
  });

  it("does not flag a target switched to auto-deploy in the same update", async () => {
    await patch({ sourceBranch: "feat/x", autoDeploy: true });
    expect(written()).not.toHaveProperty("deployNextBuild");
  });

  it("commits for an artifact component with no branches yet", async () => {
    apps.getComponent.mockResolvedValue(
      component({ buildSpec: ARTIFACT_SPEC })
    );
    const res = await patch({ sourceBranch: "feat/x" });
    expect(res.status).toBe(200);
    expect(apps.appendBuildSpecBranch).toHaveBeenCalledWith(
      "core-web",
      "feat/x"
    );
    expect(committedBranches()).toEqual(["feat/x"]);
    expect(forge.commitFile.mock.calls[0]?.[5]).not.toContain(SKIP);
  });

  it("saves the target and returns the failure when the branch holds a foreign pipeline file", async () => {
    forge.readRepoFileOrLarge.mockResolvedValue("steps:\n  x:\n    image: y\n");
    const res = await patch({ sourceBranch: "feat/x" });
    expect(res.status).toBe(200);
    expect(repo.upsertTarget).toHaveBeenCalledTimes(1);
    expect(forge.commitFile).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({
      sourceBranch: "feat/x",
      pipelineFileFailures: [
        {
          componentKey: "core-web",
          branch: "feat/x",
          code: "pipelineFileExists",
          error: "pipelineFileExists",
        },
      ],
    });
  });

  it("saves the target and returns the failure when the forge is down", async () => {
    forge.branchExists.mockRejectedValue(new Error("socket hang up"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await patch({ sourceBranch: "feat/x" });
    expect(res.status).toBe(200);
    expect(repo.upsertTarget).toHaveBeenCalledTimes(1);
    expect((await res.json()).pipelineFileFailures).toEqual([
      {
        componentKey: "core-web",
        branch: "feat/x",
        code: null,
        error: "The commit failed unexpectedly",
      },
    ]);
  });

  it("saves the target and returns a failure when adding the branch throws", async () => {
    apps.appendBuildSpecBranch.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await patch({ sourceBranch: "feat/x" });
    expect(res.status).toBe(200);
    expect(repo.upsertTarget).toHaveBeenCalledTimes(1);
    expect((await res.json()).pipelineFileFailures).toEqual([
      {
        componentKey: "core-web",
        branch: "feat/x",
        code: null,
        error: "The pipeline file could not be committed",
      },
    ]);
  });

  it("commits nothing for a custom component", async () => {
    apps.getComponent.mockResolvedValue(
      component({ pipelineMode: "custom", buildSpec: null })
    );
    const res = await patch({ sourceBranch: "feat/x" });
    expect(res.status).toBe(200);
    expect(forge.commitFile).not.toHaveBeenCalled();
    expect(apps.appendBuildSpecBranch).not.toHaveBeenCalled();
    expect(written()).not.toHaveProperty("deployNextBuild");
    expect((await res.json()).pipelineFileFailures).toEqual([]);
  });

  it("commits nothing when the branch does not change", async () => {
    const res = await patch({ sourceBranch: "main", deployDir: "/opt/x" });
    expect(res.status).toBe(200);
    expect(apps.getComponent).not.toHaveBeenCalled();
    expect(forge.commitFile).not.toHaveBeenCalled();
    expect(written()).not.toHaveProperty("deployNextBuild");
    expect((await res.json()).pipelineFileFailures).toEqual([]);
  });
});

describe("creating a target", () => {
  it("commits the pipeline to its branch and flags a manual target", async () => {
    const res = await create();
    expect(res.status).toBe(200);
    expect(written()).toMatchObject({
      sourceBranch: "feat/x",
      deployNextBuild: true,
    });
    expect(committedBranches()).toEqual(["feat/x"]);
    expect(forge.commitFile.mock.calls[0]?.[5]).not.toContain(SKIP);
    expect(await res.json()).toMatchObject({
      sourceBranch: "feat/x",
      pipelineFileFailures: [],
    });
  });

  it("does not flag an auto-deploy target", async () => {
    await create({ autoDeploy: true });
    expect(written()).toMatchObject({ deployNextBuild: false });
    expect(committedBranches()).toEqual(["feat/x"]);
  });

  it("saves the target and returns the failure of a foreign pipeline file", async () => {
    forge.readRepoFileOrLarge.mockResolvedValue("steps: {}\n");
    const res = await create();
    expect(res.status).toBe(200);
    expect(repo.upsertTarget).toHaveBeenCalledTimes(1);
    expect((await res.json()).pipelineFileFailures).toMatchObject([
      { branch: "feat/x", code: "pipelineFileExists" },
    ]);
  });

  it("commits nothing for a custom component", async () => {
    apps.getComponent.mockResolvedValue(
      component({ pipelineMode: "custom", buildSpec: null })
    );
    const res = await create();
    expect(res.status).toBe(200);
    expect(forge.commitFile).not.toHaveBeenCalled();
    expect(written()).toMatchObject({ deployNextBuild: false });
    expect((await res.json()).pipelineFileFailures).toEqual([]);
  });
});

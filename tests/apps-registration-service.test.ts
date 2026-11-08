import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOO_LARGE = vi.hoisted(() => Symbol("too-large"));
const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getProjectAccess: vi.fn(),
  getComponent: vi.fn(),
  appendBuildSpecBranch: vi.fn(),
  requireProjectPermission: vi.fn(),
  listRepos: vi.fn(),
  setPipelineFileCommit: vi.fn(),
  branchExists: vi.fn(),
  commitFile: vi.fn(),
  readRepoFile: vi.fn(),
  getForgeCredentials: vi.fn(),
  activateRepo: vi.fn(),
  insertComponents: vi.fn(),
  getApp: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/authz", () => ({
  getProjectAccess: mocks.getProjectAccess,
  requireOrgPermission: vi.fn(),
  requireProjectPermission: mocks.requireProjectPermission,
}));
vi.mock("@/lib/apps", () => ({
  appKeyExists: async () => false,
  componentTargetBranches: vi.fn(),
  getApp: mocks.getApp,
  getComponent: mocks.getComponent,
  insertAppWithComponents: async () => undefined,
  insertComponents: mocks.insertComponents,
  linkedCiRepos: async () => [],
  listApps: vi.fn(),
  projectIdsWithAppEnvironment: vi.fn(),
  appendBuildSpecBranch: mocks.appendBuildSpecBranch,
  setNotifySecret: vi.fn(),
  setPipelineFileCommit: mocks.setPipelineFileCommit,
  takenComponentKeys: async () => [],
}));
vi.mock("@/lib/ci/forges/bitbucket", () => ({
  branchExists: mocks.branchExists,
  commitFile: mocks.commitFile,
  readRepoFileOrLarge: mocks.readRepoFile,
  FILE_TOO_LARGE: TOO_LARGE,
}));
vi.mock("@/server/services/ci-connections", () => ({
  getForgeCredentials: mocks.getForgeCredentials,
  getProviderForConnection: async () => ({
    listRepos: mocks.listRepos,
    activateRepo: mocks.activateRepo,
    updateRepoSettings: async () => undefined,
    upsertRepoSecret: async () => undefined,
  }),
  listConnectionOptions: vi.fn(),
}));
vi.mock("@/lib/secrets", () => ({ encryptSecret: (s: string) => s }));

import { buildSpecSchema } from "@/lib/ci/build-spec";
import { generateWoodpeckerPipeline } from "@/lib/ci/pipeline";
import {
  addComponentsToApp,
  ensureComponentBranch,
  registerApp,
} from "@/server/services/apps";

const CONN = "0197f3a0-1b2c-7def-8000-0123456789c1";
const SPEC = buildSpecSchema.parse({
  branches: ["main"],
  images: [{ name: "hris-backend", dockerfile: "Dockerfile", context: "." }],
  bundleFiles: [{ from: "compose.yaml", to: "compose.yaml" }],
});
const GENERATED = generateWoodpeckerPipeline("hris", SPEC, {
  registry: "registry.example.com",
});

const COMPONENT = {
  componentKey: "hris",
  ciConnectionId: CONN,
  repoFullName: "dss/hris",
  pipelineMode: "generated",
  buildSpec: SPEC,
};

beforeEach(() => {
  vi.stubEnv("DEPLOY_REGISTRY", "registry.example.com");
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({ user: { role: "member" } });
  mocks.getProjectAccess.mockResolvedValue({ roles: { p1: "engineer" } });
  mocks.getForgeCredentials.mockResolvedValue({
    forge: "bitbucket",
    auth: { username: "u", token: "t" },
  });
  mocks.branchExists.mockResolvedValue(true);
  mocks.commitFile.mockResolvedValue({ sha: "abc" });
  mocks.readRepoFile.mockResolvedValue(null);
  mocks.getComponent.mockResolvedValue({ ...COMPONENT, app: {} });
  mocks.requireProjectPermission.mockResolvedValue({});
  mocks.appendBuildSpecBranch.mockResolvedValue(true);
  mocks.listRepos.mockResolvedValue([
    { ciRepoId: "7", fullName: "dss/hris", forgeRemoteId: "{a}", active: true },
  ]);
  mocks.activateRepo.mockResolvedValue({
    ciRepoId: "7",
    fullName: "dss/hris",
  });
  mocks.getApp.mockResolvedValue({
    id: "app-1",
    appKey: "hris",
    name: "HRIS",
    components: [],
  });
});

const REGISTER = {
  appKey: "hris",
  name: "HRIS",
  components: [
    {
      componentKey: "hris",
      ciConnectionId: CONN,
      forgeRemoteId: "{a}",
      bundleImage: "hris-deploy",
      pipelineMode: "generated" as const,
      buildSpec: SPEC,
    },
  ],
};

describe("registerApp for engineers", () => {
  it("lets an engineer register a generated pipeline", async () => {
    await expect(registerApp(REGISTER)).resolves.toBeDefined();
    expect(mocks.commitFile).toHaveBeenCalledTimes(1);
  });

  it("refuses up front (409) when a branch holds a non-Panel pipeline file", async () => {
    mocks.readRepoFile.mockResolvedValue("steps:\n  build:\n    image: x\n");
    await expect(registerApp(REGISTER)).rejects.toMatchObject({
      status: 409,
      code: "pipelineFileExists",
    });
    expect(mocks.activateRepo).not.toHaveBeenCalled();
    expect(mocks.commitFile).not.toHaveBeenCalled();
  });

  it("refuses a Panel file generated for another component", async () => {
    mocks.readRepoFile.mockResolvedValue(
      generateWoodpeckerPipeline("other", SPEC, {
        registry: "registry.example.com",
      })
    );
    await expect(registerApp(REGISTER)).rejects.toMatchObject({
      code: "pipelineFileExists",
    });
    expect(mocks.activateRepo).not.toHaveBeenCalled();
  });

  it("fails closed on a pipeline file too large to read", async () => {
    mocks.readRepoFile.mockResolvedValue(TOO_LARGE);
    await expect(registerApp(REGISTER)).rejects.toMatchObject({
      code: "pipelineFileExists",
    });
    expect(mocks.activateRepo).not.toHaveBeenCalled();
  });

  it("overwrites a Panel-generated pipeline file", async () => {
    mocks.readRepoFile.mockResolvedValue(GENERATED);
    await registerApp(REGISTER);
    expect(mocks.commitFile).toHaveBeenCalledTimes(1);
  });
});

describe("addComponentsToApp", () => {
  it("registers the components into the existing app", async () => {
    await expect(
      addComponentsToApp("hris", REGISTER.components)
    ).resolves.toMatchObject({ appKey: "hris" });
    expect(mocks.insertComponents).toHaveBeenCalledWith("app-1", [
      expect.objectContaining({
        componentKey: "hris",
        ciRepoId: "7",
        repoFullName: "dss/hris",
        pipelineMode: "generated",
      }),
    ]);
    expect(mocks.commitFile).toHaveBeenCalledTimes(1);
  });

  it("refuses a foreign pipeline file before inserting (409)", async () => {
    mocks.readRepoFile.mockResolvedValue("steps:\n  build:\n    image: x\n");
    await expect(
      addComponentsToApp("hris", REGISTER.components)
    ).rejects.toMatchObject({ status: 409, code: "pipelineFileExists" });
    expect(mocks.activateRepo).not.toHaveBeenCalled();
    expect(mocks.insertComponents).not.toHaveBeenCalled();
  });

  it("rejects an invalid component (400)", async () => {
    await expect(
      addComponentsToApp("hris", [
        { ...REGISTER.components[0], bundleImage: "wrong-deploy" },
      ] as typeof REGISTER.components)
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.insertComponents).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown app", async () => {
    mocks.getApp.mockResolvedValue(undefined);
    await expect(
      addComponentsToApp("nope", REGISTER.components)
    ).rejects.toMatchObject({ status: 404 });
  });

  it("is refused for a user who may not register repos (403)", async () => {
    mocks.getProjectAccess.mockResolvedValue({ roles: { p1: "qa" } });
    await expect(
      addComponentsToApp("hris", REGISTER.components)
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.insertComponents).not.toHaveBeenCalled();
  });
});

describe("ensureComponentBranch", () => {
  it("adds a branch and recommits to every built branch", async () => {
    mocks.getComponent
      .mockResolvedValueOnce({ ...COMPONENT, app: {} })
      .mockResolvedValueOnce({
        ...COMPONENT,
        buildSpec: { ...SPEC, branches: ["main", "feature-x"] },
        app: {},
      });
    await expect(
      ensureComponentBranch("hris", "feature-x", "p1")
    ).resolves.toEqual({
      added: true,
    });
    expect(mocks.appendBuildSpecBranch).toHaveBeenCalledWith(
      "hris",
      "feature-x"
    );
    expect(mocks.commitFile.mock.calls.map((c) => c[2])).toEqual([
      "main",
      "feature-x",
    ]);
  });

  it("is idempotent for a listed branch", async () => {
    await expect(ensureComponentBranch("hris", "main", "p1")).resolves.toEqual({
      added: false,
    });
    expect(mocks.appendBuildSpecBranch).not.toHaveBeenCalled();
    expect(mocks.commitFile).not.toHaveBeenCalled();
  });

  it("does nothing for a custom component", async () => {
    mocks.getComponent.mockResolvedValue({
      ...COMPONENT,
      pipelineMode: "custom",
      buildSpec: null,
      app: {},
    });
    await expect(ensureComponentBranch("hris", "x", "p1")).resolves.toEqual({
      added: false,
    });
    expect(mocks.commitFile).not.toHaveBeenCalled();
  });

  it("is refused without environment:create on the project (403)", async () => {
    mocks.requireProjectPermission.mockRejectedValue(
      new HTTPException(403, { message: "Forbidden" })
    );
    await expect(
      ensureComponentBranch("hris", "x", "other-project")
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
      { projectId: "other-project" },
      { environment: ["create"] }
    );
    expect(mocks.appendBuildSpecBranch).not.toHaveBeenCalled();
  });

  it("rejects an invalid branch (400) and stores nothing", async () => {
    await expect(
      ensureComponentBranch("hris", "bad branch*", "p1")
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.appendBuildSpecBranch).not.toHaveBeenCalled();
    expect(mocks.commitFile).not.toHaveBeenCalled();
  });

  it("recommits a listed branch whose last commit failed", async () => {
    mocks.getComponent.mockResolvedValue({
      ...COMPONENT,
      pipelineFileCommits: { main: { error: "Branch main does not exist" } },
      app: {},
    });
    await expect(ensureComponentBranch("hris", "main", "p1")).resolves.toEqual({
      added: false,
    });
    expect(mocks.appendBuildSpecBranch).not.toHaveBeenCalled();
    expect(mocks.commitFile.mock.calls.map((c) => c[2])).toEqual(["main"]);
  });

  it("does not commit when a concurrent call already added the branch", async () => {
    mocks.appendBuildSpecBranch.mockResolvedValue(false);
    await expect(
      ensureComponentBranch("hris", "feature-x", "p1")
    ).resolves.toEqual({ added: false });
    expect(mocks.commitFile).not.toHaveBeenCalled();
  });
});

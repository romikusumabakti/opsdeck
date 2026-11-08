import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getProjectAccess: vi.fn(),
  getComponent: vi.fn(),
  setBuildSpec: vi.fn(),
  setPipelineFileCommit: vi.fn(),
  branchExists: vi.fn(),
  commitFile: vi.fn(),
  readRepoFile: vi.fn(),
  getForgeCredentials: vi.fn(),
  activateRepo: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/authz", () => ({
  getProjectAccess: mocks.getProjectAccess,
  requireOrgPermission: vi.fn(),
}));
vi.mock("@/lib/apps", () => ({
  appKeyExists: async () => false,
  componentTargetBranches: vi.fn(),
  getApp: async () => ({ components: [] }),
  getComponent: mocks.getComponent,
  insertAppWithComponents: async () => undefined,
  linkedCiRepos: async () => [],
  listApps: vi.fn(),
  projectIdsWithAppEnvironment: vi.fn(),
  setBuildSpec: mocks.setBuildSpec,
  setNotifySecret: vi.fn(),
  setPipelineFileCommit: mocks.setPipelineFileCommit,
  takenComponentKeys: async () => [],
}));
vi.mock("@/lib/ci/forges/bitbucket", () => ({
  branchExists: mocks.branchExists,
  commitFile: mocks.commitFile,
  readRepoFile: mocks.readRepoFile,
}));
vi.mock("@/server/services/ci-connections", () => ({
  getForgeCredentials: mocks.getForgeCredentials,
  getProviderForConnection: async () => ({
    activateRepo: mocks.activateRepo,
    updateRepoSettings: async () => undefined,
    upsertRepoSecret: async () => undefined,
  }),
  listConnectionOptions: vi.fn(),
}));
vi.mock("@/lib/secrets", () => ({ encryptSecret: (s: string) => s }));

import { buildSpecSchema } from "@/lib/ci/build-spec";
import { generateWoodpeckerPipeline } from "@/lib/ci/pipeline";
import { ensureComponentBranch, registerApp } from "@/server/services/apps";

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
  mocks.activateRepo.mockResolvedValue({
    ciRepoId: "7",
    fullName: "dss/hris",
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

  it("refuses to overwrite a non-Panel pipeline file", async () => {
    mocks.readRepoFile.mockResolvedValue("steps:\n  build:\n    image: x\n");
    await registerApp(REGISTER);
    expect(mocks.commitFile).not.toHaveBeenCalled();
    expect(mocks.setPipelineFileCommit).toHaveBeenCalledWith("hris", "main", {
      error: "pipelineFileExists",
    });
  });

  it("overwrites a Panel-generated pipeline file", async () => {
    mocks.readRepoFile.mockResolvedValue(GENERATED);
    await registerApp(REGISTER);
    expect(mocks.commitFile).toHaveBeenCalledTimes(1);
  });
});

describe("ensureComponentBranch", () => {
  it("adds a branch and recommits to every built branch", async () => {
    await expect(ensureComponentBranch("hris", "feature-x")).resolves.toEqual({
      added: true,
    });
    expect(mocks.setBuildSpec).toHaveBeenCalledWith("hris", {
      ...SPEC,
      branches: ["main", "feature-x"],
    });
    expect(mocks.commitFile.mock.calls.map((c) => c[2])).toEqual([
      "main",
      "feature-x",
    ]);
  });

  it("is idempotent for a listed branch", async () => {
    await expect(ensureComponentBranch("hris", "main")).resolves.toEqual({
      added: false,
    });
    expect(mocks.setBuildSpec).not.toHaveBeenCalled();
    expect(mocks.commitFile).not.toHaveBeenCalled();
  });

  it("does nothing for a custom component", async () => {
    mocks.getComponent.mockResolvedValue({
      ...COMPONENT,
      pipelineMode: "custom",
      buildSpec: null,
      app: {},
    });
    await expect(ensureComponentBranch("hris", "x")).resolves.toEqual({
      added: false,
    });
    expect(mocks.commitFile).not.toHaveBeenCalled();
  });

  it("is refused for a user who may not register apps", async () => {
    mocks.getProjectAccess.mockResolvedValue({ roles: { p1: "viewer" } });
    await expect(ensureComponentBranch("hris", "x")).rejects.toMatchObject({
      status: 403,
    });
  });
});

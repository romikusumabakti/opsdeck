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
  takenComponentKeys: vi.fn(),
  linkedCiRepos: vi.fn(),
  insertServices: vi.fn(),
  getService: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  getProjectAccess: mocks.getProjectAccess,
  requireOrgPermission: vi.fn(),
  requireProjectPermission: mocks.requireProjectPermission,
}));
vi.mock("@/lib/apps", () => ({
  componentTargetBranches: vi.fn(),
  getComponent: mocks.getComponent,
  linkedCiRepos: mocks.linkedCiRepos,
  listApps: vi.fn(),
  appendBuildSpecBranch: mocks.appendBuildSpecBranch,
  setNotifySecret: vi.fn(),
  setPipelineFileCommit: mocks.setPipelineFileCommit,
  takenComponentKeys: mocks.takenComponentKeys,
}));
vi.mock("@/lib/service-catalog", () => ({
  getService: mocks.getService,
  insertServices: mocks.insertServices,
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
  ensureComponentBranch,
  registerServices,
  registerSetupServices,
} from "@/server/services/apps";

const CONN = "0197f3a0-1b2c-7def-8000-0123456789c1";
const SPEC = buildSpecSchema.parse({
  branches: ["main"],
  images: [{ name: "hris-backend", dockerfile: "Dockerfile", context: "." }],
  bundleFiles: [{ from: "compose.yaml", to: "compose.yaml" }],
});
const GENERATED = generateWoodpeckerPipeline("hris", SPEC, {
  registry: "registry.example.com",
  menaraUrl: "https://app.example.com",
});

const COMPONENT = {
  componentKey: "hris",
  ciConnectionId: CONN,
  repoFullName: "acme/hris",
  pipelineMode: "generated",
  buildSpec: SPEC,
};

beforeEach(() => {
  vi.stubEnv("DEPLOY_REGISTRY", "registry.example.com");
  vi.stubEnv("BETTER_AUTH_URL", "https://app.example.com");
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({
    user: { role: "engineer" },
    session: { signInMethod: "passkey" },
  });
  mocks.getProjectAccess.mockResolvedValue({ roles: { p1: "engineer" } });
  mocks.getForgeCredentials.mockResolvedValue({
    forge: "bitbucket",
    auth: { username: "u", token: "t" },
  });
  mocks.branchExists.mockResolvedValue(true);
  mocks.commitFile.mockResolvedValue({ sha: "abc" });
  mocks.readRepoFile.mockResolvedValue(null);
  mocks.getComponent.mockResolvedValue({ ...COMPONENT });
  mocks.requireProjectPermission.mockResolvedValue({});
  mocks.appendBuildSpecBranch.mockResolvedValue(true);
  mocks.listRepos.mockResolvedValue([
    {
      ciRepoId: "7",
      fullName: "acme/hris",
      forgeRemoteId: "{a}",
      active: true,
    },
  ]);
  mocks.activateRepo.mockResolvedValue({
    ciRepoId: "7",
    fullName: "acme/hris",
  });
  mocks.takenComponentKeys.mockResolvedValue([]);
  mocks.linkedCiRepos.mockResolvedValue([]);
  mocks.insertServices.mockResolvedValue(undefined);
  mocks.getService.mockImplementation(async (key: string) => ({ key }));
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

const INPUT = REGISTER.components[0] as (typeof REGISTER.components)[number];
const CUSTOM = {
  ...REGISTER,
  components: [
    {
      ...INPUT,
      pipelineMode: "custom" as const,
      buildSpec: undefined,
    },
  ],
};
const BRANCHES = { hris: ["main"] };
const SERVICES = { services: REGISTER.components };
const CUSTOM_SERVICES = { services: CUSTOM.components };
const asAdmin = () =>
  mocks.requireSession.mockResolvedValue({
    user: { role: "admin" },
    session: { signInMethod: "passkey" },
  });

describe("registerServices chooses generated for admins only", () => {
  it("refuses an engineer a generated service (403 pipelineForbidden)", async () => {
    await expect(registerServices(SERVICES)).rejects.toMatchObject({
      status: 403,
      code: "pipelineForbidden",
    });
    expect(mocks.activateRepo).not.toHaveBeenCalled();
    expect(mocks.commitFile).not.toHaveBeenCalled();
  });

  it("lets an engineer register a custom service, without an app", async () => {
    await expect(registerServices(CUSTOM_SERVICES)).resolves.toMatchObject({
      services: [{ key: "hris" }],
      pipelineFileFailures: [],
    });
    expect(mocks.insertServices).toHaveBeenCalledWith([
      expect.objectContaining({ componentKey: "hris", ciRepoId: "7" }),
    ]);
    expect(mocks.commitFile).not.toHaveBeenCalled();
  });

  it("lets an admin register a generated service", async () => {
    asAdmin();
    await expect(registerServices(SERVICES)).resolves.toBeDefined();
    expect(mocks.commitFile).toHaveBeenCalledTimes(1);
    // No environment: the commit builds as before.
    expect(mocks.commitFile.mock.calls[0]?.[5]).not.toContain("[CI SKIP]");
  });
});

describe("registerSetupServices (New environment, server-derived spec)", () => {
  it("lets an engineer register a generated service, without an app", async () => {
    await expect(
      registerSetupServices(REGISTER.components, BRANCHES)
    ).resolves.toEqual([]);
    expect(mocks.insertServices).toHaveBeenCalledWith([
      expect.objectContaining({ componentKey: "hris", ciRepoId: "7" }),
    ]);
    expect(mocks.commitFile).toHaveBeenCalledTimes(1);
    // The environment's branch builds: its build is the first deploy.
    expect(mocks.commitFile.mock.calls[0]?.[5]).not.toContain("[CI SKIP]");
  });

  it("skips the build of a branch the environment does not deploy", async () => {
    const twoBranches = {
      ...REGISTER,
      components: [
        {
          ...INPUT,
          buildSpec: { ...SPEC, branches: ["main", "release"] },
        },
      ],
    };
    await registerSetupServices(twoBranches.components, BRANCHES);
    const messages = Object.fromEntries(
      mocks.commitFile.mock.calls.map((c) => [c[2], c[5] as string])
    );
    expect(messages.main).not.toContain("[CI SKIP]");
    expect(messages.release?.startsWith("[CI SKIP] ")).toBe(true);
  });

  it("returns the branches the file was not committed to", async () => {
    mocks.branchExists.mockResolvedValue(false);
    await expect(
      registerSetupServices(REGISTER.components, BRANCHES)
    ).resolves.toEqual([
      {
        componentKey: "hris",
        branch: "main",
        code: null,
        error: "Branch main does not exist",
      },
    ]);
  });

  it("refuses a repository that already builds a service (409 repoLinked)", async () => {
    mocks.linkedCiRepos.mockResolvedValue([
      { componentKey: "hris-old", ciRepoId: "7", repoFullName: "acme/hris" },
    ]);
    await expect(
      registerSetupServices(REGISTER.components, BRANCHES)
    ).rejects.toMatchObject({ status: 409, code: "repoLinked" });
    expect(mocks.insertServices).not.toHaveBeenCalled();
  });

  it("is refused for a user who may not register repos (403)", async () => {
    mocks.requireSession.mockResolvedValue({
      user: { role: "qa" },
      session: { signInMethod: "passkey" },
    });
    mocks.getProjectAccess.mockResolvedValue({ roles: { p1: "qa" } });
    await expect(
      registerSetupServices(REGISTER.components, BRANCHES)
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("generated registration checks", () => {
  beforeEach(asAdmin);

  it("refuses up front (409) when a branch holds a non-Menara pipeline file", async () => {
    mocks.readRepoFile.mockResolvedValue("steps:\n  build:\n    image: x\n");
    await expect(registerServices(SERVICES)).rejects.toMatchObject({
      status: 409,
      code: "pipelineFileExists",
    });
    expect(mocks.activateRepo).not.toHaveBeenCalled();
    expect(mocks.commitFile).not.toHaveBeenCalled();
  });

  it("refuses a Menara file generated for another component", async () => {
    mocks.readRepoFile.mockResolvedValue(
      generateWoodpeckerPipeline("other", SPEC, {
        registry: "registry.example.com",
        menaraUrl: "https://app.example.com",
      })
    );
    await expect(registerServices(SERVICES)).rejects.toMatchObject({
      code: "pipelineFileExists",
    });
    expect(mocks.activateRepo).not.toHaveBeenCalled();
  });

  it("fails closed on a pipeline file too large to read", async () => {
    mocks.readRepoFile.mockResolvedValue(TOO_LARGE);
    await expect(registerServices(SERVICES)).rejects.toMatchObject({
      code: "pipelineFileExists",
    });
    expect(mocks.activateRepo).not.toHaveBeenCalled();
  });

  it("overwrites a Menara-generated pipeline file", async () => {
    mocks.readRepoFile.mockResolvedValue(GENERATED);
    await registerServices(SERVICES);
    expect(mocks.commitFile).toHaveBeenCalledTimes(1);
  });

  it("overwrites a pipeline file carrying an older release's marker", async () => {
    // Older releases wrote "Generated by <Name> Panel for <key>"; those files
    // are still the generator's, not hand-written.
    const legacy = GENERATED.replace(
      "Generated by Menara for hris",
      "Generated by Example Panel for hris"
    );
    expect(legacy).not.toBe(GENERATED);
    mocks.readRepoFile.mockResolvedValue(legacy);
    await registerServices(SERVICES);
    expect(mocks.commitFile).toHaveBeenCalledTimes(1);
  });
});

describe("registration refusals carry a stable code", () => {
  beforeEach(asAdmin);
  it("componentKeyTaken", async () => {
    mocks.takenComponentKeys.mockResolvedValue(["hris"]);
    await expect(registerServices(SERVICES)).rejects.toMatchObject({
      status: 409,
      code: "componentKeyTaken",
    });
  });

  it("repoLinked (New environment; services may share a repository)", async () => {
    mocks.linkedCiRepos.mockResolvedValue([
      { componentKey: "old", ciRepoId: "7", repoFullName: "acme/hris" },
    ]);
    await expect(
      registerSetupServices(REGISTER.components, BRANCHES)
    ).rejects.toMatchObject({
      status: 409,
      code: "repoLinked",
    });
  });

  it("registrationRace", async () => {
    mocks.insertServices.mockRejectedValue(
      Object.assign(new Error("dup"), { code: "23505" })
    );
    await expect(registerServices(SERVICES)).rejects.toMatchObject({
      status: 409,
      code: "registrationRace",
    });
  });

  it("ciUnavailable", async () => {
    const { CiProviderError } = await import("@/lib/ci/types");
    mocks.activateRepo.mockRejectedValue(new CiProviderError("down", 503));
    await expect(registerServices(SERVICES)).rejects.toMatchObject({
      status: 502,
      code: "ciUnavailable",
    });
  });
});

describe("registerSetupServices refusals", () => {
  it("refuses a foreign pipeline file before inserting (409)", async () => {
    mocks.readRepoFile.mockResolvedValue("steps:\n  build:\n    image: x\n");
    await expect(
      registerSetupServices(REGISTER.components, BRANCHES)
    ).rejects.toMatchObject({ status: 409, code: "pipelineFileExists" });
    expect(mocks.activateRepo).not.toHaveBeenCalled();
    expect(mocks.insertServices).not.toHaveBeenCalled();
  });
});

describe("ensureComponentBranch", () => {
  it("adds a branch and commits once, to that branch only", async () => {
    mocks.getComponent
      .mockResolvedValueOnce({ ...COMPONENT, app: {} })
      .mockResolvedValueOnce({
        ...COMPONENT,
        buildSpec: { ...SPEC, branches: ["main", "feature-x"] },
        app: {},
      });
    await expect(
      ensureComponentBranch("hris", "feature-x", "p1")
    ).resolves.toEqual({ added: true, pipelineFileFailures: [] });
    expect(mocks.appendBuildSpecBranch).toHaveBeenCalledWith(
      "hris",
      "feature-x"
    );
    expect(mocks.commitFile.mock.calls.map((c) => c[2])).toEqual(["feature-x"]);
    // The file lists every built branch; the new branch's build is not
    // skipped (it is the first deploy).
    expect(mocks.commitFile.mock.calls[0]?.[4]).toContain("feature-x");
    expect(mocks.commitFile.mock.calls[0]?.[5]).not.toContain("[CI SKIP]");
  });

  it("returns the added branch's commit failure", async () => {
    mocks.readRepoFile.mockResolvedValue("steps:\n  build:\n    image: x\n");
    await expect(
      ensureComponentBranch("hris", "feature-x", "p1")
    ).resolves.toEqual({
      added: true,
      pipelineFileFailures: [
        {
          componentKey: "hris",
          branch: "feature-x",
          code: "pipelineFileExists",
          error: "pipelineFileExists",
        },
      ],
    });
    expect(mocks.commitFile).not.toHaveBeenCalled();
  });

  it("is idempotent for a listed branch", async () => {
    await expect(
      ensureComponentBranch("hris", "main", "p1")
    ).resolves.toMatchObject({
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
    await expect(
      ensureComponentBranch("hris", "x", "p1")
    ).resolves.toMatchObject({
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
    await expect(
      ensureComponentBranch("hris", "main", "p1")
    ).resolves.toMatchObject({
      added: false,
    });
    expect(mocks.appendBuildSpecBranch).not.toHaveBeenCalled();
    expect(mocks.commitFile.mock.calls.map((c) => c[2])).toEqual(["main"]);
  });

  it("does not commit when a concurrent call already added the branch", async () => {
    mocks.appendBuildSpecBranch.mockResolvedValue(false);
    await expect(
      ensureComponentBranch("hris", "feature-x", "p1")
    ).resolves.toMatchObject({ added: false });
    expect(mocks.commitFile).not.toHaveBeenCalled();
  });
});

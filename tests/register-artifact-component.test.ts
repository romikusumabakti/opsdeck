import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  takenComponentKeys: vi.fn(),
  linkedCiRepos: vi.fn(),
  insertComponentCreatingApp: vi.fn(),
  getComponent: vi.fn(),
  getApp: vi.fn(),
  appendBuildSpecBranch: vi.fn(),
  setNotifySecret: vi.fn(),
  listConnectionOptions: vi.fn(),
  listRepos: vi.fn(),
  activateRepo: vi.fn(),
  updateRepoSettings: vi.fn(),
  upsertRepoSecret: vi.fn(),
  commitFile: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({ user: { role: "admin" } })),
}));
vi.mock("@/lib/authz", () => ({
  getProjectAccess: vi.fn(async () => ({ roles: {} })),
  requireOrgPermission: vi.fn(),
  requireProjectPermission: vi.fn(),
}));
vi.mock("@/lib/apps", () => ({
  appKeyExists: vi.fn(),
  appendBuildSpecBranch: mocks.appendBuildSpecBranch,
  componentTargetBranches: vi.fn(),
  getApp: mocks.getApp,
  getComponent: mocks.getComponent,
  insertAppWithComponents: vi.fn(),
  insertComponentCreatingApp: mocks.insertComponentCreatingApp,
  insertComponents: vi.fn(),
  latestComponentPipelineUrl: vi.fn(),
  linkedCiRepos: mocks.linkedCiRepos,
  listApps: vi.fn(),
  projectIdsWithAppEnvironment: vi.fn(),
  setNotifySecret: mocks.setNotifySecret,
  setPipelineFileCommit: vi.fn(),
  takenComponentKeys: mocks.takenComponentKeys,
}));
vi.mock("@/lib/ci/forges/bitbucket", () => ({
  branchExists: async () => true,
  commitFile: mocks.commitFile,
  readRepoFileOrLarge: async () => null,
  FILE_TOO_LARGE: Symbol("too-large"),
}));
vi.mock("@/server/services/ci-connections", () => ({
  getForgeCredentials: async () => ({
    forge: "bitbucket",
    auth: { username: "u", token: "t" },
  }),
  getProviderForConnection: async () => ({
    listRepos: mocks.listRepos,
    activateRepo: mocks.activateRepo,
    updateRepoSettings: mocks.updateRepoSettings,
    upsertRepoSecret: mocks.upsertRepoSecret,
  }),
  listConnectionOptions: mocks.listConnectionOptions,
}));
vi.mock("@/lib/secrets", () => ({ encryptSecret: (s: string) => `enc:${s}` }));

import { type BuildSpec, buildSpecSchema } from "@/lib/ci/build-spec";
import {
  ArtifactRegistrationError,
  notifySecretNameFor,
  registerArtifactComponent,
  setComponentSecret,
} from "@/lib/ci/register-artifact-component";
import { repoRepresentative } from "@/lib/ci/registration";
import { CiProviderError } from "@/lib/ci/types";
import {
  ensureComponentBranch,
  retryPipelineFileCommit,
  rotateNotifySecret,
} from "@/server/services/apps";

const CONN = "0197f3a0-1b2c-7def-8000-0123456789c1";
const REPO = "dss-consulting/dplk-customer-portal";
const KEY = "legacy-portal-frontend";
const SUFFIXED = "opsdeck_notify_legacy_portal_frontend";

const SPEC: BuildSpec = buildSpecSchema.parse({
  branches: [],
  artifact: { kind: "static", path: "dist" },
  checks: [
    {
      name: "vite-build",
      image: "docker.io/oven/bun:1",
      dir: ".",
      commands: ["bun install --frozen-lockfile", "bun run build"],
    },
  ],
  timeoutMinutes: 45,
});

const INPUT = {
  componentKey: KEY,
  appKey: "customer-portal",
  repoFullName: REPO,
  spec: SPEC,
};

const OTHER = {
  componentKey: "dplk-customer-portal-frontend",
  ciRepoId: "7",
  repoFullName: REPO,
};

beforeEach(() => {
  vi.stubEnv("DEPLOY_REGISTRY", "registry.example.com");
  vi.clearAllMocks();
  mocks.takenComponentKeys.mockResolvedValue([]);
  mocks.linkedCiRepos.mockResolvedValue([]);
  mocks.insertComponentCreatingApp.mockResolvedValue(undefined);
  mocks.listConnectionOptions.mockResolvedValue([
    { id: CONN, name: "woodpecker", forge: "bitbucket", hasForgeToken: true },
  ]);
  mocks.listRepos.mockResolvedValue([
    { ciRepoId: "7", fullName: REPO, forgeRemoteId: "{p}", active: true },
  ]);
  mocks.activateRepo.mockResolvedValue({
    ciRepoId: "7",
    fullName: REPO,
    forgeRemoteId: "{p}",
    active: true,
  });
  mocks.updateRepoSettings.mockResolvedValue(undefined);
  mocks.upsertRepoSecret.mockResolvedValue(undefined);
  mocks.commitFile.mockResolvedValue({ sha: "abc" });
  mocks.appendBuildSpecBranch.mockResolvedValue(true);
  mocks.setNotifySecret.mockResolvedValue(undefined);
});

describe("notifySecretNameFor", () => {
  it("keeps the shared name for a repository's only component", () => {
    expect(notifySecretNameFor(KEY, false)).toBe("opsdeck_notify");
  });

  it("names the secret after the component when the repo has another", () => {
    expect(notifySecretNameFor(KEY, true)).toBe(SUFFIXED);
  });
});

describe("repoRepresentative", () => {
  const artifact = { componentKey: "a", buildSpec: SPEC };
  const container = { componentKey: "b", buildSpec: null };

  it("prefers a non-artifact component, whatever the order", () => {
    expect(repoRepresentative([artifact, container])).toBe(container);
    expect(repoRepresentative([container, artifact])).toBe(container);
  });

  it("falls back to the first match", () => {
    expect(repoRepresentative([artifact])).toBe(artifact);
    expect(repoRepresentative([])).toBeUndefined();
  });
});

describe("registerArtifactComponent", () => {
  it("keeps opsdeck_notify for the first component of a repository", async () => {
    const result = await registerArtifactComponent(INPUT);
    expect(result).toEqual({
      componentKey: KEY,
      ciRepoId: "7",
      notifySecretName: "opsdeck_notify",
    });
    expect(mocks.upsertRepoSecret).toHaveBeenCalledWith(
      "7",
      "opsdeck_notify",
      expect.stringMatching(/^[0-9a-f]{64}$/),
      ["push", "manual"]
    );
    expect(mocks.insertComponentCreatingApp).toHaveBeenCalledWith(
      "customer-portal",
      expect.objectContaining({ notifySecretName: "opsdeck_notify" })
    );
  });

  it("stores a second component on the same Woodpecker repo under its own secret name", async () => {
    mocks.linkedCiRepos.mockResolvedValue([OTHER]);
    const result = await registerArtifactComponent(INPUT);
    expect(result).toEqual({
      componentKey: KEY,
      ciRepoId: "7",
      notifySecretName: SUFFIXED,
    });
    const [name, value] = mocks.upsertRepoSecret.mock.calls[0]?.slice(1) ?? [];
    expect(mocks.upsertRepoSecret).toHaveBeenCalledWith("7", SUFFIXED, value, [
      "push",
      "manual",
    ]);
    expect(name).toBe(SUFFIXED);
    expect(mocks.insertComponentCreatingApp).toHaveBeenCalledWith(
      "customer-portal",
      {
        componentKey: KEY,
        ciConnectionId: CONN,
        repoFullName: REPO,
        ciRepoId: "7",
        bundleImage: "legacy-portal-frontend-deploy",
        notifySecret: `enc:${value}`,
        notifySecretName: SUFFIXED,
        pipelineMode: "generated",
        buildSpec: SPEC,
      }
    );
  });

  it("leaves the repo settings of a repository that builds another component alone", async () => {
    mocks.linkedCiRepos.mockResolvedValue([OTHER]);
    await registerArtifactComponent(INPUT);
    expect(mocks.updateRepoSettings).not.toHaveBeenCalled();
    expect(mocks.upsertRepoSecret).toHaveBeenCalledTimes(1);
  });

  it("matches the other component by repository name when it has no ci repo id", async () => {
    mocks.linkedCiRepos.mockResolvedValue([{ ...OTHER, ciRepoId: null }]);
    expect((await registerArtifactComponent(INPUT)).notifySecretName).toBe(
      SUFFIXED
    );
  });

  it("activates the listed repo, applies the timeout and commits no pipeline file", async () => {
    await registerArtifactComponent(INPUT);
    expect(mocks.activateRepo).toHaveBeenCalledWith("{p}");
    expect(mocks.updateRepoSettings).toHaveBeenCalledWith("7", {
      timeoutMinutes: 45,
      cancelPreviousOnPush: true,
      configExtensionEndpoint: null,
    });
    expect(mocks.commitFile).not.toHaveBeenCalled();
  });

  it("picks the named CI connection and refuses an unknown one", async () => {
    mocks.listConnectionOptions.mockResolvedValue([
      { id: CONN, name: "woodpecker" },
      { id: "other", name: "legacy" },
    ]);
    await expect(registerArtifactComponent(INPUT)).rejects.toThrow(
      "Pass a CI connection name. Connections: woodpecker, legacy"
    );
    await expect(
      registerArtifactComponent({ ...INPUT, ciConnectionName: "nope" })
    ).rejects.toThrow('Unknown CI connection "nope"');
    await registerArtifactComponent({
      ...INPUT,
      ciConnectionName: "woodpecker",
    });
    expect(mocks.insertComponentCreatingApp).toHaveBeenCalledWith(
      "customer-portal",
      expect.objectContaining({ ciConnectionId: CONN })
    );
  });

  it.each([
    [
      "a spec without an artifact",
      {
        ...INPUT,
        spec: buildSpecSchema.parse({
          branches: ["main"],
          images: [{ name: "web", dockerfile: "Dockerfile", context: "." }],
          bundleFiles: [{ from: "compose.yaml", to: "compose.yaml" }],
        }),
      },
      "The build spec has no artifact",
    ],
    [
      "a spec that already lists a branch",
      { ...INPUT, spec: { ...SPEC, branches: ["main"] } },
      "must list no branches",
    ],
    [
      "an invalid spec",
      { ...INPUT, spec: { ...SPEC, checks: [] } },
      "Invalid build spec at checks",
    ],
    [
      "a bad repository name",
      { ...INPUT, repoFullName: "no-owner" },
      "Repo must be <owner>/<name>",
    ],
  ])(
    "refuses %s before touching Woodpecker",
    async (_label, input, message) => {
      await expect(registerArtifactComponent(input)).rejects.toThrow(message);
      expect(mocks.activateRepo).not.toHaveBeenCalled();
      expect(mocks.upsertRepoSecret).not.toHaveBeenCalled();
    }
  );

  it("refuses a taken component key before touching Woodpecker", async () => {
    mocks.takenComponentKeys.mockResolvedValue([KEY]);
    await expect(registerArtifactComponent(INPUT)).rejects.toThrow(
      `Component ${KEY} already exists`
    );
    expect(mocks.activateRepo).not.toHaveBeenCalled();
  });

  it("refuses a repository Woodpecker does not list", async () => {
    mocks.listRepos.mockResolvedValue([]);
    await expect(registerArtifactComponent(INPUT)).rejects.toThrow(
      `Woodpecker does not list the repository ${REPO}`
    );
    expect(mocks.insertComponentCreatingApp).not.toHaveBeenCalled();
  });

  it("names the failed Woodpecker step and stores nothing", async () => {
    mocks.upsertRepoSecret.mockRejectedValue(new CiProviderError("down", 503));
    const error = await registerArtifactComponent(INPUT).catch((e) => e);
    expect(error).toBeInstanceOf(ArtifactRegistrationError);
    expect(error.message).toBe(
      "Storing the Woodpecker secret opsdeck_notify failed: down"
    );
    expect(mocks.insertComponentCreatingApp).not.toHaveBeenCalled();
  });

  it("reports a registration race without the database error", async () => {
    mocks.insertComponentCreatingApp.mockRejectedValue(
      Object.assign(new Error("dup enc:secret"), { code: "23505" })
    );
    const error = await registerArtifactComponent(INPUT).catch((e) => e);
    expect(error).toBeInstanceOf(ArtifactRegistrationError);
    expect(error.message).toContain("registered meanwhile");
    expect(error.message).not.toContain("enc:");
  });
});

describe("a stored component's notify secret name", () => {
  const stored = {
    componentKey: KEY,
    ciConnectionId: CONN,
    repoFullName: REPO,
    ciRepoId: "7",
    pipelineMode: "generated",
    buildSpec: SPEC,
    notifySecretName: SUFFIXED,
    pipelineFileCommits: null,
    app: { appKey: "customer-portal" },
  };

  beforeEach(() => {
    mocks.getComponent.mockResolvedValue(stored);
    mocks.getApp.mockResolvedValue({ components: [stored] });
  });

  it("is the secret the pipeline committed on branch pick reads", async () => {
    mocks.getComponent.mockResolvedValueOnce(stored).mockResolvedValueOnce({
      ...stored,
      buildSpec: { ...SPEC, branches: ["tmli/production"] },
    });
    const result = await ensureComponentBranch(KEY, "tmli/production", "p1");
    expect(result).toEqual({ added: true, pipelineFileFailures: [] });
    const yaml = mocks.commitFile.mock.calls[0]?.[4] as string;
    expect(yaml).toContain(`from_secret: ${SUFFIXED}`);
    expect(yaml).not.toMatch(/from_secret: opsdeck_notify$/m);
  });

  it("is the secret a retried pipeline commit reads", async () => {
    mocks.getComponent.mockResolvedValue({
      ...stored,
      buildSpec: { ...SPEC, branches: ["tmli/production"] },
    });
    await retryPipelineFileCommit("customer-portal", KEY);
    expect(mocks.commitFile.mock.calls[0]?.[4]).toContain(
      `from_secret: ${SUFFIXED}`
    );
  });

  it("is the Woodpecker secret a rotation writes", async () => {
    await rotateNotifySecret("customer-portal", KEY);
    expect(mocks.upsertRepoSecret).toHaveBeenCalledWith(
      "7",
      SUFFIXED,
      expect.any(String),
      ["push", "manual"]
    );
  });
});

describe("setComponentSecret", () => {
  beforeEach(() => {
    mocks.upsertRepoSecret.mockReset();
    mocks.getComponent.mockReset();
  });

  const component = {
    componentKey: "legacy-portal-frontend",
    ciConnectionId: "conn-1",
    ciRepoId: "4",
  };

  it("stores the secret on the component's repository for push and manual", async () => {
    mocks.getComponent.mockResolvedValue(component);
    await setComponentSecret(
      "legacy-portal-frontend",
      "legacy_portal_static_token",
      "s3cret"
    );
    expect(mocks.upsertRepoSecret).toHaveBeenCalledWith(
      "4",
      "legacy_portal_static_token",
      "s3cret",
      ["push", "manual"]
    );
  });

  it.each([
    ["the notify secret", "opsdeck_notify", "x"],
    ["a suffixed notify secret", "opsdeck_notify_core", "x"],
    ["an invalid name", "Bad-Name", "x"],
    ["an empty value", "legacy_token", ""],
  ])("refuses %s", async (_label, name, value) => {
    mocks.getComponent.mockResolvedValue(component);
    await expect(
      setComponentSecret("legacy-portal-frontend", name, value)
    ).rejects.toThrow(ArtifactRegistrationError);
    expect(mocks.upsertRepoSecret).not.toHaveBeenCalled();
  });

  it("refuses an unknown component or one without a CI repository", async () => {
    mocks.getComponent.mockResolvedValue(undefined);
    await expect(
      setComponentSecret("nope", "legacy_token", "x")
    ).rejects.toThrow(ArtifactRegistrationError);
    mocks.getComponent.mockResolvedValue({ ...component, ciRepoId: null });
    await expect(
      setComponentSecret("legacy-portal-frontend", "legacy_token", "x")
    ).rejects.toThrow(ArtifactRegistrationError);
    expect(mocks.upsertRepoSecret).not.toHaveBeenCalled();
  });

  it("never puts the value in an error message", async () => {
    mocks.getComponent.mockResolvedValue(component);
    mocks.upsertRepoSecret.mockRejectedValue(new Error("boom s3cret"));
    const error = await setComponentSecret(
      "legacy-portal-frontend",
      "legacy_token",
      "s3cret"
    ).catch((e: Error) => e);
    expect(String((error as Error).message)).not.toContain("s3cret");
  });
});

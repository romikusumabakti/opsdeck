import { beforeEach, describe, expect, it, vi } from "vitest";

// "Project branches": every component of every app in the project's Sources,
// at the project's branch for it, else the build spec's fallback branch. The
// CI connection comes from app_components; without one the component is still
// listed, and the snapshot step marks it unavailable as for environments.

const sources = vi.hoisted(() => ({
  loadProjectSources: vi.fn(),
  connections: [] as { componentKey: string; ciConnectionId: string | null }[],
  where: vi.fn(),
}));

vi.mock("@/lib/project-sources", () => ({
  loadProjectSources: sources.loadProjectSources,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async (condition: unknown) => {
          sources.where(condition);
          return sources.connections;
        },
      }),
    }),
  },
}));

const { resolveProjectSources } = await import(
  "@/lib/assistant/project-sources"
);

const component = (
  componentKey: string,
  defaultBranch: string | null,
  fallbackBranch: string
) => ({
  componentKey,
  repoFullName: `acme/${componentKey}`,
  defaultBranch,
  fallbackBranch,
  environments: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  sources.connections = [];
});

describe("resolveProjectSources", () => {
  it("reads each component at its project branch, else its fallback, never as deployed", async () => {
    sources.loadProjectSources.mockResolvedValue([
      {
        appId: "app-1",
        appKey: "membership",
        name: "Membership",
        inUse: true,
        components: [
          component("api", "acme/development", "main"),
          component("web", null, "develop"),
        ],
      },
      {
        appId: "app-2",
        appKey: "portal",
        name: "Portal",
        // Linked in Sources but not used by any environment: still listed.
        inUse: false,
        components: [component("portal", null, "main")],
      },
    ]);
    sources.connections = [
      { componentKey: "api", ciConnectionId: "ci-1" },
      { componentKey: "web", ciConnectionId: "ci-1" },
      { componentKey: "portal", ciConnectionId: null },
    ];

    expect(await resolveProjectSources("project-1")).toEqual([
      {
        componentKey: "api",
        repoFullName: "acme/api",
        ciConnectionId: "ci-1",
        commitSha: null,
        ref: "acme/development",
        deployed: false,
        deployedAt: null,
      },
      {
        componentKey: "web",
        repoFullName: "acme/web",
        ciConnectionId: "ci-1",
        commitSha: null,
        ref: "develop",
        deployed: false,
        deployedAt: null,
      },
      {
        componentKey: "portal",
        repoFullName: "acme/portal",
        // No CI connection: ensureSnapshot reports it unavailable.
        ciConnectionId: null,
        commitSha: null,
        ref: "main",
        deployed: false,
        deployedAt: null,
      },
    ]);
    expect(sources.loadProjectSources).toHaveBeenCalledWith("project-1");
  });

  it("is empty for a project without sources, without a connection lookup", async () => {
    sources.loadProjectSources.mockResolvedValue([]);
    expect(await resolveProjectSources("project-1")).toEqual([]);
    expect(sources.where).not.toHaveBeenCalled();
  });

  it("lists a component whose connection row is missing as without one", async () => {
    sources.loadProjectSources.mockResolvedValue([
      {
        appId: "app-1",
        appKey: "membership",
        name: "Membership",
        inUse: true,
        components: [component("api", null, "main")],
      },
    ]);
    const [api] = await resolveProjectSources("project-1");
    expect(api?.ciConnectionId).toBeNull();
  });
});

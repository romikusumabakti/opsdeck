import { beforeEach, describe, expect, it, vi } from "vitest";

// The project sources service on project services: the settled gates
// (environment:create to add or remove a service, environment:update to set a
// default branch and to read), the 409 refusals (Review Focus 4: a service a
// deploy target uses cannot be removed), and which explicit actions reach the
// activity feed.

const P = "0197f3a0-1b2c-7def-8000-0123456789f1";
const S = "core-web";

const state = vi.hoisted(() => ({
  role: "engineer" as "engineer" | "qa",
  perms: [] as unknown[],
  // Project name lookups, in call order.
  nameRows: [] as unknown[][],
}));

vi.mock("@/lib/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authz")>();
  return {
    ...actual,
    requireProjectPermission: async (_scope: unknown, perms: unknown) => {
      state.perms.push(perms);
      if (state.role === "qa") throw new actual.ForbiddenError();
      return { session: { user: { id: "actor" } } };
    },
  };
});

const sources = vi.hoisted(() => ({
  loadProjectSources: vi.fn(),
  insertProjectService: vi.fn(),
  deleteProjectService: vi.fn(),
  getComponentBranch: vi.fn(),
  upsertComponentBranch: vi.fn(),
}));
vi.mock("@/lib/project-sources", () => sources);

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

const catalog = vi.hoisted(() => ({
  getService: vi.fn(),
  isProjectService: vi.fn(),
}));
vi.mock("@/lib/service-catalog", () => catalog);

vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

vi.mock("@/lib/db", () => {
  // A select ends in .limit(): the project name lookup.
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => state.nameRows.shift() ?? [],
  };
  return { db: { select: () => chain } };
});

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: "actor" } })),
}));

const { errorCode } = await import("@/server/errors");
const {
  addProjectSource,
  listProjectSources,
  removeProjectSource,
  setComponentBranch,
} = await import("@/server/services/project-sources");
const { app } = await import("@/server/app");

const BRANCH_INPUT = {
  projectId: P,
  componentKey: "core-web",
  branch: "kestrel/development",
};

beforeEach(() => {
  state.role = "engineer";
  state.perms = [];
  state.nameRows = [[{ name: "Kestrel" }]];
  for (const fn of Object.values(sources)) fn.mockReset();
  activity.recordActivity.mockReset();
  for (const fn of Object.values(catalog)) fn.mockReset();
  catalog.getService.mockResolvedValue({ key: S });
  catalog.isProjectService.mockResolvedValue(true);
  sources.loadProjectSources.mockResolvedValue([]);
});

const WRITES = [
  sources.insertProjectService,
  sources.deleteProjectService,
  sources.upsertComponentBranch,
];

describe("project sources service", () => {
  it("list, add, remove and set ask for the settled project permissions", async () => {
    sources.insertProjectService.mockResolvedValue(true);
    sources.deleteProjectService.mockResolvedValue("deleted");
    sources.getComponentBranch.mockResolvedValue(null);
    state.nameRows = [[{ name: "Kestrel" }], [{ name: "Kestrel" }]];
    await listProjectSources(P);
    await addProjectSource({ projectId: P, componentKey: S });
    await removeProjectSource({ projectId: P, componentKey: S });
    await setComponentBranch(BRANCH_INPUT);
    expect(state.perms).toEqual([
      { environment: ["update"] },
      { environment: ["create"] },
      { environment: ["create"] },
      { environment: ["update"] },
    ]);
  });

  it("a qa caller is refused before anything is read or written", async () => {
    state.role = "qa";
    const calls = [
      () => listProjectSources(P),
      () => addProjectSource({ projectId: P, componentKey: S }),
      () => removeProjectSource({ projectId: P, componentKey: S }),
      () => setComponentBranch(BRANCH_INPUT),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ status: 403 });
    }
    for (const write of WRITES) expect(write).not.toHaveBeenCalled();
    expect(sources.loadProjectSources).not.toHaveBeenCalled();
    expect(sources.getComponentBranch).not.toHaveBeenCalled();
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("adding an unknown service answers 404 and writes nothing", async () => {
    catalog.getService.mockResolvedValue(null);
    await expect(
      addProjectSource({ projectId: P, componentKey: S })
    ).rejects.toMatchObject({ status: 404 });
    expect(sources.insertProjectService).not.toHaveBeenCalled();
  });

  it("adding logs project.sourceAdded once, re-adding logs nothing", async () => {
    sources.insertProjectService.mockResolvedValueOnce(true);
    const first = await addProjectSource({ projectId: P, componentKey: S });
    expect(first).toEqual({ success: true, message: "addedSuccess" });
    expect(activity.recordActivity).toHaveBeenCalledTimes(1);
    expect(activity.recordActivity).toHaveBeenCalledWith({
      actorId: "actor",
      action: "project.sourceAdded",
      entityType: "project",
      entityId: P,
      data: { project: "Kestrel", service: S },
    });

    sources.insertProjectService.mockResolvedValueOnce(false);
    const again = await addProjectSource({ projectId: P, componentKey: S });
    expect(again.success).toBe(true);
    expect(activity.recordActivity).toHaveBeenCalledTimes(1);
  });

  it("removing a service a deploy target uses answers 409 sourceInUse and logs nothing (Review Focus 4)", async () => {
    sources.deleteProjectService.mockResolvedValue("inUse");
    const error = await removeProjectSource({
      projectId: P,
      componentKey: S,
    }).catch((e) => e);
    expect(error.status).toBe(409);
    expect(errorCode(error)).toBe("sourceInUse");
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("removing logs project.sourceRemoved with the project name and service key", async () => {
    sources.deleteProjectService.mockResolvedValue("deleted");
    const result = await removeProjectSource({ projectId: P, componentKey: S });
    expect(result).toEqual({ success: true, message: "removedSuccess" });
    expect(activity.recordActivity).toHaveBeenCalledWith({
      actorId: "actor",
      action: "project.sourceRemoved",
      entityType: "project",
      entityId: P,
      data: { project: "Kestrel", service: S },
    });
  });

  it("removing a service that was not a source succeeds and logs nothing", async () => {
    sources.deleteProjectService.mockResolvedValue("absent");
    expect(
      (await removeProjectSource({ projectId: P, componentKey: S })).success
    ).toBe(true);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("setting a branch on an unknown service answers 404", async () => {
    catalog.getService.mockResolvedValue(null);
    await expect(setComponentBranch(BRANCH_INPUT)).rejects.toMatchObject({
      status: 404,
    });
    expect(sources.upsertComponentBranch).not.toHaveBeenCalled();
  });

  it("setting a branch on a service outside the project's services answers 409 componentNotInSources", async () => {
    catalog.isProjectService.mockResolvedValue(false);
    const error = await setComponentBranch(BRANCH_INPUT).catch((e) => e);
    expect(error.status).toBe(409);
    expect(errorCode(error)).toBe("componentNotInSources");
    expect(sources.upsertComponentBranch).not.toHaveBeenCalled();
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("the first hand-set default logs from empty", async () => {
    sources.getComponentBranch.mockResolvedValue(null);
    const result = await setComponentBranch(BRANCH_INPUT);
    expect(result).toEqual({ success: true, message: "branchSaved" });
    // Membership is the project's services, whatever app the service had.
    expect(catalog.isProjectService).toHaveBeenCalledWith(P, "core-web");
    expect(sources.upsertComponentBranch).toHaveBeenCalledWith({
      ...BRANCH_INPUT,
      userId: "actor",
    });
    expect(activity.recordActivity).toHaveBeenCalledWith({
      actorId: "actor",
      action: "project.defaultBranchChanged",
      entityType: "project",
      entityId: P,
      data: {
        project: "Kestrel",
        component: "core-web",
        from: "",
        to: "kestrel/development",
      },
    });
  });

  it("saving the same branch again logs nothing", async () => {
    sources.getComponentBranch.mockResolvedValue("kestrel/development");
    expect((await setComponentBranch(BRANCH_INPUT)).success).toBe(true);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });
});

describe("set-component-branch route", () => {
  it.each(["feature..x", "-x", "a b"])(
    "rejects the branch %j with 400",
    async (branch) => {
      const res = await app.request(
        "/api/project-sources/set-component-branch",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: { ...BRANCH_INPUT, branch } }),
        }
      );
      expect(res.status).toBe(400);
      expect(sources.upsertComponentBranch).not.toHaveBeenCalled();
    }
  );
});

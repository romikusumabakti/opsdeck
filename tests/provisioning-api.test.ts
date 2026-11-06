import { beforeEach, describe, expect, it, vi } from "vitest";

// The provisioning API through the Hono app, against an in-memory repository
// whose startProvisioningRun mirrors the SQL (conflict while a run is started).

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";

const state = vi.hoisted(() => ({
  role: "maintainer" as string | null,
  activeRunId: null as string | null,
  config: null as unknown,
  seq: 0,
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: USER_ID, role: "member" },
  })),
}));

vi.mock("@/lib/authz", async () => {
  const { canProject } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    requireProjectPermission: vi.fn(
      async (_scope: unknown, perms: Parameters<typeof canProject>[1]) => {
        if (!state.role) throw new HTTPException(404, { message: "Not Found" });
        if (!canProject(state.role as "viewer", perms)) {
          throw new HTTPException(403, { message: "Forbidden" });
        }
        return {
          session: { user: { id: USER_ID, role: "member" } },
          role: state.role,
          projectId: "project-1",
        };
      }
    ),
  };
});

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

const queue = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@/lib/queue", () => queue);

vi.mock("@/lib/run-progress", () => ({ failRun: vi.fn() }));

const repo = vi.hoisted(() => ({
  loadProvisioningConfig: vi.fn(),
  listSteps: vi.fn(async () => []),
  savePlan: vi.fn(async () => {}),
  getActiveProvisionRunId: vi.fn(),
  startProvisioningRun: vi.fn(),
}));
vi.mock("@/lib/provisioning/repository", () => repo);

const { app } = await import("@/server/app");

const goodConfig = {
  name: "HRIS Staging",
  targets: [
    { id: "t1", serverId: "s1", deployDir: "/opt/hris", sourceBranch: "main" },
  ],
  db: null,
};

const post = () =>
  app.request(`/api/environments/${ENV_ID}/provisioning`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.role = "maintainer";
  state.activeRunId = null;
  state.seq = 0;
  repo.loadProvisioningConfig.mockResolvedValue(goodConfig);
  repo.getActiveProvisionRunId.mockImplementation(
    async () => state.activeRunId
  );
  repo.startProvisioningRun.mockImplementation(async () => {
    if (state.activeRunId) return { conflict: true };
    state.activeRunId = `run-${++state.seq}`;
    return { runId: state.activeRunId };
  });
});

describe("provisioning API", () => {
  it("refuses a contributor", async () => {
    state.role = "contributor";
    expect((await post()).status).toBe(403);
    const get = await app.request(`/api/environments/${ENV_ID}/provisioning`);
    expect(get.status).toBe(403);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("lets a maintainer start a run and queues the job", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: "run-1" });
    expect(repo.savePlan).toHaveBeenCalledOnce();
    expect(queue.enqueue).toHaveBeenCalledWith("provision/run.requested", {
      environmentId: ENV_ID,
      runId: "run-1",
    });
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "environment.provision",
        data: { environment: "HRIS Staging" },
      })
    );
  });

  it("still answers 200 when recording the activity fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    activity.recordActivity.mockRejectedValueOnce(new Error("db down"));
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: "run-1" });
    errors.mockRestore();
  });

  it("answers 409 to a second start while a run is active, with one job", async () => {
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(409);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("answers 422 with the plan error code", async () => {
    repo.loadProvisioningConfig.mockResolvedValue({
      ...goodConfig,
      db: {
        dbKind: "shared",
        databaseHostId: "h1",
        dbName: "hris_staging",
        dbRole: null,
        dbPasswordVariable: null,
      },
    });
    const res = await post();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "missing_db_fields" });
    expect(repo.startProvisioningRun).not.toHaveBeenCalled();
  });

  it("GET returns steps, the plan preview and the active run", async () => {
    state.activeRunId = "run-9";
    const res = await app.request(`/api/environments/${ENV_ID}/provisioning`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeRunId).toBe("run-9");
    expect(body.steps).toEqual([]);
    expect(body.plan.map((s: { kind: string }) => s.kind)).toEqual([
      "prepare_deploy_dir",
      "deploy",
    ]);
  });
});

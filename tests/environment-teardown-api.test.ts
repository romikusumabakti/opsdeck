import type { Table } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The delete API: POST /api/environments/:id/teardown starts a full teardown
// (archive, bring down, remove), /retry resumes it, GET shows its steps, and
// DELETE /api/environments/:id is the row-only "Remove from Panel only", now
// for org server:manage only. Refusals are coded; the body carries the code
// and the fixed catalogue text, nothing else.

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const RUN_ID = "0197f3a0-1b2c-7def-8000-0123456789c1";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";

const state = vi.hoisted(() => ({
  orgRole: "member" as string,
  projectRole: "engineer" as string | null,
  // Row-only delete: what DELETE … RETURNING yields.
  deleted: [{ name: "TD Dev" }] as { name: string }[],
  variables: [] as { name: string; escrow: boolean }[],
  enqueued: [] as { name: string; data: unknown }[],
  enqueueError: null as Error | null,
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({ user: { id: USER_ID, role: state.orgRole } }),
  getServerSession: async () => ({
    user: { id: USER_ID, role: state.orgRole },
  }),
}));

// The project role comes from state; the permission check itself is real.
vi.mock("@/lib/authz", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/authz")>();
  const { canProject } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    ...real,
    requireProjectPermission: async (
      _scope: unknown,
      perms: Parameters<typeof canProject>[1]
    ) => {
      const role = state.projectRole as Parameters<typeof canProject>[0];
      if (!role) throw new HTTPException(404, { message: "Not Found" });
      if (!canProject(role, perms)) throw new real.ForbiddenError();
      return {
        session: { user: { id: USER_ID, role: state.orgRole } },
        role,
        projectId: "0197f3a0-1b2c-7def-8000-0123456789f1",
      };
    },
  };
});

const repo = vi.hoisted(() => ({
  loadTeardownSubject: vi.fn(),
  teardownState: vi.fn(),
  environmentBusy: vi.fn(),
  startTeardownRun: vi.fn(),
  saveTeardownSteps: vi.fn(),
  listTeardownSteps: vi.fn(),
  latestTeardownRunId: vi.fn(),
  cancelTeardownSteps: vi.fn(),
}));
vi.mock("@/lib/teardown/repository", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...repo,
}));

const plan = vi.hoisted(() => ({ buildTeardownPlan: vi.fn() }));
vi.mock("@/lib/teardown/plan", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...plan,
}));

const progress = vi.hoisted(() => ({ failRun: vi.fn(async () => true) }));
vi.mock("@/lib/run-progress", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...progress,
}));

vi.mock("@/lib/queue", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueue: vi.fn(async (name: string, data: unknown) => {
    if (state.enqueueError) throw state.enqueueError;
    state.enqueued.push({ name, data });
  }),
}));

vi.mock("@/lib/activity", () => ({ recordActivity: async () => {} }));

// The row-only delete reads the variables and deletes the row.
vi.mock("@/lib/db", async () => {
  const { getTableName: name } = await import("drizzle-orm");
  function chain(op: string, table?: Table): unknown {
    let current = table;
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            const t = current ? name(current) : "?";
            const value =
              op === "delete" && t === "environments"
                ? state.deleted
                : op === "select" && t === "environment_variables"
                  ? state.variables
                  : [];
            return (resolve: (v: unknown) => unknown) => resolve(value);
          }
          return (...args: unknown[]) => {
            if (prop === "from") current = args[0] as Table;
            return proxy;
          };
        },
      }
    );
    return proxy;
  }
  return {
    db: {
      select: () => chain("select"),
      delete: (table: Table) => chain("delete", table),
      update: (table: Table) => chain("update", table),
      insert: (table: Table) => chain("insert", table),
    },
  };
});

const { app } = await import("@/server/app");
const { TEARDOWN_ERRORS } = await import("@/lib/teardown/errors");

const STEPS = [
  {
    kind: "check_stack",
    params: { serverId: "s1", deployDir: "/deployments/td" },
  },
  { kind: "delete_environment", params: {} },
];

function subject(extra: Record<string, unknown> = {}) {
  return {
    name: "TD Dev",
    kind: "dev",
    hasEscrowedVariables: false,
    ...extra,
  };
}

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const start = (body: unknown = { confirmName: "TD Dev" }) =>
  send("POST", `/api/environments/${ENV_ID}/teardown`, body);
const retry = () => send("POST", `/api/environments/${ENV_ID}/teardown/retry`);

/** A coded refusal: status, then a body of exactly the code and its text. */
async function expectRefusal(
  res: Response,
  status: number,
  code: keyof typeof TEARDOWN_ERRORS
) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error: TEARDOWN_ERRORS[code], code });
}

function expectNothingStarted() {
  expect(repo.startTeardownRun).not.toHaveBeenCalled();
  expect(repo.saveTeardownSteps).not.toHaveBeenCalled();
  expect(state.enqueued).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.orgRole = "member";
  state.projectRole = "engineer";
  state.deleted = [{ name: "TD Dev" }];
  state.variables = [];
  state.enqueued = [];
  state.enqueueError = null;
  repo.loadTeardownSubject.mockResolvedValue(subject());
  repo.teardownState.mockResolvedValue({
    planned: false,
    running: false,
    progressed: false,
  });
  repo.environmentBusy.mockResolvedValue(false);
  repo.startTeardownRun.mockResolvedValue({ runId: RUN_ID });
  repo.saveTeardownSteps.mockResolvedValue(undefined);
  repo.listTeardownSteps.mockResolvedValue([]);
  repo.latestTeardownRunId.mockResolvedValue(null);
  repo.cancelTeardownSteps.mockResolvedValue({ cancelled: true });
  plan.buildTeardownPlan.mockResolvedValue({ steps: STEPS });
});

describe("POST /api/environments/:id/teardown", () => {
  it("lets an engineer tear down a dev environment: plans, opens the run, queues the job", async () => {
    const res = await start();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: RUN_ID });
    expect(repo.startTeardownRun).toHaveBeenCalledWith(
      ENV_ID,
      USER_ID,
      "start"
    );
    expect(repo.saveTeardownSteps).toHaveBeenCalledWith(ENV_ID, STEPS);
    expect(state.enqueued).toEqual([
      {
        name: "environment/teardown.requested",
        data: { environmentId: ENV_ID, runId: RUN_ID },
      },
    ]);
    // The steps are saved only after the run is won.
    expect(repo.startTeardownRun.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      repo.saveTeardownSteps.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("refuses an engineer on a production environment", async () => {
    repo.loadTeardownSubject.mockResolvedValue(subject({ kind: "prod" }));
    await expectRefusal(
      await start({ confirmName: "TD Dev", confirmProduction: true }),
      403,
      "environmentIsProduction"
    );
    expect(plan.buildTeardownPlan).not.toHaveBeenCalled();
    expectNothingStarted();
  });

  it("asks an admin to confirm a production environment", async () => {
    state.orgRole = "admin";
    repo.loadTeardownSubject.mockResolvedValue(subject({ kind: "prod" }));
    await expectRefusal(await start(), 422, "productionConfirmRequired");
    await expectRefusal(
      await start({ confirmName: "TD Dev", confirmProduction: false }),
      422,
      "productionConfirmRequired"
    );
    expectNothingStarted();

    const res = await start({ confirmName: "TD Dev", confirmProduction: true });
    expect(res.status).toBe(202);
  });

  it("refuses a confirmation that is not exactly the environment name", async () => {
    for (const confirmName of ["td dev", "TD Dev ", "", "TD"]) {
      await expectRefusal(
        await start({ confirmName }),
        422,
        "confirmNameMismatch"
      );
    }
    expect(plan.buildTeardownPlan).not.toHaveBeenCalled();
    expectNothingStarted();
  });

  it("gives a viewer or a QA user 403 on start and retry", async () => {
    for (const role of ["viewer", "qa"]) {
      state.projectRole = role;
      expect((await start()).status).toBe(403);
      expect((await retry()).status).toBe(403);
    }
    expect(repo.loadTeardownSubject).not.toHaveBeenCalled();
    expectNothingStarted();
  });

  it("answers 404 for an environment the caller cannot see, or that is gone", async () => {
    state.projectRole = null;
    expect((await start()).status).toBe(404);
    state.projectRole = "engineer";
    repo.loadTeardownSubject.mockResolvedValue(null);
    expect((await start()).status).toBe(404);
    expectNothingStarted();
  });

  it("refuses a second request while the teardown runs, before any re-plan", async () => {
    repo.teardownState.mockResolvedValue({
      planned: true,
      running: true,
      progressed: false,
    });
    await expectRefusal(await start(), 409, "teardownRunning");
    expect(plan.buildTeardownPlan).not.toHaveBeenCalled();
    expectNothingStarted();
  });

  it("refuses a fresh start once a step is done (retry resumes instead)", async () => {
    repo.teardownState.mockResolvedValue({
      planned: true,
      running: false,
      progressed: true,
    });
    await expectRefusal(await start(), 409, "teardownRunning");
    expect(plan.buildTeardownPlan).not.toHaveBeenCalled();
    expectNothingStarted();
  });

  it("re-plans a teardown whose steps never got anywhere", async () => {
    repo.teardownState.mockResolvedValue({
      planned: true,
      running: false,
      progressed: false,
    });
    expect((await start()).status).toBe(202);
    expect(repo.saveTeardownSteps).toHaveBeenCalledWith(ENV_ID, STEPS);
  });

  it("refuses while a deploy, provisioning, backup or restore run or a deploy lock is active", async () => {
    repo.environmentBusy.mockResolvedValue(true);
    await expectRefusal(await start(), 409, "environmentBusy");
    expect(plan.buildTeardownPlan).not.toHaveBeenCalled();
    expectNothingStarted();
  });

  it("passes a plan refusal on as 409 with its code, and opens no run", async () => {
    plan.buildTeardownPlan.mockResolvedValue({ refusal: "deployDirShared" });
    await expectRefusal(await start(), 409, "deployDirShared");
    expectNothingStarted();
    plan.buildTeardownPlan.mockResolvedValue(null);
    expect((await start()).status).toBe(404);
  });

  it("refuses when the run cannot be opened (a request won the race), saving no steps", async () => {
    for (const refusal of ["teardownRunning", "environmentBusy"] as const) {
      repo.startTeardownRun.mockResolvedValueOnce({ refusal });
      await expectRefusal(await start(), 409, refusal);
    }
    expect(repo.saveTeardownSteps).not.toHaveBeenCalled();
    expect(state.enqueued).toEqual([]);
  });

  it("applies the escrow guard of today's delete", async () => {
    repo.loadTeardownSubject.mockResolvedValue(
      subject({ hasEscrowedVariables: true })
    );
    // No confirmation, or one from a caller without integration:manage.
    for (const [orgRole, confirmEscrowedDeletion] of [
      ["admin", undefined],
      ["admin", false],
      ["member", true],
      ["infra", true],
    ] as const) {
      state.orgRole = orgRole;
      const res = await start({
        confirmName: "TD Dev",
        confirmEscrowedDeletion,
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: "environmentHasEscrowedVariables",
      });
    }
    expectNothingStarted();

    state.orgRole = "admin";
    const res = await start({
      confirmName: "TD Dev",
      confirmEscrowedDeletion: true,
    });
    expect(res.status).toBe(202);
    // The confirmation goes with the delete step, which checks again.
    expect(repo.saveTeardownSteps).toHaveBeenCalledWith(ENV_ID, [
      STEPS[0],
      { kind: "delete_environment", params: { confirmEscrowedDeletion: true } },
    ]);
  });

  it("records no escrow confirmation without integration:manage", async () => {
    // infra: server:manage, not integration:manage; no escrowed variables yet.
    for (const orgRole of ["infra", "member"]) {
      state.orgRole = orgRole;
      repo.saveTeardownSteps.mockClear();
      const res = await start({
        confirmName: "TD Dev",
        confirmEscrowedDeletion: true,
      });
      expect(res.status).toBe(202);
      expect(repo.saveTeardownSteps).toHaveBeenCalledWith(ENV_ID, STEPS);
    }
  });

  it("closes the run when the job cannot be queued", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    state.enqueueError = new Error("redis down");
    expect((await start()).status).toBe(500);
    expect(progress.failRun).toHaveBeenCalledWith(RUN_ID, expect.any(String), {
      onlyIfStarted: true,
    });
    errors.mockRestore();
  });

  it("rejects a malformed body with 400", async () => {
    expect((await start({})).status).toBe(400);
    expect((await start({ confirmName: 5 })).status).toBe(400);
    expectNothingStarted();
  });
});

describe("POST /api/environments/:id/teardown/retry", () => {
  beforeEach(() => {
    repo.teardownState.mockResolvedValue({
      planned: true,
      running: false,
      progressed: true,
    });
  });

  it("opens a new run and queues the job, without re-planning", async () => {
    const res = await retry();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: RUN_ID });
    expect(plan.buildTeardownPlan).not.toHaveBeenCalled();
    expect(repo.saveTeardownSteps).not.toHaveBeenCalled();
    expect(state.enqueued).toEqual([
      {
        name: "environment/teardown.requested",
        data: { environmentId: ENV_ID, runId: RUN_ID },
      },
    ]);
  });

  it("refuses while running, while busy, and answers 404 with nothing to retry", async () => {
    repo.teardownState.mockResolvedValueOnce({
      planned: true,
      running: true,
      progressed: true,
    });
    await expectRefusal(await retry(), 409, "teardownRunning");
    repo.environmentBusy.mockResolvedValueOnce(true);
    await expectRefusal(await retry(), 409, "environmentBusy");
    repo.teardownState.mockResolvedValueOnce({
      planned: false,
      running: false,
      progressed: false,
    });
    expect((await retry()).status).toBe(404);
    expect(repo.startTeardownRun).not.toHaveBeenCalled();
  });

  it("refuses an engineer on a production environment", async () => {
    repo.loadTeardownSubject.mockResolvedValue(subject({ kind: "prod" }));
    await expectRefusal(await retry(), 403, "environmentIsProduction");
    state.orgRole = "admin";
    expect((await retry()).status).toBe(202);
  });
});

describe("POST /api/environments/:id/teardown/cancel", () => {
  const cancel = () =>
    send("POST", `/api/environments/${ENV_ID}/teardown/cancel`);

  it("drops the steps of a teardown that has not got past its archives", async () => {
    const res = await cancel();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(repo.cancelTeardownSteps).toHaveBeenCalledWith(ENV_ID);
  });

  it("refuses a running teardown, or one past its archives, and 404s with none", async () => {
    repo.cancelTeardownSteps.mockResolvedValueOnce({
      refusal: "teardownRunning",
    });
    await expectRefusal(await cancel(), 409, "teardownRunning");
    repo.cancelTeardownSteps.mockResolvedValueOnce({
      refusal: "teardownCannotCancel",
    });
    await expectRefusal(await cancel(), 409, "teardownCannotCancel");
    repo.cancelTeardownSteps.mockResolvedValueOnce({ nothing: true });
    expect((await cancel()).status).toBe(404);
  });

  it("needs the start's permission: 403 for viewer and QA, and for an engineer on prod", async () => {
    for (const role of ["viewer", "qa"]) {
      state.projectRole = role;
      expect((await cancel()).status).toBe(403);
    }
    state.projectRole = "engineer";
    repo.loadTeardownSubject.mockResolvedValue(subject({ kind: "prod" }));
    await expectRefusal(await cancel(), 403, "environmentIsProduction");
    expect(repo.cancelTeardownSteps).not.toHaveBeenCalled();
  });
});

describe("GET /api/environments/:id/teardown", () => {
  it("returns the steps and the latest run, or null before any teardown", async () => {
    let res = await send("GET", `/api/environments/${ENV_ID}/teardown`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();

    repo.listTeardownSteps.mockResolvedValue([
      {
        id: "x1",
        kind: "check_stack",
        status: "done",
        lastError: null,
        params: { deployDir: "/deployments/td" },
      },
      {
        id: "x2",
        kind: "archive_database",
        status: "failed",
        lastError: "archiveFailed",
        params: { serviceId: "s" },
      },
    ]);
    repo.latestTeardownRunId.mockResolvedValue(RUN_ID);
    state.projectRole = "viewer";
    res = await send("GET", `/api/environments/${ENV_ID}/teardown`);
    expect(await res.json()).toEqual({
      runId: RUN_ID,
      steps: [
        { kind: "check_stack", status: "done", lastError: null },
        {
          kind: "archive_database",
          status: "failed",
          lastError: "archiveFailed",
        },
      ],
    });
  });
});

describe("DELETE /api/environments/:id (Remove from Panel only)", () => {
  it("is 403 for an engineer without org server:manage", async () => {
    for (const orgRole of ["member", "observer"]) {
      state.orgRole = orgRole;
      const res = await send("DELETE", `/api/environments/${ENV_ID}`, {});
      expect(res.status).toBe(403);
    }
  });

  it("is 200 for an admin, and keeps the escrow guard", async () => {
    state.orgRole = "admin";
    let res = await send("DELETE", `/api/environments/${ENV_ID}`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });

    state.variables = [{ name: "DATA_ENCRYPTION_KEY", escrow: true }];
    res = await send("DELETE", `/api/environments/${ENV_ID}`, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "environmentHasEscrowedVariables",
    });
    res = await send("DELETE", `/api/environments/${ENV_ID}`, {
      confirmEscrowedDeletion: true,
    });
    expect(res.status).toBe(200);
  });
});

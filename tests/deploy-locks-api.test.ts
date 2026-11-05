import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The deploy lock API end to end through the Hono app, against an in-memory
// repository whose release mirrors the SQL (delete the lock; per target the
// newest held deployment becomes queued, older ones superseded). The real
// releaseLock / sweepExpiredLocks run on top of it.

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const OWNER = "0197f3a0-1b2c-7def-8000-0123456789f1";
const MAINTAINER = "0197f3a0-1b2c-7def-8000-0123456789f2";
const VIEWER = "0197f3a0-1b2c-7def-8000-0123456789f3";
const ADMIN = "0197f3a0-1b2c-7def-8000-0123456789f4";
const TARGET_A = "0197f3a0-1b2c-7def-8000-0123456789a1";
const TARGET_B = "0197f3a0-1b2c-7def-8000-0123456789a2";

type Dep = {
  id: string;
  targetId: string;
  runId: string | null;
  status: "held" | "queued" | "superseded" | "running";
  createdAt: Date;
};

const state = vi.hoisted(() => ({
  userId: "",
  role: "maintainer" as string | null,
  orgRole: "member",
}));

const store = vi.hoisted(() => ({
  env: {
    id: "0197f3a0-1b2c-7def-8000-0123456789e1",
    name: "Kestrel Dev",
    ownerId: null as string | null,
  },
  lock: null as null | {
    environmentId: string;
    lockedBy: string | null;
    reason: string;
    expiresAt: Date;
    createdAt: Date;
  },
  deps: [] as {
    id: string;
    targetId: string;
    runId: string | null;
    status: "held" | "queued" | "superseded" | "running";
    createdAt: Date;
  }[],
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: state.userId, role: state.orgRole },
  })),
}));

vi.mock("@/lib/authz", async () => {
  const { canOrg, canProject } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  const session = () => ({ user: { id: state.userId, role: state.orgRole } });
  return {
    requireProjectPermission: vi.fn(
      async (_scope: unknown, perms: Parameters<typeof canProject>[1]) => {
        if (!state.role) throw new HTTPException(404, { message: "Not Found" });
        if (!canProject(state.role as "viewer", perms)) {
          throw new HTTPException(403, { message: "Forbidden" });
        }
        return { session: session(), role: state.role, projectId: "p1" };
      }
    ),
    requireOrgPermission: vi.fn(async (perms: Parameters<typeof canOrg>[1]) => {
      if (!canOrg(state.orgRole, perms)) {
        throw new HTTPException(403, { message: "Forbidden" });
      }
      return session();
    }),
  };
});

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

const queue = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@/lib/queue", () => queue);

vi.mock("@/lib/deploy/repository", async () => {
  const { planHeldRelease } = await import("@/lib/deploy/lock");
  const NAMES: Record<string, string> = {
    "0197f3a0-1b2c-7def-8000-0123456789f1": "Owner Olga",
    "0197f3a0-1b2c-7def-8000-0123456789f2": "Maintainer Mira",
    "0197f3a0-1b2c-7def-8000-0123456789f3": "Viewer Vino",
    "0197f3a0-1b2c-7def-8000-0123456789f4": "Admin Ayu",
  };
  return {
    getEnvironmentForLock: vi.fn(async (id: string) =>
      id === store.env.id ? { ...store.env } : null
    ),
    getDeployLock: vi.fn(async (id: string) =>
      store.lock && store.lock.environmentId === id
        ? {
            ...store.lock,
            lockerName: store.lock.lockedBy
              ? (NAMES[store.lock.lockedBy] ?? null)
              : null,
          }
        : null
    ),
    countHeldDeployments: vi.fn(
      async () => store.deps.filter((d) => d.status === "held").length
    ),
    insertDeployLock: vi.fn(async (lock: NonNullable<typeof store.lock>) => {
      if (store.lock) return null;
      store.lock = { ...lock };
      return { held: [], cancelled: [] };
    }),
    updateDeployLock: vi.fn(
      async (
        _id: string,
        createdAt: Date,
        changes: { reason: string; expiresAt: Date }
      ) => {
        if (store.lock?.createdAt.getTime() !== createdAt.getTime()) {
          return false;
        }
        store.lock = { ...store.lock, ...changes };
        return true;
      }
    ),
    listExpiredDeployLocks: vi.fn(async (now: Date) =>
      store.lock && store.lock.expiresAt.getTime() <= now.getTime()
        ? [store.lock.environmentId]
        : []
    ),
    // Mirrors releaseDeployLock's transaction.
    releaseDeployLock: vi.fn(
      async (
        id: string,
        match: { createdAt?: Date; expiredAt?: Date } = {},
        _actorId: string | null = null
      ) => {
        const lock = store.lock;
        if (!lock || lock.environmentId !== id) return null;
        if (
          match.createdAt &&
          lock.createdAt.getTime() !== match.createdAt.getTime()
        ) {
          return null;
        }
        if (
          match.expiredAt &&
          lock.expiresAt.getTime() > match.expiredAt.getTime()
        ) {
          return null;
        }
        store.lock = null;
        const plan = planHeldRelease(
          store.deps.filter((d) => d.status === "held")
        );
        const queued = [];
        for (const d of store.deps) {
          if (plan.queue.includes(d.id)) {
            // The run is created on release; held rows have none.
            d.status = "queued";
            d.runId = `run-${d.id}`;
            queued.push({ deploymentId: d.id, runId: d.runId });
          } else if (plan.supersede.includes(d.id)) {
            d.status = "superseded";
          }
        }
        return { lock, queued, superseded: plan.supersede };
      }
    ),
  };
});

const { app } = await import("@/server/app");
const { sweepExpiredLocks } = await import("@/lib/deploy/lock-release");

const NOW = new Date("2026-11-05T03:00:00Z"); // 10:00 WIB
const LATER = new Date("2026-11-05T08:00:00Z");

function as(userId: string, role: string | null, orgRole = "member") {
  state.userId = userId;
  state.role = role;
  state.orgRole = orgRole;
}

function send(method: string, path: string, body?: unknown, locale = "en") {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", "X-Locale": locale },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const lockPath = `/api/environments/${ENV_ID}/deploy-lock`;
const forcePath = `${lockPath}/force-unlock`;

function setLock(lockedBy: string | null, expiresAt = LATER) {
  store.lock = {
    environmentId: ENV_ID,
    lockedBy,
    reason: "UAT with the client",
    expiresAt,
    createdAt: new Date(NOW.getTime() - 60_000),
  };
}

function held(id: string, targetId: string, second: number): Dep {
  return {
    id,
    targetId,
    runId: null,
    status: "held",
    createdAt: new Date(Date.UTC(2026, 10, 5, 2, 0, second)),
  };
}

function actions(): string[] {
  return activity.recordActivity.mock.calls.map((c) => c[0].action);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  store.env.ownerId = OWNER;
  store.lock = null;
  store.deps = [];
  as(MAINTAINER, "maintainer");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET deploy-lock", () => {
  it("shows the active lock with its holder and the held count to a viewer", async () => {
    setLock(OWNER);
    store.deps = [held("d1", TARGET_A, 1), held("d2", TARGET_B, 2)];
    as(VIEWER, "viewer");
    const res = await send("GET", lockPath);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lock: {
        lockedBy: { id: OWNER, name: "Owner Olga" },
        reason: "UAT with the client",
        expiresAt: LATER.toISOString(),
      },
      heldCount: 2,
    });
  });

  it("reports an expired lock as no lock, before the sweep removes it", async () => {
    setLock(OWNER, new Date(NOW.getTime() - 1));
    const res = await send("GET", lockPath);
    expect((await res.json()).lock).toBeNull();
  });

  it("is 404 without project access", async () => {
    as(VIEWER, null);
    expect((await send("GET", lockPath)).status).toBe(404);
  });
});

describe("PUT deploy-lock (who may lock)", () => {
  it("lets the owner lock with only the viewer role, defaulting to 17:00 WIB", async () => {
    as(OWNER, "viewer");
    const res = await send("PUT", lockPath, { reason: "UAT with the client" });
    expect(res.status).toBe(200);
    expect(store.lock).toMatchObject({
      lockedBy: OWNER,
      reason: "UAT with the client",
      expiresAt: new Date("2026-11-05T10:00:00Z"),
    });
    expect(actions()).toEqual(["deployLock.locked"]);
    expect(activity.recordActivity.mock.calls[0]?.[0]).toMatchObject({
      actorId: OWNER,
      entityType: "environment",
      entityId: ENV_ID,
      data: { environment: "Kestrel Dev", reason: "UAT with the client" },
    });
  });

  it("lets a maintainer lock with an explicit expiry", async () => {
    const res = await send("PUT", lockPath, {
      reason: "Demo",
      expiresAt: LATER.toISOString(),
    });
    expect(res.status).toBe(200);
    expect(store.lock).toMatchObject({
      lockedBy: MAINTAINER,
      expiresAt: LATER,
    });
  });

  it("refuses a viewer who is not the owner, and a contributor who is not", async () => {
    as(VIEWER, "viewer");
    expect((await send("PUT", lockPath, { reason: "x" })).status).toBe(403);
    as(VIEWER, "contributor");
    expect((await send("PUT", lockPath, { reason: "x" })).status).toBe(403);
    expect(store.lock).toBeNull();
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("takes lock rights away as soon as the owner is changed; their lock stays", async () => {
    as(OWNER, "viewer");
    expect((await send("PUT", lockPath, { reason: "mine" })).status).toBe(200);
    store.env.ownerId = MAINTAINER;
    expect((await send("PUT", lockPath, { reason: "again" })).status).toBe(403);
    expect(store.lock).toMatchObject({ lockedBy: OWNER, reason: "mine" });
  });

  it("refuses to take over someone else's active lock with a 409 naming it", async () => {
    setLock(OWNER);
    const res = await send("PUT", lockPath, { reason: "mine now" });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toContain("Owner Olga");
    expect(error).toContain("UAT with the client");
    expect(store.lock?.lockedBy).toBe(OWNER);
  });

  it("lets the locker change the reason and expiry of their own lock", async () => {
    setLock(MAINTAINER);
    const res = await send("PUT", lockPath, { reason: "Longer UAT" });
    expect(res.status).toBe(200);
    expect(store.lock).toMatchObject({
      lockedBy: MAINTAINER,
      reason: "Longer UAT",
    });
    expect(actions()).toEqual(["deployLock.updated"]);
  });

  it("releases an expired lock before setting the new one", async () => {
    setLock(OWNER, new Date(NOW.getTime() - 1));
    store.deps = [held("d1", TARGET_A, 1)];
    const res = await send("PUT", lockPath, { reason: "New window" });
    expect(res.status).toBe(200);
    expect(store.deps[0]?.status).toBe("queued");
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(store.lock).toMatchObject({ lockedBy: MAINTAINER });
    expect(actions()).toEqual(["deployLock.expired", "deployLock.locked"]);
  });
});

describe("PUT deploy-lock (validation, translated)", () => {
  it("rejects an empty or too long reason", async () => {
    const empty = await send("PUT", lockPath, { reason: "  " });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toBe(
      "Give a reason of 1 to 200 characters."
    );
    const long = await send("PUT", lockPath, { reason: "x".repeat(201) });
    expect(long.status).toBe(400);
    const missing = await send("PUT", lockPath, {}, "id");
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe(
      "Isi alasan 1 sampai 200 karakter."
    );
  });

  it("rejects an expiry in the past or more than 7 days ahead", async () => {
    for (const expiresAt of [
      new Date(NOW.getTime() - 1000).toISOString(),
      new Date(NOW.getTime() + 8 * 24 * 3_600_000).toISOString(),
      "not a date",
    ]) {
      const res = await send("PUT", lockPath, { reason: "x", expiresAt });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(
        "Pick an expiry in the future, at most 7 days ahead."
      );
    }
    expect(store.lock).toBeNull();
  });
});

describe("DELETE deploy-lock (who may unlock)", () => {
  it("refuses a maintainer on a lock the owner set", async () => {
    setLock(OWNER);
    const res = await send("DELETE", lockPath);
    expect(res.status).toBe(403);
    expect(store.lock).not.toBeNull();
  });

  it("refuses a viewer who neither owns the environment nor set the lock", async () => {
    setLock(MAINTAINER);
    as(VIEWER, "viewer");
    expect((await send("DELETE", lockPath)).status).toBe(403);
    expect(store.lock).not.toBeNull();
  });

  it("is 404 for someone without project access, even the locker", async () => {
    setLock(MAINTAINER);
    as(MAINTAINER, null);
    expect((await send("DELETE", lockPath)).status).toBe(404);
    expect(store.lock).not.toBeNull();
  });

  it("lets the owner remove a maintainer's lock", async () => {
    setLock(MAINTAINER);
    as(OWNER, "viewer");
    const res = await send("DELETE", lockPath);
    expect(res.status).toBe(200);
    expect(store.lock).toBeNull();
    expect(actions()).toEqual(["deployLock.unlocked"]);
  });

  it("lets the locker remove their own lock", async () => {
    setLock(MAINTAINER);
    expect((await send("DELETE", lockPath)).status).toBe(200);
    expect(store.lock).toBeNull();
  });

  it("queues exactly the newest held deployment per target and supersedes the older", async () => {
    setLock(MAINTAINER);
    store.deps = [
      held("a1", TARGET_A, 1),
      held("a2", TARGET_A, 2),
      held("b1", TARGET_B, 1),
    ];
    const res = await send("DELETE", lockPath);
    expect(res.status).toBe(200);
    expect((await res.json()).queued.sort()).toEqual(["a2", "b1"]);
    expect(store.deps.map((d) => [d.id, d.status])).toEqual([
      ["a1", "superseded"],
      ["a2", "queued"],
      ["b1", "queued"],
    ]);
    // Only enqueued: the worker claims them one at a time (one running per
    // environment), nothing here starts a deployment.
    expect(queue.enqueue.mock.calls).toEqual([
      ["deploy/run.requested", { deploymentId: "a2", runId: "run-a2" }],
      ["deploy/run.requested", { deploymentId: "b1", runId: "run-b1" }],
    ]);
    expect(store.deps.some((d) => d.status === "running")).toBe(false);
  });

  it("is idempotent: two unlocks at once queue the held builds once", async () => {
    setLock(MAINTAINER);
    store.deps = [held("a1", TARGET_A, 1)];
    const [first, second] = await Promise.all([
      send("DELETE", lockPath),
      send("DELETE", lockPath),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(actions()).toEqual(["deployLock.unlocked"]);
  });

  it("answers 409 when the lock it checked was replaced before the delete", async () => {
    // The newer lock is in place; the request read the older one.
    setLock(OWNER);
    const { getDeployLock } = await import("@/lib/deploy/repository");
    vi.mocked(getDeployLock).mockResolvedValueOnce({
      ...(store.lock as NonNullable<typeof store.lock>),
      lockedBy: MAINTAINER,
      createdAt: new Date(NOW.getTime() - 3_600_000),
      lockerName: "Maintainer Mira",
    });
    const res = await send("DELETE", lockPath);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "The deploy lock changed in the meantime. Reload and try again."
    );
    expect(store.lock?.lockedBy).toBe(OWNER);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("lets any project member clear an expired, unswept lock, logged as expired", async () => {
    setLock(OWNER, new Date(NOW.getTime() - 1));
    as(VIEWER, "viewer");
    const res = await send("DELETE", lockPath);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: [] });
    expect(store.lock).toBeNull();
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: null, action: "deployLock.expired" })
    );
  });

  it("answers 409 when an expired lock it would clear was replaced by a fresh one", async () => {
    // The request read the expired lock; a new one was set before the delete.
    setLock(OWNER);
    const { getDeployLock } = await import("@/lib/deploy/repository");
    vi.mocked(getDeployLock).mockResolvedValueOnce({
      ...(store.lock as NonNullable<typeof store.lock>),
      expiresAt: new Date(NOW.getTime() - 1),
      createdAt: new Date(NOW.getTime() - 3_600_000),
      lockerName: "Owner Olga",
    });
    as(VIEWER, "viewer");
    const res = await send("DELETE", lockPath);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "The deploy lock changed in the meantime. Reload and try again."
    );
    expect(store.lock).not.toBeNull();
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("gives the released runs to the unlocking user, and to nobody on expiry", async () => {
    const { releaseDeployLock } = await import("@/lib/deploy/repository");
    setLock(MAINTAINER);
    await send("DELETE", lockPath);
    expect(vi.mocked(releaseDeployLock).mock.calls.at(-1)?.[2]).toBe(
      MAINTAINER
    );
    setLock(MAINTAINER, new Date(NOW.getTime() - 1));
    await sweepExpiredLocks(NOW);
    expect(vi.mocked(releaseDeployLock).mock.calls.at(-1)?.[2]).toBeNull();
  });

  it("does nothing when there is no lock", async () => {
    const res = await send("DELETE", lockPath);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: [] });
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });
});

describe("POST deploy-lock/force-unlock", () => {
  it("refuses a maintainer, even with a reason", async () => {
    setLock(OWNER);
    const res = await send("POST", forcePath, { reason: "Hotfix" });
    expect(res.status).toBe(403);
    expect(store.lock).not.toBeNull();
  });

  it("refuses an admin without a reason (translated)", async () => {
    setLock(OWNER);
    as(ADMIN, "maintainer", "admin");
    for (const body of [{}, { reason: "   " }]) {
      const res = await send("POST", forcePath, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(
        "Give a reason for the force unlock."
      );
    }
    expect(store.lock).not.toBeNull();
  });

  it("lets an admin force-unlock with a reason, recorded in the activity log", async () => {
    setLock(OWNER);
    store.deps = [held("a1", TARGET_A, 1)];
    as(ADMIN, "maintainer", "admin");
    const res = await send("POST", forcePath, { reason: "Production hotfix" });
    expect(res.status).toBe(200);
    expect(store.lock).toBeNull();
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ADMIN,
        action: "deployLock.forceUnlocked",
        entityId: ENV_ID,
        data: expect.objectContaining({
          environment: "Kestrel Dev",
          reason: "Production hotfix",
          lockReason: "UAT with the client",
          count: 1,
        }),
      })
    );
  });
});

describe("POST deploy-lock/force-unlock run owner", () => {
  it("gives the released runs to the admin who forced the unlock", async () => {
    const { releaseDeployLock } = await import("@/lib/deploy/repository");
    setLock(OWNER);
    as(ADMIN, "maintainer", "admin");
    await send("POST", forcePath, { reason: "Production hotfix" });
    expect(vi.mocked(releaseDeployLock).mock.calls.at(-1)?.[2]).toBe(ADMIN);
  });
});

describe("sweepExpiredLocks", () => {
  it("releases an expired lock and deploys its held builds", async () => {
    setLock(OWNER, new Date(NOW.getTime() - 60_000));
    store.deps = [held("a1", TARGET_A, 1), held("a2", TARGET_A, 2)];
    await expect(sweepExpiredLocks(NOW)).resolves.toBe(1);
    expect(store.lock).toBeNull();
    expect(queue.enqueue).toHaveBeenCalledWith("deploy/run.requested", {
      deploymentId: "a2",
      runId: "run-a2",
    });
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: null,
        action: "deployLock.expired",
        data: expect.objectContaining({ environment: "Kestrel Dev", count: 1 }),
      })
    );
  });

  it("leaves an active lock alone", async () => {
    setLock(OWNER);
    store.deps = [held("a1", TARGET_A, 1)];
    await expect(sweepExpiredLocks(NOW)).resolves.toBe(0);
    expect(store.lock).not.toBeNull();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("an unlock racing the sweep queues the held builds once", async () => {
    setLock(MAINTAINER, new Date(NOW.getTime() - 1));
    store.deps = [held("a1", TARGET_A, 1)];
    await Promise.all([sweepExpiredLocks(NOW), send("DELETE", lockPath)]);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });
});

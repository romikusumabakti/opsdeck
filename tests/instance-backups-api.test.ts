import { getTableName, type Table } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const BACKUP_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";
const DEST_ID = "0197f3a0-1b2c-7def-8000-0123456789d1";
const KEY = Buffer.alloc(32, 7).toString("base64");

type Op = "select" | "update" | "insert";

const state = vi.hoisted(() => ({
  role: "admin" as string,
  // What each (operation, table) resolves to; the predicate is ignored.
  results: {} as Record<string, unknown[]>,
  writes: [] as { op: string; table: string; values: unknown }[],
  scheduled: [] as { time: string }[],
  enqueued: [] as { name: string; data: unknown; options: unknown }[],
  logged: [] as string[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "user-1", role: state.role },
  })),
  getServerSession: vi.fn(async () => ({
    user: { id: "user-1", role: state.role },
  })),
}));

vi.mock("@/lib/queue", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scheduleInstanceBackup: vi.fn(async (time: string) => {
    state.scheduled.push({ time });
  }),
  enqueue: vi.fn(async (name: string, data: unknown, options: unknown) => {
    state.enqueued.push({ name, data, options });
  }),
}));

const archive = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/instance-backup/archive", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runInstanceBackup: archive.run,
}));

// A chain fake: every builder method returns the chain, and awaiting it
// resolves to state.results["<op>:<table>"]. `set`/`values` are recorded.
vi.mock("@/lib/db", async () => {
  const { getTableName: name } = await import("drizzle-orm");
  function chain(op: Op, table?: Table): unknown {
    let current = table;
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            const key = `${op}:${current ? name(current) : "?"}`;
            const value = state.results[key] ?? [];
            return (resolve: (v: unknown) => unknown) => resolve(value);
          }
          return (...args: unknown[]) => {
            if (prop === "from") current = args[0] as Table;
            if (prop === "set" || prop === "values") {
              state.writes.push({
                op,
                table: current ? name(current) : "?",
                values: args[0],
              });
            }
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
      update: (table: Table) => chain("update", table),
      insert: (table: Table) => chain("insert", table),
    },
  };
});

process.env.SECRETS_KEY = KEY;
const { app } = await import("@/server/app");
const { secretsKeyFingerprint } = await import(
  "@/lib/instance-backup/manifest"
);
const { instanceBackups, instanceSettings, s3Connections } = await import(
  "@/lib/db/schema"
);

const T = {
  settings: getTableName(instanceSettings),
  backups: getTableName(instanceBackups),
  connections: getTableName(s3Connections),
};

function settingsRow(extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    backupDestinationId: null,
    backupTime: "02:30",
    backupKeepDaily: 14,
    backupKeepWeekly: 8,
    secretsKeyFingerprint: secretsKeyFingerprint(KEY),
    ...extra,
  };
}

function backupRow(extra: Record<string, unknown> = {}) {
  return {
    id: BACKUP_ID,
    startedAt: new Date("2026-11-09T19:30:00Z"),
    finishedAt: new Date("2026-11-09T19:31:00Z"),
    status: "succeeded",
    trigger: "schedule",
    version: "1.2.0",
    location: "s3",
    objectKey: "opsdeck-backups/opsdeck/x/",
    sizeBytes: 1024,
    errorCode: null,
    acknowledgedAt: null,
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

const validSettings = {
  destinationId: DEST_ID,
  time: "03:15",
  keepDaily: 14,
  keepWeekly: 8,
};

beforeEach(() => {
  state.role = "admin";
  state.results = {
    [`select:${T.settings}`]: [settingsRow()],
    [`select:${T.backups}`]: [backupRow()],
    [`select:${T.connections}`]: [{ id: DEST_ID, name: "R2", bucket: "b" }],
    [`update:${T.backups}`]: [{ id: BACKUP_ID }],
  };
  state.writes = [];
  state.scheduled = [];
  state.enqueued = [];
});

describe("permissions", () => {
  it("a non-admin gets 403 with code forbidden on every route", async () => {
    for (const role of ["infra", "observer", "member"]) {
      state.role = role;
      const calls: [string, string, unknown?][] = [
        ["GET", "/api/instance/backups"],
        ["PUT", "/api/instance/backups/settings", validSettings],
        ["POST", "/api/instance/backups/run"],
        ["POST", `/api/instance/backups/${BACKUP_ID}/acknowledge`],
        ["POST", "/api/instance/backups/verify-key", { key: KEY }],
      ];
      for (const [method, path, body] of calls) {
        const res = await send(method, path, body);
        expect(res.status, `${role} ${method} ${path}`).toBe(403);
        expect(await res.json()).toMatchObject({ code: "forbidden" });
      }
    }
    expect(state.writes).toEqual([]);
    expect(state.scheduled).toEqual([]);
    expect(state.enqueued).toEqual([]);
  });
  it("answers a non-admin 403 forbidden before validating the body", async () => {
    state.role = "member";
    const calls: [string, string, unknown?][] = [
      ["PUT", "/api/instance/backups/settings", { time: "nope" }],
      ["PUT", "/api/instance/backups/settings", "not json"],
      ["POST", "/api/instance/backups/verify-key", { key: "" }],
      ["POST", "/api/instance/backups/not-a-uuid/acknowledge"],
    ];
    for (const [method, path, body] of calls) {
      const res = await send(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({ code: "forbidden" });
    }
  });
});

describe("GET /api/instance/backups", () => {
  it("returns the settings, the history and the destinations", async () => {
    const res = await send("GET", "/api/instance/backups");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual({
      destinationId: null,
      time: "02:30",
      keepDaily: 14,
      keepWeekly: 8,
      timeZone: expect.any(String),
      secretsKeyFingerprint: secretsKeyFingerprint(KEY),
    });
    expect(body.backups).toHaveLength(1);
    expect(body.backups[0]).toMatchObject({ id: BACKUP_ID, version: "1.2.0" });
    expect(body.destinations).toEqual([
      { id: DEST_ID, name: "R2", bucket: "b" },
    ]);
  });
});

describe("PUT /api/instance/backups/settings", () => {
  it("saves and re-registers the scheduler with the new time", async () => {
    const res = await send(
      "PUT",
      "/api/instance/backups/settings",
      validSettings
    );
    expect(res.status).toBe(200);
    expect(state.writes).toContainEqual({
      op: "update",
      table: T.settings,
      values: {
        backupDestinationId: DEST_ID,
        backupTime: "03:15",
        backupKeepDaily: 14,
        backupKeepWeekly: 8,
      },
    });
    expect(state.scheduled).toEqual([{ time: "03:15" }]);
  });

  it("accepts no destination (local only)", async () => {
    const res = await send("PUT", "/api/instance/backups/settings", {
      ...validSettings,
      destinationId: null,
    });
    expect(res.status).toBe(200);
  });

  it("refuses a destination that does not exist", async () => {
    state.results[`select:${T.connections}`] = [];
    const res = await send(
      "PUT",
      "/api/instance/backups/settings",
      validSettings
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "backupDestinationNotFound",
    });
    expect(state.scheduled).toEqual([]);
  });

  it.each([
    { time: "24:00" },
    { time: "2:30" },
    { keepDaily: 0 },
    { keepDaily: 91 },
    { keepWeekly: -1 },
    { keepWeekly: 53 },
    { keepDaily: 1.5 },
    { destinationId: "not-a-uuid" },
  ])("rejects %o", async (patch) => {
    const res = await send("PUT", "/api/instance/backups/settings", {
      ...validSettings,
      ...patch,
    });
    expect(res.status).toBe(400);
    expect(state.writes).toEqual([]);
    expect(state.scheduled).toEqual([]);
  });

  it("accepts the bounds", async () => {
    for (const patch of [
      { keepDaily: 1, keepWeekly: 0, time: "00:00" },
      { keepDaily: 90, keepWeekly: 52, time: "23:59" },
    ]) {
      const res = await send("PUT", "/api/instance/backups/settings", {
        ...validSettings,
        ...patch,
      });
      expect(res.status).toBe(200);
    }
  });
});

describe("POST /api/instance/backups/run", () => {
  it("enqueues a manual backup", async () => {
    state.results[`select:${T.backups}`] = [];
    const res = await send("POST", "/api/instance/backups/run");
    expect(res.status).toBe(202);
    expect(state.enqueued).toEqual([
      {
        name: "instance/backup.run",
        data: { trigger: "manual" },
        options: { jobId: "instance-backup-manual" },
      },
    ]);
  });

  it("refuses while a backup is running", async () => {
    state.results[`select:${T.backups}`] = [{ id: BACKUP_ID }];
    const res = await send("POST", "/api/instance/backups/run");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "backupAlreadyRunning" });
    expect(state.enqueued).toEqual([]);
  });
});

describe("POST /api/instance/backups/:id/acknowledge", () => {
  it("sets acknowledgedAt", async () => {
    const res = await send(
      "POST",
      `/api/instance/backups/${BACKUP_ID}/acknowledge`
    );
    expect(res.status).toBe(200);
    const write = state.writes.find((w) => w.table === T.backups);
    expect(write?.values).toMatchObject({ acknowledgedAt: expect.any(Date) });
  });

  it("is a 404 for an unknown backup", async () => {
    state.results[`update:${T.backups}`] = [];
    state.results[`select:${T.backups}`] = [];
    const res = await send(
      "POST",
      `/api/instance/backups/${BACKUP_ID}/acknowledge`
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/instance/backups/verify-key", () => {
  it("matches the running key", async () => {
    const res = await send("POST", "/api/instance/backups/verify-key", {
      key: KEY,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ match: true });
  });

  it("returns match false for a wrong key and never echoes it", async () => {
    const wrong = Buffer.alloc(32, 8).toString("base64");
    const spies = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {})
    );
    const res = await send("POST", "/api/instance/backups/verify-key", {
      key: wrong,
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ match: false });
    expect(text).not.toContain(wrong);
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(wrong);
      }
      spy.mockRestore();
    }
    expect(state.writes).toEqual([]);
  });

  it("ignores surrounding whitespace, the same way on both sides", async () => {
    // The stored fingerprint was taken from a key with a trailing newline (an
    // .env line); the admin pastes it without one, and with one.
    state.results[`select:${T.settings}`] = [
      settingsRow({ secretsKeyFingerprint: secretsKeyFingerprint(`${KEY}\n`) }),
    ];
    for (const key of [KEY, `${KEY}\n`, `  ${KEY}  `]) {
      const res = await send("POST", "/api/instance/backups/verify-key", {
        key,
      });
      expect(await res.json()).toEqual({ match: true });
    }
    expect(secretsKeyFingerprint(`${KEY}\n`)).toBe(secretsKeyFingerprint(KEY));
  });

  it("rejects an empty key", async () => {
    const res = await send("POST", "/api/instance/backups/verify-key", {
      key: "",
    });
    expect(res.status).toBe(400);
  });
});

describe("Home attention for instance backups", () => {
  it("shows the item when the latest backup failed", async () => {
    state.results[`select:${T.backups}`] = [
      backupRow({
        status: "failed",
        errorCode: "backupUploadFailed",
        startedAt: new Date(),
      }),
    ];
    const res = await send("GET", "/api/home/instance-backup-attention");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: "failed",
      backupId: BACKUP_ID,
      errorCode: "backupUploadFailed",
    });
  });

  it("shows nothing after a recent success", async () => {
    state.results[`select:${T.backups}`] = [
      backupRow({ startedAt: new Date() }),
    ];
    const res = await send("GET", "/api/home/instance-backup-attention");
    expect(await res.json()).toBeNull();
  });

  it("shows nothing to a non-admin", async () => {
    state.role = "infra";
    state.results[`select:${T.backups}`] = [
      backupRow({ status: "failed", errorCode: "backupDumpFailed" }),
    ];
    const res = await send("GET", "/api/home/instance-backup-attention");
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});

describe("instanceBackupAttention", async () => {
  const { instanceBackupAttention, BACKUP_STALE_AFTER_MS } = await import(
    "@/lib/home/attention"
  );
  const now = new Date("2026-11-10T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const failed = {
    id: BACKUP_ID,
    status: "failed" as const,
    errorCode: "backupDumpFailed",
    startedAt: hoursAgo(1),
    acknowledgedAt: null,
  };

  it("uses a 36 h window", () => {
    expect(BACKUP_STALE_AFTER_MS).toBe(36 * 3_600_000);
  });

  it("reports an unacknowledged failure", () => {
    expect(
      instanceBackupAttention({
        latest: failed,
        lastSucceededAt: hoursAgo(2),
        installedAt: hoursAgo(100),
        now,
      })
    ).toEqual({
      kind: "failed",
      backupId: BACKUP_ID,
      errorCode: "backupDumpFailed",
      at: failed.startedAt,
    });
  });

  it("drops an acknowledged failure while backups are recent", () => {
    expect(
      instanceBackupAttention({
        latest: { ...failed, acknowledgedAt: hoursAgo(0.5) },
        lastSucceededAt: hoursAgo(20),
        installedAt: hoursAgo(100),
        now,
      })
    ).toBeNull();
  });

  it("reports no success in 36 h, even after an acknowledged failure", () => {
    expect(
      instanceBackupAttention({
        latest: { ...failed, acknowledgedAt: hoursAgo(0.5) },
        lastSucceededAt: hoursAgo(37),
        installedAt: hoursAgo(100),
        now,
      })
    ).toEqual({ kind: "stale", lastSucceededAt: hoursAgo(37) });
  });

  it("counts from the install when no backup has ever succeeded", () => {
    const fresh = {
      latest: null,
      lastSucceededAt: null,
      installedAt: hoursAgo(10),
      now,
    };
    expect(instanceBackupAttention(fresh)).toBeNull();
    expect(
      instanceBackupAttention({ ...fresh, installedAt: hoursAgo(40) })
    ).toEqual({ kind: "stale", lastSucceededAt: null });
  });
});

describe("the backup job", async () => {
  const { handleInstanceBackup } = await import("@/lib/jobs/processor");
  const { instanceBackupCron } = await import("@/lib/queue");

  it("runs the backup", async () => {
    archive.run.mockResolvedValue({ id: BACKUP_ID, status: "succeeded" });
    await handleInstanceBackup("schedule");
    expect(archive.run).toHaveBeenCalledWith("schedule");
  });

  it("logs and skips when another backup holds the lock", async () => {
    const result = {
      id: null,
      status: "alreadyRunning",
      location: null,
      objectKey: null,
      errorCode: "backupAlreadyRunning",
    };
    archive.run.mockResolvedValue(result);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await handleInstanceBackup("manual")).toEqual(result);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("turns HH:MM into a daily cron", () => {
    expect(instanceBackupCron("02:30")).toBe("30 2 * * *");
    expect(instanceBackupCron("00:05")).toBe("5 0 * * *");
    expect(() => instanceBackupCron("24:00")).toThrow();
  });
});

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getTableName, type Table } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const BACKUP_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";
const KEY = Buffer.alloc(32, 7).toString("base64");
const BACKUP_NAME = "2026-11-09T193000.000Z-abc123-1.1.0";

const dirs = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = mkdtempSync(join(tmpdir(), "instance-updates-"));
  return {
    base,
    updates: join(base, "updates"),
    backups: join(base, "backups"),
  };
});

const state = vi.hoisted(() => ({
  role: "admin" as string,
  results: {} as Record<string, unknown[]>,
  writes: [] as { op: string; table: string; values: unknown }[],
  check: {
    available: null as null | {
      version: string;
      notesUrl: string;
      minFrom: string;
    },
    error: null as null | string,
    checkedAt: null as null | Date,
  },
  checkCalls: [] as { channel: string; current: string; force?: boolean }[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "0197f3a0-1b2c-7def-8000-00000000a001", role: state.role },
  })),
  getServerSession: vi.fn(async () => ({
    user: { id: "0197f3a0-1b2c-7def-8000-00000000a001", role: state.role },
  })),
}));

vi.mock("@/lib/version", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  OPSDECK_VERSION: "1.2.0",
}));

vi.mock("@/lib/updates/request", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  UPDATES_DIR: dirs.updates,
}));

vi.mock("@/lib/instance-backup/archive", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  LOCAL_BACKUP_ROOT: dirs.backups,
}));

vi.mock("@/lib/updates/releases", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkForUpdate: vi.fn(
    async (
      channel: string,
      current: string,
      opts: { force?: boolean } = {}
    ) => {
      state.checkCalls.push({ channel, current, force: opts.force });
      return state.check;
    }
  ),
}));

vi.mock("@/lib/queue", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scheduleInstanceBackup: vi.fn(async () => {}),
  enqueue: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", async () => {
  const { getTableName: name } = await import("drizzle-orm");
  function chain(op: string, table?: Table): unknown {
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
delete process.env.COMPOSE_PROJECT_NAME;
const { app } = await import("@/server/app");
const { secretsKeyFingerprint, serializeManifest } = await import(
  "@/lib/instance-backup/manifest"
);
const { instanceBackups, instanceSettings } = await import("@/lib/db/schema");
const { runInstanceUpdateCheck } = await import(
  "@/server/services/instance-updates"
);
const { updateStatusSchema } = await import("@/lib/updates/request");

const T = {
  settings: getTableName(instanceSettings),
  backups: getTableName(instanceBackups),
};

function settingsRow(extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    backupDestinationId: null,
    backupTime: "02:30",
    backupKeepDaily: 14,
    backupKeepWeekly: 8,
    secretsKeyFingerprint: secretsKeyFingerprint(KEY),
    updateChannel: "stable",
    autoUpdate: false,
    autoUpdateWindow: "03:00",
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
    version: "1.1.0",
    location: "local",
    objectKey: `opsdeck/${BACKUP_NAME}/`,
    sizeBytes: 1024,
    errorCode: null,
    acknowledgedAt: null,
    ...extra,
  };
}

const AVAILABLE = {
  version: "1.2.1",
  notesUrl: "https://github.com/romikusumabakti/opsdeck/releases/tag/v1.2.1",
  minFrom: "1.0.0",
};

/** An ISO time `ms` before now, to the second like update.sh writes it. */
const ago = (ms: number) =>
  new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function status(extra: Record<string, unknown> = {}) {
  return {
    runId: "20261109T200000Z-0a0b0c0d",
    action: "update",
    version: "1.2.1",
    from: "1.2.0",
    step: "health",
    state: "running",
    code: null,
    // A run in progress: under the 70 min after which "running" is stale.
    startedAt: ago(60_000),
    finishedAt: null,
    logTail: ["step: health"],
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

async function writeLocalManifest(
  version = "1.1.0",
  fingerprint = secretsKeyFingerprint(KEY)
) {
  const dir = join(dirs.backups, "opsdeck", BACKUP_NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    serializeManifest({
      format: 1,
      version,
      createdAt: "2026-11-09T19:30:00.000Z",
      database: {
        file: "database.dump",
        sha256: createHash("sha256").update("x").digest("hex"),
        bytes: 1,
      },
      garage: { objects: 0, bytes: 0 },
      secretsKeyFingerprint: fingerprint,
    })
  );
}

const requestFile = () => join(dirs.updates, "request.json");
const readRequest = () => readFile(requestFile(), "utf8");

beforeEach(async () => {
  state.role = "admin";
  state.results = {
    [`select:${T.settings}`]: [settingsRow()],
    [`select:${T.backups}`]: [backupRow()],
  };
  state.writes = [];
  state.check = { available: AVAILABLE, error: null, checkedAt: new Date() };
  state.checkCalls = [];
  await rm(dirs.updates, { recursive: true, force: true });
  await rm(dirs.backups, { recursive: true, force: true });
  mkdirSync(dirs.updates, { recursive: true });
  await writeLocalManifest();
});

afterAll(async () => {
  await rm(dirs.base, { recursive: true, force: true });
});

describe("permissions", () => {
  it("a non-admin gets 403 forbidden on every route, before validation", async () => {
    for (const role of ["infra", "observer", "engineer", "qa"]) {
      state.role = role;
      const calls: [string, string, unknown?][] = [
        ["GET", "/api/instance/updates"],
        ["POST", "/api/instance/updates/check"],
        ["PUT", "/api/instance/updates/settings", { channel: "nope" }],
        ["POST", "/api/instance/updates/apply", { version: "../x" }],
        ["POST", "/api/instance/updates/restore-safety-backup", {}],
        ["POST", `/api/instance/backups/${BACKUP_ID}/restore`, {}],
        ["POST", "/api/instance/backups/not-a-uuid/restore", {}],
      ];
      for (const [method, path, body] of calls) {
        const res = await send(method, path, body);
        expect(res.status, `${role} ${method} ${path}`).toBe(403);
        expect(await res.json()).toMatchObject({ code: "forbidden" });
      }
    }
    expect(await readdir(dirs.updates)).toEqual([]);
    expect(state.writes).toEqual([]);
  });
});

describe("GET /api/instance/updates", () => {
  it("returns the version, settings, available release and status", async () => {
    await writeFile(
      join(dirs.updates, "status.json"),
      `${JSON.stringify(status())}\n`
    );
    const res = await send("GET", "/api/instance/updates");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      current: "1.2.0",
      channel: "stable",
      autoUpdate: false,
      window: "03:00",
      instance: "opsdeck",
      available: AVAILABLE,
      checkError: null,
      updaterInstalled: true,
      pending: false,
    });
    expect(body.status).toEqual(updateStatusSchema.parse(status()));
    expect(state.checkCalls).toEqual([
      { channel: "stable", current: "1.2.0", force: undefined },
    ]);
  });

  it("flags auto-update skipping a version whose last run did not succeed", async () => {
    state.results[`select:${T.settings}`] = [settingsRow({ autoUpdate: true })];
    await writeFile(
      join(dirs.updates, "status.json"),
      JSON.stringify(
        status({
          state: "rolled_back",
          code: "healthFailed",
          finishedAt: "2026-11-09T20:05:00Z",
        })
      )
    );
    let body = await (await send("GET", "/api/instance/updates")).json();
    expect(body.autoUpdateSkipped).toBe(true);
    await writeFile(
      join(dirs.updates, "status.json"),
      JSON.stringify(status())
    );
    body = await (await send("GET", "/api/instance/updates")).json();
    expect(body.autoUpdateSkipped).toBe(false);
  });

  it("reports a missing updater and no status", async () => {
    await rm(dirs.updates, { recursive: true, force: true });
    const body = await (await send("GET", "/api/instance/updates")).json();
    expect(body).toMatchObject({ updaterInstalled: false, status: null });
  });

  it("passes the check failure through with the last known release", async () => {
    state.check = { ...state.check, error: "updateCheckFailed" };
    const body = await (await send("GET", "/api/instance/updates")).json();
    expect(body).toMatchObject({
      available: AVAILABLE,
      checkError: "updateCheckFailed",
    });
  });
});

describe("POST /api/instance/updates/check", () => {
  it("forces a fresh release check and returns the page data", async () => {
    const res = await send("POST", "/api/instance/updates/check");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      current: "1.2.0",
      available: AVAILABLE,
      checkError: null,
    });
    expect(state.checkCalls).toEqual([
      { channel: "stable", current: "1.2.0", force: true },
    ]);
    expect(await readdir(dirs.updates)).toEqual([]);
  });
});

describe("PUT /api/instance/updates/settings", () => {
  it("saves the channel, auto-update and window", async () => {
    const res = await send("PUT", "/api/instance/updates/settings", {
      channel: "beta",
      autoUpdate: true,
      window: "04:30",
    });
    expect(res.status).toBe(200);
    expect(state.writes).toContainEqual({
      op: "update",
      table: T.settings,
      values: {
        updateChannel: "beta",
        autoUpdate: true,
        autoUpdateWindow: "04:30",
      },
    });
  });

  it.each([
    { channel: "nightly", autoUpdate: true, window: "04:30" },
    { channel: "stable", autoUpdate: "yes", window: "04:30" },
    { channel: "stable", autoUpdate: false, window: "4:30" },
  ])("rejects %o", async (body) => {
    const res = await send("PUT", "/api/instance/updates/settings", body);
    expect(res.status).toBe(400);
    expect(state.writes).toEqual([]);
  });
});

describe("POST /api/instance/updates/apply", () => {
  it("writes the exact request JSON atomically", async () => {
    const res = await send("POST", "/api/instance/updates/apply", {
      version: "1.2.1",
    });
    expect(res.status).toBe(202);
    const text = await readRequest();
    expect(text).toMatch(
      /^\{"action":"update","version":"1\.2\.1","requestedBy":"0197f3a0-1b2c-7def-8000-00000000a001","requestedAt":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"\}\n$/
    );
    // No temp file is left behind.
    expect(await readdir(dirs.updates)).toEqual(["request.json"]);
  });

  it("refuses a version that is not the available one", async () => {
    for (const version of ["1.2.0", "1.3.0"]) {
      const res = await send("POST", "/api/instance/updates/apply", {
        version,
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "updateNotAvailable" });
    }
    state.check = { available: null, error: null, checkedAt: new Date() };
    const res = await send("POST", "/api/instance/updates/apply", {
      version: "1.2.1",
    });
    expect(await res.json()).toMatchObject({ code: "updateNotAvailable" });
    expect(await readdir(dirs.updates)).toEqual([]);
  });

  it("rejects a value that is not a release version", async () => {
    const res = await send("POST", "/api/instance/updates/apply", {
      version: "1.2.1; rm -rf /",
    });
    expect(res.status).toBe(400);
  });

  it("refuses below minFrom", async () => {
    state.check = {
      ...state.check,
      available: { ...AVAILABLE, minFrom: "1.2.1" },
    };
    const res = await send("POST", "/api/instance/updates/apply", {
      version: "1.2.1",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "belowMinFrom" });
  });

  it("refuses without the updater (updaterMissing)", async () => {
    await rm(dirs.updates, { recursive: true, force: true });
    const res = await send("POST", "/api/instance/updates/apply", {
      version: "1.2.1",
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "updaterMissing" });
  });

  it("treats a run still running after 70 min as interrupted, not in progress", async () => {
    const stale = status({ startedAt: ago(71 * 60_000) });
    await writeFile(join(dirs.updates, "status.json"), JSON.stringify(stale));
    const body = await (await send("GET", "/api/instance/updates")).json();
    expect(body.status).toMatchObject({
      runId: stale.runId,
      state: "failed",
      code: "interrupted",
    });
    const res = await send("POST", "/api/instance/updates/apply", {
      version: "1.2.1",
    });
    expect(res.status).toBe(202);
    expect(JSON.parse(await readRequest())).toMatchObject({
      action: "update",
      version: "1.2.1",
    });
  });

  it("still refuses a run under 70 min old", async () => {
    await writeFile(
      join(dirs.updates, "status.json"),
      JSON.stringify(status({ startedAt: ago(69 * 60_000) }))
    );
    const res = await send("POST", "/api/instance/updates/apply", {
      version: "1.2.1",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "updateInProgress" });
  });

  it("refuses while a run is in progress or a request is pending", async () => {
    await writeFile(
      join(dirs.updates, "status.json"),
      JSON.stringify(status())
    );
    let res = await send("POST", "/api/instance/updates/apply", {
      version: "1.2.1",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "updateInProgress" });

    await rm(join(dirs.updates, "status.json"));
    await writeFile(requestFile(), "pending");
    res = await send("POST", "/api/instance/updates/apply", {
      version: "1.2.1",
    });
    expect(await res.json()).toMatchObject({ code: "updateInProgress" });
    expect(await readRequest()).toBe("pending");
  });
});

describe("POST /api/instance/backups/:id/restore", () => {
  it("refuses a wrong confirmation (confirmMismatch)", async () => {
    for (const confirm of ["", "Opsdeck", "opsdeck "]) {
      const res = await send(
        "POST",
        `/api/instance/backups/${BACKUP_ID}/restore`,
        { confirm }
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "confirmMismatch" });
    }
    expect(await readdir(dirs.updates)).toEqual([]);
  });

  it("writes a restore request with the manifest's version", async () => {
    const res = await send(
      "POST",
      `/api/instance/backups/${BACKUP_ID}/restore`,
      { confirm: "opsdeck" }
    );
    expect(res.status).toBe(202);
    expect(await readRequest()).toMatch(
      new RegExp(
        `^\\{"action":"restore","objectKey":"local:opsdeck/${BACKUP_NAME.replace(/\./g, "\\.")}/","version":"1\\.1\\.0","requestedBy":"[0-9a-f-]+","requestedAt":"[^"]+"\\}\\n$`
      )
    );
  });

  it("uses the S3 key as is", async () => {
    state.results[`select:${T.backups}`] = [
      backupRow({ location: "s3", objectKey: "opsdeck-backups/opsdeck/x/" }),
    ];
    // No destination configured: the manifest cannot be read.
    const res = await send(
      "POST",
      `/api/instance/backups/${BACKUP_ID}/restore`,
      { confirm: "opsdeck" }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "restoreNotFound" });
  });

  it("refuses a backup taken with another SECRETS_KEY", async () => {
    await writeLocalManifest("1.1.0", "0123456789abcdef");
    const res = await send(
      "POST",
      `/api/instance/backups/${BACKUP_ID}/restore`,
      { confirm: "opsdeck" }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "restoreKeyMismatch" });
    expect(await readdir(dirs.updates)).toEqual([]);
  });

  it("refuses a failed backup and an unknown one", async () => {
    state.results[`select:${T.backups}`] = [
      backupRow({ status: "failed", objectKey: null }),
    ];
    let res = await send("POST", `/api/instance/backups/${BACKUP_ID}/restore`, {
      confirm: "opsdeck",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "restoreNotFound" });
    state.results[`select:${T.backups}`] = [];
    res = await send("POST", `/api/instance/backups/${BACKUP_ID}/restore`, {
      confirm: "opsdeck",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/instance/updates/restore-safety-backup", () => {
  it("restores the safety backup named by a restoreFailed status", async () => {
    await writeFile(
      join(dirs.updates, "status.json"),
      JSON.stringify(
        status({
          action: "restore",
          version: "1.1.0",
          step: "health",
          state: "failed",
          code: "restoreFailed",
          finishedAt: "2026-11-09T20:05:00Z",
          safetyBackup: {
            id: null,
            location: "local",
            objectKey: `opsdeck/${BACKUP_NAME}/`,
          },
        })
      )
    );
    const res = await send(
      "POST",
      "/api/instance/updates/restore-safety-backup",
      { confirm: "opsdeck" }
    );
    expect(res.status).toBe(202);
    expect(await readRequest()).toContain(
      `"action":"restore","objectKey":"local:opsdeck/${BACKUP_NAME}/"`
    );
  });

  it("refuses without a restoreFailed status", async () => {
    const res = await send(
      "POST",
      "/api/instance/updates/restore-safety-backup",
      { confirm: "opsdeck" }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "restoreNotFound" });
  });
});

describe("runInstanceUpdateCheck (hourly job)", () => {
  // 03:00 in Asia/Jakarta (UTC+7) is 20:00 UTC.
  const inWindow = new Date("2026-11-09T20:00:00Z");
  const outside = new Date("2026-11-09T22:00:00Z");

  it("writes the apply request inside the window when available", async () => {
    state.results[`select:${T.settings}`] = [settingsRow({ autoUpdate: true })];
    expect(await runInstanceUpdateCheck(inWindow)).toEqual({
      requested: "1.2.1",
    });
    expect(await readRequest()).toContain(
      '"action":"update","version":"1.2.1","requestedBy":"auto-update"'
    );
    expect(state.checkCalls.at(-1)).toMatchObject({ force: true });
  });

  it("does nothing outside the window, when off, or with nothing available", async () => {
    state.results[`select:${T.settings}`] = [settingsRow({ autoUpdate: true })];
    expect(await runInstanceUpdateCheck(outside)).toEqual({ requested: null });
    state.results[`select:${T.settings}`] = [
      settingsRow({ autoUpdate: false }),
    ];
    expect(await runInstanceUpdateCheck(inWindow)).toEqual({ requested: null });
    state.results[`select:${T.settings}`] = [settingsRow({ autoUpdate: true })];
    state.check = { available: null, error: null, checkedAt: new Date() };
    expect(await runInstanceUpdateCheck(inWindow)).toEqual({ requested: null });
    expect(await readdir(dirs.updates)).toEqual([]);
  });

  it("never writes while a run is in progress or after that version failed", async () => {
    state.results[`select:${T.settings}`] = [settingsRow({ autoUpdate: true })];
    await writeFile(
      join(dirs.updates, "status.json"),
      JSON.stringify(status({ startedAt: "2026-11-09T19:30:00Z" }))
    );
    expect(await runInstanceUpdateCheck(inWindow)).toEqual({ requested: null });
    await writeFile(
      join(dirs.updates, "status.json"),
      JSON.stringify(
        status({
          state: "rolled_back",
          code: "healthFailed",
          finishedAt: "2026-11-09T20:05:00Z",
        })
      )
    );
    expect(await runInstanceUpdateCheck(inWindow)).toEqual({ requested: null });
    expect(await readdir(dirs.updates)).toEqual(["status.json"]);
  });

  it("is not held off by a stale running status of another version", async () => {
    state.results[`select:${T.settings}`] = [settingsRow({ autoUpdate: true })];
    await writeFile(
      join(dirs.updates, "status.json"),
      JSON.stringify(
        status({ version: "1.2.0-beta.1", startedAt: "2026-11-09T18:49:00Z" })
      )
    );
    expect(await runInstanceUpdateCheck(inWindow)).toEqual({
      requested: "1.2.1",
    });
  });
});

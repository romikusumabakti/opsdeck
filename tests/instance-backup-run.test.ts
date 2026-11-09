import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BackupDeps,
  BackupError,
  type BackupRecorder,
  runInstanceBackup,
} from "@/lib/instance-backup/archive";
import {
  type BackupDestination,
  backupS3Client,
  type ObjectStore,
  s3ObjectStore,
} from "@/lib/instance-backup/destination";
import {
  parseManifest,
  secretsKeyFingerprint,
} from "@/lib/instance-backup/manifest";

const SECRETS_KEY = "c2VjcmV0LWtleS1uZXZlci1pbi1hLWJhY2t1cC0xMjM0NTY=";
const NOW = new Date(Date.UTC(2026, 10, 9, 19, 30, 5));
const PREFIX = "opsdeck-backups/test/2026-11-09T193005.000Z-abc123-1.2.3/";

function memoryStore(initial: Record<string, string> = {}) {
  const objects = new Map<string, Buffer>(
    Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)])
  );
  const uploads: string[] = [];
  const store: ObjectStore = {
    async list(prefix) {
      return [...objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, body]) => ({ key, size: body.length }));
    },
    async download(key, filePath) {
      const body = objects.get(key);
      if (!body) throw new Error(`no such key ${key}`);
      await writeFile(filePath, body);
      return body.length;
    },
    async upload(key, filePath) {
      objects.set(key, await readFile(filePath));
      uploads.push(key);
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
  };
  return { store, objects, uploads };
}

function memoryRecorder() {
  const rows: Record<string, Record<string, unknown>> = {};
  const fingerprints: string[] = [];
  const sweeps: Date[] = [];
  const recorder: BackupRecorder = {
    async start(row) {
      const id = `run-${Object.keys(rows).length + 1}`;
      rows[id] = { ...row, status: "running" };
      return id;
    },
    async finish(id, patch) {
      rows[id] = { ...rows[id], ...patch };
    },
    async recordFingerprint(fingerprint) {
      fingerprints.push(fingerprint);
    },
    async markInterrupted(before) {
      sweeps.push(before);
      for (const row of Object.values(rows)) {
        if (row.status === "running" && (row.startedAt as Date) < before) {
          Object.assign(row, {
            status: "failed",
            errorCode: "backupInterrupted",
          });
        }
      }
    },
  };
  return { recorder, rows, fingerprints, sweeps };
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();
}

let root: string;
let garage: ReturnType<typeof memoryStore>;
let recorded: ReturnType<typeof memoryRecorder>;

function deps(overrides: Partial<BackupDeps> = {}): Partial<BackupDeps> {
  return {
    recorder: recorded.recorder,
    lock: async () => async () => {},
    destination: async () => null,
    garage: garage.store,
    dumpDatabase: async (filePath) => {
      await writeFile(filePath, "PGDMP fake dump");
      return { sha256: "d".repeat(64), bytes: 15 };
    },
    localRoot: root,
    instance: "test",
    version: "1.2.3",
    secretsKey: SECRETS_KEY,
    now: () => NOW,
    runSuffix: () => "abc123",
    log: () => {},
    ...overrides,
  };
}

function destination(
  store: ObjectStore,
  keep: Partial<BackupDestination> = {}
): BackupDeps["destination"] {
  return async () => ({ store, keepDaily: 14, keepWeekly: 8, ...keep });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "instance-backup-"));
  garage = memoryStore({
    "attachments/a.png": "png bytes",
    "issues/b/c.txt": "text",
  });
  recorded = memoryRecorder();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runInstanceBackup", () => {
  it("upload failure keeps local copy", async () => {
    const remote = memoryStore();
    remote.store.upload = async () => {
      throw new Error("PutObject rejected");
    };

    const result = await runInstanceBackup(
      "update",
      deps({ destination: destination(remote.store) })
    );

    expect(result).toEqual({
      id: "run-1",
      status: "failed",
      location: "local",
      objectKey: "test/2026-11-09T193005.000Z-abc123-1.2.3/",
      errorCode: "backupUploadFailed",
    });
    const local = join(root, "test/2026-11-09T193005.000Z-abc123-1.2.3");
    expect(await filesUnder(local)).toEqual([
      "database.dump",
      "garage/attachments/a.png",
      "garage/issues/b/c.txt",
      "manifest.json",
    ]);
    expect(recorded.rows["run-1"]).toMatchObject({
      trigger: "update",
      version: "1.2.3",
      status: "failed",
      errorCode: "backupUploadFailed",
    });
  });

  it("no destination writes local", async () => {
    // Four older complete backups, a fresh incomplete one (a run that may
    // still be going) and an incomplete one from a crash two days ago.
    for (const name of [
      "2026-11-05T193000Z-1.2.2",
      "2026-11-06T193000Z-1.2.2",
      "2026-11-07T193000Z-1.2.3",
      "2026-11-08T193000Z-1.2.3",
    ]) {
      await mkdir(join(root, "test", name), { recursive: true });
      await writeFile(join(root, "test", name, "manifest.json"), "{}");
    }
    await mkdir(join(root, "test/2026-11-09T120000.000Z-f00001-1.2.3"));
    await mkdir(join(root, "test/2026-11-07T120000.000Z-f00002-1.2.3"));

    const result = await runInstanceBackup("schedule", deps());

    expect(result).toMatchObject({
      status: "succeeded",
      location: "local",
      objectKey: "test/2026-11-09T193005.000Z-abc123-1.2.3/",
      errorCode: null,
    });
    expect((await readdir(join(root, "test"))).sort()).toEqual([
      "2026-11-07T193000Z-1.2.3",
      "2026-11-08T193000Z-1.2.3",
      "2026-11-09T120000.000Z-f00001-1.2.3",
      "2026-11-09T193005.000Z-abc123-1.2.3",
    ]);
    const dir = join(root, "test/2026-11-09T193005.000Z-abc123-1.2.3");
    const manifest = parseManifest(
      await readFile(join(dir, "manifest.json"), "utf8")
    );
    expect(manifest).toEqual({
      format: 1,
      version: "1.2.3",
      createdAt: NOW.toISOString(),
      database: { file: "database.dump", sha256: "d".repeat(64), bytes: 15 },
      garage: { objects: 2, bytes: 13 },
      secretsKeyFingerprint: secretsKeyFingerprint(SECRETS_KEY),
    });
    expect(recorded.rows["run-1"]).toMatchObject({
      location: "local",
      status: "succeeded",
      sizeBytes: expect.any(Number),
    });
    expect(recorded.fingerprints).toEqual([secretsKeyFingerprint(SECRETS_KEY)]);
  });

  it("uploads to the destination, manifest last, then applies retention", async () => {
    const remote = memoryStore({
      // 2026-11-09 already has an older backup: retention keeps the newest.
      "opsdeck-backups/test/2026-11-09T010000Z-1.2.2/manifest.json": "{}",
      "opsdeck-backups/test/2026-11-09T010000Z-1.2.2/database.dump": "old",
      "opsdeck-backups/test/2026-11-08T010000Z-1.2.2/manifest.json": "{}",
      "opsdeck-backups/other/2026-11-09T010000Z-1.2.2/manifest.json": "{}",
      // Incomplete: one fresh (kept), one from a crash two days ago (deleted).
      "opsdeck-backups/test/2026-11-09T120000.000Z-f00001-1.2.3/database.dump":
        "x",
      "opsdeck-backups/test/2026-11-07T120000.000Z-f00002-1.2.3/database.dump":
        "x",
    });

    const result = await runInstanceBackup(
      "manual",
      deps({ destination: destination(remote.store, { keepDaily: 2 }) })
    );

    expect(result).toEqual({
      id: "run-1",
      status: "succeeded",
      location: "s3",
      objectKey: PREFIX,
      errorCode: null,
    });
    expect(remote.uploads).toEqual([
      `${PREFIX}database.dump`,
      `${PREFIX}garage/attachments/a.png`,
      `${PREFIX}garage/issues/b/c.txt`,
      `${PREFIX}manifest.json`,
    ]);
    expect([...remote.objects.keys()].sort()).toEqual([
      "opsdeck-backups/other/2026-11-09T010000Z-1.2.2/manifest.json",
      "opsdeck-backups/test/2026-11-08T010000Z-1.2.2/manifest.json",
      "opsdeck-backups/test/2026-11-09T120000.000Z-f00001-1.2.3/database.dump",
      `${PREFIX}database.dump`,
      `${PREFIX}garage/attachments/a.png`,
      `${PREFIX}garage/issues/b/c.txt`,
      `${PREFIX}manifest.json`,
    ]);
    // The local staging copy goes once the upload has succeeded.
    expect(await readdir(join(root, "test"))).toEqual([]);
  });

  it("records a dump failure", async () => {
    const result = await runInstanceBackup(
      "manual",
      deps({
        dumpDatabase: async () => {
          throw new BackupError("backupDumpFailed");
        },
      })
    );
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "backupDumpFailed",
    });
    expect(recorded.rows["run-1"]).toMatchObject({ status: "failed" });
  });

  it("records a Garage failure", async () => {
    garage.store.download = async () => {
      throw new Error("NoSuchKey");
    };
    const result = await runInstanceBackup("manual", deps());
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "backupGarageFailed",
    });
  });

  it("refuses a Garage key that leaves the backup folder", async () => {
    garage = memoryStore({ "../escape": "x" });
    const result = await runInstanceBackup("manual", deps());
    expect(result).toMatchObject({ errorCode: "backupGarageFailed" });
    expect(await filesUnder(root)).not.toContain("escape");
  });

  it.each([
    [0, 0],
    [0, 1],
  ])(
    "retention (%i, %i) never deletes the backup just uploaded",
    async (keepDaily, keepWeekly) => {
      const remote = memoryStore({
        "opsdeck-backups/test/2026-11-08T010000Z-1.2.2/manifest.json": "{}",
        "opsdeck-backups/test/2026-11-01T010000Z-1.2.2/manifest.json": "{}",
      });
      const result = await runInstanceBackup(
        "manual",
        deps({
          destination: destination(remote.store, { keepDaily, keepWeekly }),
        })
      );
      expect(result.status).toBe("succeeded");
      const keys = [...remote.objects.keys()];
      expect(keys).toContain(`${PREFIX}manifest.json`);
      expect(keys).toContain(`${PREFIX}database.dump`);
      expect(keys).not.toContain(
        "opsdeck-backups/test/2026-11-01T010000Z-1.2.2/manifest.json"
      );
    }
  );

  it("gives two runs in the same second their own folders", async () => {
    const remote = memoryStore();
    const suffixes = ["aaaaaa", "bbbbbb"];
    const run = () =>
      runInstanceBackup(
        "manual",
        deps({
          destination: destination(remote.store),
          runSuffix: () => suffixes.shift() ?? "",
        })
      );
    const [a, b] = await Promise.all([run(), run()]);
    expect(a?.status).toBe("succeeded");
    expect(b?.status).toBe("succeeded");
    expect(a?.objectKey).not.toBe(b?.objectKey);
    // Both uploaded in full (retention may then keep only the day's newest).
    for (const r of [a, b]) {
      expect(remote.uploads).toContain(`${r?.objectKey}manifest.json`);
      expect(remote.uploads).toContain(`${r?.objectKey}database.dump`);
    }
  });

  it("fails a colliding folder name instead of sharing it", async () => {
    const dir = join(root, "test/2026-11-09T193005.000Z-abc123-1.2.3");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), "{}");

    const result = await runInstanceBackup("manual", deps());

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "backupWriteFailed",
      objectKey: null,
    });
    // The other run's folder is untouched.
    expect(await filesUnder(dir)).toEqual(["manifest.json"]);
  });

  it("skips zero-byte Garage folder markers", async () => {
    garage = memoryStore({ "attachments/": "", "attachments/a.png": "png" });
    const result = await runInstanceBackup("manual", deps());
    expect(result.status).toBe("succeeded");
    const dir = join(root, "test/2026-11-09T193005.000Z-abc123-1.2.3");
    expect(await filesUnder(join(dir, "garage"))).toEqual([
      "attachments/a.png",
    ]);
  });

  it("still returns the row id and location when recording the end fails", async () => {
    recorded.recorder.finish = async () => {
      throw new Error("connection reset");
    };
    const ok = await runInstanceBackup("manual", deps());
    expect(ok).toMatchObject({
      id: "run-1",
      status: "failed",
      location: "local",
      errorCode: "backupRecordFailed",
    });

    const remote = memoryStore();
    remote.store.upload = async () => {
      throw new Error("PutObject rejected");
    };
    const failed = await runInstanceBackup(
      "manual",
      deps({
        destination: destination(remote.store),
        now: () => new Date(NOW.getTime() + 1000),
      })
    );
    expect(failed).toMatchObject({
      id: "run-2",
      status: "failed",
      location: "local",
      errorCode: "backupUploadFailed",
    });
  });

  it("reports the declared location when the run cannot be recorded", async () => {
    recorded.recorder.start = async () => {
      throw new Error("database is down");
    };
    const remote = memoryStore();
    await expect(
      runInstanceBackup(
        "update",
        deps({ destination: destination(remote.store) })
      )
    ).rejects.toMatchObject({ name: "BackupRecordError", location: "s3" });
  });

  it("marks rows left running for over 6 h as interrupted", async () => {
    const hours = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    recorded.rows.crashed = { status: "running", startedAt: hours(7) };
    recorded.rows.busy = { status: "running", startedAt: hours(1) };

    await runInstanceBackup("manual", deps());

    expect(recorded.sweeps).toEqual([hours(6)]);
    expect(recorded.rows.crashed).toMatchObject({
      status: "failed",
      errorCode: "backupInterrupted",
    });
    expect(recorded.rows.busy).toMatchObject({ status: "running" });
  });

  it("never writes SECRETS_KEY", async () => {
    process.env.SECRETS_KEY = SECRETS_KEY;
    try {
      const remote = memoryStore();
      await runInstanceBackup(
        "manual",
        deps({ destination: destination(remote.store) })
      );
      await runInstanceBackup(
        "manual",
        deps({ now: () => new Date(NOW.getTime() + 1000) })
      );

      const written: Buffer[] = [...remote.objects.values()];
      for (const file of await filesUnder(root)) {
        written.push(await readFile(join(root, file)));
      }
      expect(written.length).toBeGreaterThan(4);
      for (const body of written) {
        expect(body.toString("utf8")).not.toContain(SECRETS_KEY);
        expect(body.toString("base64")).not.toContain(SECRETS_KEY);
      }
    } finally {
      delete process.env.SECRETS_KEY;
    }
  });
});

describe("opsdeck backup run arguments", () => {
  it("defaults to a manual trigger and accepts --trigger", async () => {
    const { parseBackupArgs } = await import("@/scripts/cli/backup");
    expect(parseBackupArgs(["run"])).toBe("manual");
    expect(parseBackupArgs(["run", "--trigger", "update"])).toBe("update");
    expect(parseBackupArgs(["run", "--trigger", "nightly"])).toBeNull();
    expect(parseBackupArgs(["list"])).toBeNull();
    expect(parseBackupArgs([])).toBeNull();
  });
});

describe("s3ObjectStore uploads", () => {
  type Seen = { method: string; path: string; query: Record<string, unknown> };

  // A fake S3 behind the real client: answers PutObject and the multipart
  // calls, after `throttle` 429 SlowDown answers.
  function fakeS3(throttle = 0) {
    const seen: Seen[] = [];
    let throttled = 0;
    const requestHandler = {
      async handle(request: {
        method: string;
        path: string;
        query: Record<string, unknown>;
        body?: unknown;
      }) {
        const body = request.body;
        if (body && typeof (body as Readable).pipe === "function") {
          for await (const _ of body as Readable) {
            // drain
          }
        }
        seen.push({
          method: request.method,
          path: request.path,
          query: request.query,
        });
        const reply = (statusCode: number, text = "", headers = {}) => ({
          response: {
            statusCode,
            headers: { "content-type": "application/xml", ...headers },
            body: Readable.from([Buffer.from(text)]),
          },
        });
        if (throttled < throttle) {
          throttled += 1;
          return reply(
            429,
            "<Error><Code>SlowDown</Code><Message>Slow down</Message></Error>"
          );
        }
        if (request.method === "POST" && "uploads" in request.query) {
          return reply(
            200,
            "<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><UploadId>u1</UploadId></InitiateMultipartUploadResult>"
          );
        }
        if (request.method === "POST" && "uploadId" in request.query) {
          return reply(
            200,
            '<CompleteMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><ETag>"e"</ETag></CompleteMultipartUploadResult>'
          );
        }
        return reply(200, "", { etag: '"e"' });
      },
      updateHttpClientConfig() {},
      httpHandlerConfigs() {
        return {};
      },
    };
    const client = backupS3Client(
      {
        endpoint: "http://s3.test",
        region: "us-east-1",
        forcePathStyle: true,
        accessKeyId: "test",
        secretAccessKey: "test",
      },
      { requestHandler: requestHandler as never }
    );
    return { store: s3ObjectStore(client, "b"), seen };
  }

  it("retries a throttled (429) upload with backoff", async () => {
    const file = join(root, "small");
    await writeFile(file, "small body");
    const s3 = fakeS3(2);
    await s3.store.upload("k", file);
    expect(s3.seen.map((r) => r.method)).toEqual(["PUT", "PUT", "PUT"]);
  });

  it("uploads a file larger than one part as multipart", async () => {
    const file = join(root, "large");
    await writeFile(file, Buffer.alloc(17 * 1024 * 1024, 1));
    const s3 = fakeS3();
    await s3.store.upload("k", file);
    const parts = s3.seen.filter((r) => "partNumber" in r.query);
    expect(parts).toHaveLength(2);
    expect(s3.seen[0]?.query).toHaveProperty("uploads");
    expect(s3.seen.at(-1)?.query).toHaveProperty("uploadId");
  });
});

describe("one backup at a time", () => {
  // An in-memory stand-in for the advisory lock.
  function memoryLock() {
    let held = false;
    const releases: number[] = [];
    const lock: BackupDeps["lock"] = async () => {
      if (held) return null;
      held = true;
      return async () => {
        held = false;
        releases.push(Date.now());
      };
    };
    return { lock, releases, isHeld: () => held };
  }

  it("records nothing and reports alreadyRunning when the lock is taken", async () => {
    const result = await runInstanceBackup(
      "manual",
      deps({ lock: async () => null })
    );
    expect(result).toEqual({
      id: null,
      status: "alreadyRunning",
      location: null,
      objectKey: null,
      errorCode: "backupAlreadyRunning",
    });
    expect(recorded.rows).toEqual({});
    // The stale-row sweep only runs under the lock.
    expect(recorded.sweeps).toEqual([]);
  });

  it("lets exactly one of two concurrent runs through", async () => {
    const lock = memoryLock();
    const [a, b] = await Promise.all([
      runInstanceBackup("schedule", deps({ lock: lock.lock })),
      runInstanceBackup("manual", deps({ lock: lock.lock })),
    ]);
    expect([a.status, b.status].sort()).toEqual([
      "alreadyRunning",
      "succeeded",
    ]);
    expect(Object.keys(recorded.rows)).toHaveLength(1);
    expect(lock.releases).toHaveLength(1);
    expect(lock.isHeld()).toBe(false);
  });

  it("a lock failure names the location the run would use", async () => {
    const down = async () => {
      throw new Error("connection refused");
    };
    const remote = memoryStore();
    await expect(
      runInstanceBackup(
        "manual",
        deps({ lock: down, destination: destination(remote.store) })
      )
    ).rejects.toMatchObject({ name: "BackupRecordError", location: "s3" });
    await expect(
      runInstanceBackup("manual", deps({ lock: down }))
    ).rejects.toMatchObject({ name: "BackupRecordError", location: "local" });
    expect(recorded.rows).toEqual({});
  });

  it("releases the lock after a failed run", async () => {
    const lock = memoryLock();
    const result = await runInstanceBackup(
      "manual",
      deps({
        lock: lock.lock,
        dumpDatabase: async () => {
          throw new Error("boom");
        },
      })
    );
    expect(result.status).toBe("failed");
    expect(lock.isHeld()).toBe(false);
  });
});

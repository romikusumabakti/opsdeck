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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BackupDeps,
  BackupError,
  type BackupRecorder,
  runInstanceBackup,
} from "@/lib/instance-backup/archive";
import type {
  BackupDestination,
  ObjectStore,
} from "@/lib/instance-backup/destination";
import {
  parseManifest,
  secretsKeyFingerprint,
} from "@/lib/instance-backup/manifest";

const SECRETS_KEY = "c2VjcmV0LWtleS1uZXZlci1pbi1hLWJhY2t1cC0xMjM0NTY=";
const NOW = new Date(Date.UTC(2026, 10, 9, 19, 30, 5));
const PREFIX = "opsdeck-backups/test/2026-11-09T193005Z-1.2.3/";

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
  };
  return { recorder, rows, fingerprints };
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
      objectKey: "test/2026-11-09T193005Z-1.2.3/",
      errorCode: "backupUploadFailed",
    });
    const local = join(root, "test/2026-11-09T193005Z-1.2.3");
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
    // Four older complete backups and one without a manifest (incomplete).
    for (const name of [
      "2026-11-05T193000Z-1.2.2",
      "2026-11-06T193000Z-1.2.2",
      "2026-11-07T193000Z-1.2.3",
      "2026-11-08T193000Z-1.2.3",
    ]) {
      await mkdir(join(root, "test", name), { recursive: true });
      await writeFile(join(root, "test", name, "manifest.json"), "{}");
    }

    const result = await runInstanceBackup("schedule", deps());

    expect(result).toMatchObject({
      status: "succeeded",
      location: "local",
      objectKey: "test/2026-11-09T193005Z-1.2.3/",
      errorCode: null,
    });
    expect((await readdir(join(root, "test"))).sort()).toEqual([
      "2026-11-07T193000Z-1.2.3",
      "2026-11-08T193000Z-1.2.3",
      "2026-11-09T193005Z-1.2.3",
    ]);
    const dir = join(root, "test/2026-11-09T193005Z-1.2.3");
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

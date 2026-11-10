import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectStore } from "@/lib/instance-backup/destination";
import {
  type BackupManifest,
  secretsKeyFingerprint,
  serializeManifest,
} from "@/lib/instance-backup/manifest";
import {
  type BackupSource,
  localBackupSource,
  PG_RESTORE_FLAGS,
  pgRestoreDatabase,
  type RestoreDatabase,
  type RestoreDeps,
  runRestore,
  SwapOutcomeUnknownError,
  s3BackupSource,
  suffixed,
} from "@/lib/instance-backup/restore";
import { RESTORE_REFUSED_EXIT } from "@/lib/updates/request";
import { parseRestoreArgs, restoreExitCode } from "@/scripts/cli/restore";

const KEY = Buffer.alloc(32, 7).toString("base64");
const DUMP = Buffer.from("PGDMP fake custom-format dump");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "restore-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Writes a complete local backup; returns its `local:` key. */
async function localBackup(
  overrides: Partial<BackupManifest> = {},
  files: Record<string, string> = { "a/one.txt": "one", "b/two.txt": "two!" }
): Promise<string> {
  const rel = "opsdeck/2026-11-09T193000.000Z-abc123-1.2.0";
  const dir = join(root, "backups", rel);
  await mkdir(join(dir, "garage"), { recursive: true });
  await writeFile(join(dir, "database.dump"), DUMP);
  let bytes = 0;
  for (const [key, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "garage", key)), { recursive: true });
    await writeFile(join(dir, "garage", key), text);
    bytes += Buffer.byteLength(text);
  }
  const manifest: BackupManifest = {
    format: 1,
    version: "1.2.0",
    createdAt: "2026-11-09T19:30:00.000Z",
    database: {
      file: "database.dump",
      sha256: createHash("sha256").update(DUMP).digest("hex"),
      bytes: DUMP.length,
    },
    garage: { objects: Object.keys(files).length, bytes },
    secretsKeyFingerprint: secretsKeyFingerprint(KEY),
    ...overrides,
  };
  await writeFile(join(dir, "manifest.json"), serializeManifest(manifest));
  return `local:${rel}/`;
}

/** An in-memory object store. */
function memoryStore(initial: Record<string, Buffer> = {}) {
  const objects = new Map(Object.entries(initial));
  const store: ObjectStore & { objects: Map<string, Buffer> } = {
    objects,
    async list(prefix) {
      return [...objects]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, body]) => ({ key, size: body.length }));
    },
    async download(key, filePath) {
      const body = objects.get(key);
      if (!body) throw new Error(`NoSuchKey ${key}`);
      await writeFile(filePath, body);
      return body.length;
    },
    async read(key) {
      const body = objects.get(key);
      if (!body) throw new Error(`NoSuchKey ${key}`);
      return Readable.from([body]);
    },
    async upload(key, filePath) {
      const { readFile } = await import("node:fs/promises");
      objects.set(key, await readFile(filePath));
    },
    async delete(keys) {
      for (const k of keys) objects.delete(k);
    },
  };
  return store;
}

function fakeDatabase() {
  const calls: string[] = [];
  const db: RestoreDatabase & { calls: string[] } = {
    calls,
    prepare: vi.fn(async (dumpPath: string) => {
      calls.push(`prepare ${dumpPath.endsWith("database.dump")}`);
    }),
    swap: vi.fn(async () => {
      calls.push("swap");
    }),
    dropPrevious: vi.fn(async () => {
      calls.push("dropPrevious");
    }),
    close: vi.fn(async () => {
      calls.push("close");
    }),
  };
  return db;
}

function deps(over: Partial<RestoreDeps> = {}): RestoreDeps & {
  database: ReturnType<typeof fakeDatabase>;
  garage: ReturnType<typeof memoryStore>;
} {
  return {
    version: "1.2.0",
    secretsKey: KEY,
    openSource: async (key: string) =>
      localBackupSource(join(root, "backups"), key.slice("local:".length)),
    garage: memoryStore({ "stale/orphan.txt": Buffer.from("old") }),
    database: fakeDatabase(),
    stagingRoot: join(root, "staging"),
    log: () => {},
    ...over,
  } as never;
}

describe("opsdeck restore arguments", () => {
  it("takes exactly one object key", () => {
    expect(parseRestoreArgs(["local:opsdeck/x/"])).toBe("local:opsdeck/x/");
    expect(parseRestoreArgs([])).toBeNull();
    expect(parseRestoreArgs(["a", "b"])).toBeNull();
    expect(parseRestoreArgs(["--clean"])).toBeNull();
    expect(parseRestoreArgs(["local:../etc/"])).toBeNull();
  });

  it("maps results to the update.sh exit-code contract", () => {
    expect(restoreExitCode("restored")).toBe(0);
    expect(restoreExitCode("refused")).toBe(RESTORE_REFUSED_EXIT);
    expect(RESTORE_REFUSED_EXIT).toBe(3);
    expect(restoreExitCode("failed")).toBe(1);
  });
});

describe("runRestore refusals (nothing written)", () => {
  it("refuses a checksum mismatch", async () => {
    const key = await localBackup({
      database: {
        file: "database.dump",
        sha256: "0".repeat(64),
        bytes: DUMP.length,
      },
    });
    const d = deps();
    const result = await runRestore(key, d);
    expect(result).toEqual({
      status: "refused",
      errorCode: "restoreChecksumMismatch",
      version: "1.2.0",
    });
    expect(d.database.prepare).not.toHaveBeenCalled();
    expect([...d.garage.objects.keys()]).toEqual(["stale/orphan.txt"]);
  });

  it("refuses when the stored files differ from the manifest", async () => {
    const key = await localBackup({ garage: { objects: 3, bytes: 7 } });
    const d = deps();
    expect(await runRestore(key, d)).toMatchObject({
      status: "refused",
      errorCode: "restoreChecksumMismatch",
    });
    expect(d.database.prepare).not.toHaveBeenCalled();
  });

  it("refuses a SECRETS_KEY fingerprint mismatch", async () => {
    const key = await localBackup();
    const other = Buffer.alloc(32, 9).toString("base64");
    for (const secretsKey of [other, undefined]) {
      const d = deps({ secretsKey });
      expect(await runRestore(key, d)).toMatchObject({
        status: "refused",
        errorCode: "restoreKeyMismatch",
      });
      expect(d.database.prepare).not.toHaveBeenCalled();
    }
  });

  it("refuses a manifest version other than the running one", async () => {
    const key = await localBackup();
    const d = deps({ version: "1.3.0" });
    expect(await runRestore(key, d)).toMatchObject({
      status: "refused",
      errorCode: "restoreVersionMismatch",
    });
    expect(d.database.prepare).not.toHaveBeenCalled();
  });

  it("refuses a missing backup and a path outside the backups dir", async () => {
    const d = deps();
    expect(await runRestore("local:opsdeck/nope/", d)).toMatchObject({
      status: "refused",
      errorCode: "restoreNotFound",
    });
    expect(await runRestore("local:../../etc/", d)).toMatchObject({
      status: "refused",
      errorCode: "restoreNotFound",
    });
    // A folder without a manifest is an incomplete backup.
    await mkdir(join(root, "backups/opsdeck/partial"), { recursive: true });
    expect(await runRestore("local:opsdeck/partial/", d)).toMatchObject({
      status: "refused",
      errorCode: "restoreNotFound",
    });
  });

  it("refuses (untouched) when building the new database fails", async () => {
    const key = await localBackup();
    const database = fakeDatabase();
    database.prepare = vi.fn(async () => {
      throw new Error("pg_restore exited 1");
    });
    const d = deps({ database });
    expect(await runRestore(key, d)).toMatchObject({
      status: "refused",
      errorCode: "restoreDatabaseFailed",
    });
    expect(database.swap).not.toHaveBeenCalled();
    expect([...d.garage.objects.keys()]).toEqual(["stale/orphan.txt"]);
  });

  it("refuses when the backup has stored files but Garage is not set up", async () => {
    const key = await localBackup();
    const d = deps({ garage: null });
    expect(await runRestore(key, d)).toMatchObject({
      status: "refused",
      errorCode: "restoreGarageUnavailable",
    });
  });
});

describe("runRestore success", () => {
  it("rebuilds the database, swaps it in and mirrors the stored files", async () => {
    const key = await localBackup();
    const d = deps();
    expect(await runRestore(key, d)).toEqual({
      status: "restored",
      errorCode: null,
      version: "1.2.0",
    });
    expect(d.database.calls).toEqual([
      "prepare true",
      "swap",
      "dropPrevious",
      "close",
    ]);
    // Exactly the backup's objects: the orphan is gone.
    expect(
      Object.fromEntries(
        [...d.garage.objects].map(([k, v]) => [k, v.toString()])
      )
    ).toEqual({ "a/one.txt": "one", "b/two.txt": "two!" });
  });

  it("downloads an S3 backup into staging, then removes the staging copy", async () => {
    const local = await localBackup();
    const rel = local.slice("local:".length);
    const dir = join(root, "backups", rel);
    const prefix = `opsdeck-backups/${rel}`;
    const { readFile } = await import("node:fs/promises");
    const remote = memoryStore({
      [`${prefix}database.dump`]: await readFile(join(dir, "database.dump")),
      [`${prefix}garage/a/one.txt`]: Buffer.from("one"),
      [`${prefix}garage/b/two.txt`]: Buffer.from("two!"),
      [`${prefix}manifest.json`]: await readFile(join(dir, "manifest.json")),
    });
    const d = deps({ openSource: async (k) => s3BackupSource(remote, k) });
    expect(await runRestore(prefix, d)).toMatchObject({ status: "restored" });
    expect(d.garage.objects.get("b/two.txt")?.toString()).toBe("two!");
    expect(await readdir(join(root, "staging")).catch(() => [])).toEqual([]);
  });

  it("fails (exit 1 territory) when the stored files cannot be written after the swap", async () => {
    const key = await localBackup();
    const garage = memoryStore();
    garage.upload = async () => {
      throw new Error("garage down");
    };
    const d = deps({ garage });
    expect(await runRestore(key, d)).toMatchObject({
      status: "failed",
      errorCode: "restoreGarageFailed",
    });
    expect(d.database.swap).toHaveBeenCalled();
  });
});

describe("pgRestoreDatabase", () => {
  it("restores into a scratch database with the exact pg_restore flags", async () => {
    const spawned: { cmd: string[]; env: Record<string, string> }[] = [];
    const statements: string[] = [];
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push(strings.join("?"));
        void values;
        return [
          {
            enc: "UTF8",
            datcollate: "en_US.utf8",
            datctype: "en_US.utf8",
            datlocprovider: "c",
            loc: null,
            owner: "opsdeck",
          },
        ];
      },
      {
        unsafe: async (text: string) => {
          statements.push(text);
          return [];
        },
        begin: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ unsafe: async (text: string) => statements.push(text) }),
        end: async () => {},
      }
    );
    const database = pgRestoreDatabase(
      "postgres://opsdeck:s3cr%40t@postgres:5432/opsdeck",
      {
        connect: () => sql as never,
        spawn: (cmd, env) => {
          spawned.push({ cmd, env });
          return Promise.resolve({ exitCode: 0, stderr: "" });
        },
      }
    );
    await database.prepare("/stage/database.dump");
    await database.swap();
    await database.dropPrevious();
    await database.close();

    expect(PG_RESTORE_FLAGS).toEqual(["--clean", "--if-exists", "--no-owner"]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.cmd).toEqual([
      "pg_restore",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--exit-on-error",
      "-d",
      "opsdeck_restore",
      "/stage/database.dump",
    ]);
    // The credentials go through libpq's env, never argv.
    expect(spawned[0]?.cmd.join(" ")).not.toContain("s3cr");
    expect(spawned[0]?.env).toMatchObject({
      PGHOST: "postgres",
      PGUSER: "opsdeck",
      PGPASSWORD: "s3cr@t",
      PGDATABASE: "opsdeck_restore",
    });
    const all = statements.join("\n");
    expect(all).toContain('CREATE DATABASE "opsdeck_restore"');
    expect(all).toContain(
      'ALTER DATABASE "opsdeck" RENAME TO "opsdeck_pre_restore"'
    );
    expect(all).toContain(
      'ALTER DATABASE "opsdeck_restore" RENAME TO "opsdeck"'
    );
    expect(all).toContain('DROP DATABASE IF EXISTS "opsdeck_pre_restore"');
  });

  it("fails prepare when pg_restore exits non-zero", async () => {
    const sql = Object.assign(
      async () => [
        {
          enc: "UTF8",
          datcollate: "C",
          datctype: "C",
          datlocprovider: "c",
          loc: null,
          owner: "opsdeck",
        },
      ],
      { unsafe: async () => [], end: async () => {} }
    );
    const database = pgRestoreDatabase("postgres://u:p@h/opsdeck", {
      connect: () => sql as never,
      spawn: () => Promise.resolve({ exitCode: 1, stderr: "boom\nlast line" }),
    });
    await expect(database.prepare("/x/database.dump")).rejects.toThrow(
      /pg_restore exited 1: last line/
    );
  });
});

describe("sources", () => {
  it("a local source reads the manifest in place", async () => {
    const key = await localBackup();
    const source: BackupSource = localBackupSource(
      join(root, "backups"),
      key.slice("local:".length)
    );
    expect(JSON.parse(await source.readManifest(root))).toMatchObject({
      version: "1.2.0",
    });
  });
});

describe("swap outcome and names", () => {
  /** A fake admin connection whose begin() drops the connection. */
  function droppingSql(after: () => unknown[]) {
    let connections = 0;
    const connect = () => {
      connections += 1;
      const first = connections === 1;
      return Object.assign(async () => (first ? [] : after()), {
        unsafe: async () => [],
        begin: async () => {
          throw Object.assign(new Error("write CONNECTION_CLOSED"), {
            code: "CONNECTION_CLOSED",
          });
        },
        end: async () => {},
      }) as never;
    };
    return { connect, count: () => connections };
  }

  it("treats a dropped COMMIT as done when pg_database shows the swap", async () => {
    const swapped = droppingSql(() => [{ datname: "opsdeck" }]);
    const database = pgRestoreDatabase("postgres://u:p@h/opsdeck", {
      connect: swapped.connect,
    });
    await expect(database.swap()).resolves.toBeUndefined();
    expect(swapped.count()).toBe(2);
  });

  it("rethrows when pg_database shows the swap did not happen", async () => {
    const notSwapped = droppingSql(() => [
      { datname: "opsdeck" },
      { datname: "opsdeck_restore" },
    ]);
    const database = pgRestoreDatabase("postgres://u:p@h/opsdeck", {
      connect: notSwapped.connect,
    });
    await expect(database.swap()).rejects.toThrow(/CONNECTION_CLOSED/);
  });

  it("reports an unknown outcome when pg_database cannot be read", async () => {
    const unreadable = droppingSql(() => {
      throw new Error("still down");
    });
    const database = pgRestoreDatabase("postgres://u:p@h/opsdeck", {
      connect: unreadable.connect,
    });
    await expect(database.swap()).rejects.toBeInstanceOf(
      SwapOutcomeUnknownError
    );
  });

  it("an unknown swap outcome makes the run failed (exit 1), not refused", async () => {
    const key = await localBackup();
    const database = fakeDatabase();
    database.swap = vi.fn(async () => {
      throw new SwapOutcomeUnknownError("connection lost");
    });
    expect(await runRestore(key, deps({ database }))).toMatchObject({
      status: "failed",
      errorCode: "restoreFailed",
    });
  });

  it("cuts names by bytes, never inside a UTF-8 sequence", () => {
    // 31 two-byte characters and an "a": 63 bytes, 32 characters.
    const name = `${"é".repeat(31)}a`;
    expect(Buffer.byteLength(name)).toBe(63);
    const scratch = suffixed(name, "_restore");
    expect(Buffer.byteLength(scratch)).toBeLessThanOrEqual(63);
    expect(scratch).toBe(`${"é".repeat(27)}_restore`);
    expect(suffixed(name, "_pre_restore")).toBe(
      `${"é".repeat(25)}_pre_restore`
    );
  });

  it("refuses a multibyte 63-byte name whose scratch name would be itself", async () => {
    // 27 × "é" + "a" is 55 bytes: by characters the old cut kept the whole
    // name, and Postgres would have truncated `<name>_restore` back to it.
    const name = `${"é".repeat(27)}a_restore`;
    expect(Buffer.byteLength(name)).toBe(63);
    const database = pgRestoreDatabase(
      `postgres://u:p@h/${encodeURIComponent(name)}`,
      {
        connect: () => {
          throw new Error("must not connect");
        },
      }
    );
    await expect(database.prepare("/x/database.dump")).rejects.toThrow(
      /distinct scratch names/
    );
  });

  it("refuses a database name that leaves no room for distinct scratch names", async () => {
    const name = `${"a".repeat(55)}_restore`;
    expect(name).toHaveLength(63);
    const database = pgRestoreDatabase(`postgres://u:p@h/${name}`, {
      connect: () => {
        throw new Error("must not connect");
      },
    });
    await expect(database.prepare("/x/database.dump")).rejects.toThrow(
      /distinct scratch names/
    );
  });
});

describe("staging failures", () => {
  it("a full disk while staging is restoreStagingFailed, not restoreNotFound", async () => {
    const key = await localBackup();
    const real = localBackupSource(
      join(root, "backups"),
      key.slice("local:".length)
    );
    const d = deps({
      openSource: async () => ({
        readManifest: real.readManifest,
        stage: async () => {
          throw Object.assign(new Error("no space left on device"), {
            code: "ENOSPC",
          });
        },
      }),
    });
    expect(await runRestore(key, d)).toMatchObject({
      status: "refused",
      errorCode: "restoreStagingFailed",
    });
  });
});

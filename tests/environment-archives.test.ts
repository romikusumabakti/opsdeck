import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Admin → Instance → Backups, "Deleted environments": the archives a
// teardown kept, listed and downloaded by org instance:manage, and the daily
// prune that deletes them after their retention.

const ARCHIVE_ID = "0197f3a0-1b2c-7def-8000-0123456789d1";
const S3_ARCHIVE_ID = "0197f3a0-1b2c-7def-8000-0123456789d2";

type Row = {
  id: string;
  environmentId: string | null;
  projectName: string;
  environmentName: string;
  environmentSlug: string;
  deletedById: string | null;
  createdAt: Date;
  expiresAt: Date;
  location: "local" | "s3";
  s3ConnectionId: string | null;
  keyPrefix: string;
  files: { name: string; size: number }[];
  completedAt: Date | null;
};

const state = vi.hoisted(() => ({
  role: "admin" as string,
  root: "",
  rows: [] as Row[],
  prunable: [] as Row[],
  removedRows: [] as string[],
  connectionGone: false,
  objects: new Map<string, Buffer>(),
  listed: [] as string[],
  deletedKeys: [] as string[][],
  deleteError: null as Error | null,
  reads: [] as string[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({
    user: { id: "user-1", role: state.role },
    session: { signInMethod: "passkey" },
  }),
  getServerSession: async () => ({
    user: { id: "user-1", role: state.role },
    session: { signInMethod: "passkey" },
  }),
}));

// The org guards read projects and memberships for a caller the org role denies.
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  db: {
    select: () => ({
      from: () => Object.assign(Promise.resolve([]), { where: async () => [] }),
    }),
  },
}));

vi.mock("@/lib/instance-backup/archive", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get LOCAL_BACKUP_ROOT() {
    return state.root;
  },
  instanceName: () => "opsdeck-test",
}));

// The archive's own S3 connection "conn-1" (whatever today's backup
// destination is), loadable unless `connectionGone`.
vi.mock("@/lib/instance-backup/destination", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadBackupDestination: async () => {
    throw new Error("an archive never reads today's destination");
  },
  loadS3ConnectionStore: async (id: string) =>
    id === "conn-1" && !state.connectionGone
      ? {
          list: async (prefix: string) => {
            state.listed.push(prefix);
            return [...state.objects.entries()]
              .filter(([key]) => key.startsWith(prefix))
              .map(([key, body]) => ({ key, size: body.length }));
          },
          read: async (key: string) => {
            state.reads.push(key);
            const body = state.objects.get(key);
            if (!body) throw new Error("NoSuchKey");
            return Readable.from([body]);
          },
          download: async () => 0,
          upload: async () => {},
          delete: async (keys: string[]) => {
            if (state.deleteError) throw state.deleteError;
            state.deletedKeys.push(keys);
            for (const key of keys) state.objects.delete(key);
          },
        }
      : null,
}));

const repo = vi.hoisted(() => ({
  listArchives: vi.fn(async () => state.rows),
  getArchive: vi.fn(
    async (id: string) => state.rows.find((r) => r.id === id) ?? null
  ),
  listPrunableArchives: vi.fn(async () => state.prunable),
  deleteArchiveRow: vi.fn(async (id: string) => {
    state.removedRows.push(id);
  }),
}));
vi.mock("@/lib/teardown/repository", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...repo,
}));

const { app } = await import("@/server/app");
const { pruneEnvironmentArchives } = await import(
  "@/server/services/environment-archives"
);
const { localArchiveDir } = await import("@/lib/teardown/archive");

const DAY = 86_400_000;
const NOW = new Date("2026-11-10T03:00:00Z");

function row(extra: Partial<Row> = {}): Row {
  const id = extra.id ?? ARCHIVE_ID;
  return {
    id,
    environmentId: null,
    projectName: "HRIS",
    environmentName: "HRIS Dev",
    environmentSlug: "dev",
    deletedById: "user-1",
    createdAt: new Date("2026-11-01T00:00:00Z"),
    expiresAt: new Date("2026-12-01T00:00:00Z"),
    location: "local",
    s3ConnectionId: null,
    keyPrefix: `${localArchiveDir("opsdeck-test", id, state.root)}/`,
    files: [{ name: "db-hris-0123456789.dump", size: 10 }],
    completedAt: new Date("2026-11-01T00:05:00Z"),
    ...extra,
  };
}

function s3Row(extra: Partial<Row> = {}): Row {
  return row({
    id: S3_ARCHIVE_ID,
    location: "s3",
    s3ConnectionId: "conn-1",
    keyPrefix: `opsdeck-env-archives/opsdeck-test/${S3_ARCHIVE_ID}/`,
    ...extra,
  });
}

/** Writes the archive's files under its local dir. */
function writeLocal(archive: Row, body = "local dump") {
  const dir = archive.keyPrefix.replace(/\/$/, "");
  mkdirSync(dir, { recursive: true });
  for (const file of archive.files) writeFileSync(join(dir, file.name), body);
  return dir;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.role = "admin";
  state.root = mkdtempSync(join(tmpdir(), "env-archives-test-"));
  state.rows = [];
  state.prunable = [];
  state.removedRows = [];
  state.connectionGone = false;
  state.objects = new Map();
  state.listed = [];
  state.deletedKeys = [];
  state.deleteError = null;
  state.reads = [];
});

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true });
});

describe("GET /api/instance/environment-archives", () => {
  it("lists the archives for an admin", async () => {
    state.rows = [row()];
    const res = await app.request("/api/instance/environment-archives");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        id: ARCHIVE_ID,
        projectName: "HRIS",
        environmentName: "HRIS Dev",
        createdAt: "2026-11-01T00:00:00.000Z",
        expiresAt: "2026-12-01T00:00:00.000Z",
        completedAt: "2026-11-01T00:05:00.000Z",
        files: [{ name: "db-hris-0123456789.dump", size: 10 }],
      },
    ]);
  });

  it("is 403 without instance:manage, for the list and a download", async () => {
    state.rows = [row()];
    writeLocal(state.rows[0] as Row);
    for (const role of ["infra", "engineer", "qa", "observer"]) {
      state.role = role;
      expect(
        (await app.request("/api/instance/environment-archives")).status
      ).toBe(403);
      expect(
        (
          await app.request(
            `/api/instance/environment-archives/${ARCHIVE_ID}/files/db-hris-0123456789.dump`
          )
        ).status
      ).toBe(403);
    }
    expect(repo.listArchives).not.toHaveBeenCalled();
    expect(repo.getArchive).not.toHaveBeenCalled();
  });
});

describe("GET /api/instance/environment-archives/:id/files/:name", () => {
  it("streams a local file as an attachment", async () => {
    const archive = row();
    state.rows = [archive];
    writeLocal(archive, "local dump");
    const res = await app.request(
      `/api/instance/environment-archives/${ARCHIVE_ID}/files/db-hris-0123456789.dump`
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(
      "attachment; filename*=UTF-8''db-hris-0123456789.dump"
    );
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(await res.text()).toBe("local dump");
  });

  it("streams an S3 file from the archive's key", async () => {
    const archive = s3Row();
    state.rows = [archive];
    state.objects.set(
      `${archive.keyPrefix}db-hris-0123456789.dump`,
      Buffer.from("s3 dump 10")
    );
    const res = await app.request(
      `/api/instance/environment-archives/${S3_ARCHIVE_ID}/files/db-hris-0123456789.dump`
    );
    expect(res.status).toBe(200);
    // The size the archive row lists.
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(await res.text()).toBe("s3 dump 10");
    expect(state.reads).toEqual([
      `opsdeck-env-archives/opsdeck-test/${S3_ARCHIVE_ID}/db-hris-0123456789.dump`,
    ]);
  });

  it("serves only names the archive lists", async () => {
    const archive = row();
    state.rows = [archive];
    const dir = writeLocal(archive);
    // On disk beside the listed file, but not listed.
    writeFileSync(join(dir, ".db-hris-0123456789.dump.partial"), "partial");
    for (const name of [
      ".db-hris-0123456789.dump.partial",
      "other.dump",
      "..%2F..%2Fetc%2Fpasswd",
      "%2Fetc%2Fpasswd",
    ]) {
      const res = await app.request(
        `/api/instance/environment-archives/${ARCHIVE_ID}/files/${name}`
      );
      expect(res.status).toBe(404);
    }
    const unknown = await app.request(
      `/api/instance/environment-archives/${S3_ARCHIVE_ID}/files/db-hris-0123456789.dump`
    );
    expect(unknown.status).toBe(404);
  });

  it("never reads outside the backup root, even for a listed name", async () => {
    state.rows = [
      row({ keyPrefix: "/etc/", files: [{ name: "passwd", size: 1 }] }),
    ];
    const res = await app.request(
      `/api/instance/environment-archives/${ARCHIVE_ID}/files/passwd`
    );
    expect(res.status).toBe(404);
  });

  it("answers 404 backupDestinationNotFound once the archive's S3 connection is gone", async () => {
    for (const archive of [s3Row({ s3ConnectionId: null }), s3Row()]) {
      state.rows = [archive];
      state.connectionGone = true;
      const res = await app.request(
        `/api/instance/environment-archives/${S3_ARCHIVE_ID}/files/db-hris-0123456789.dump`
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        code: "backupDestinationNotFound",
      });
    }
    expect(state.reads).toEqual([]);
  });
});

describe("pruneEnvironmentArchives", () => {
  it("asks for archives past expiry and open ones older than 30 days", async () => {
    await pruneEnvironmentArchives(NOW);
    expect(repo.listPrunableArchives).toHaveBeenCalledWith(
      NOW,
      new Date(NOW.getTime() - 30 * DAY)
    );
  });

  it("deletes the objects, then the row, of each archive it is given", async () => {
    const local = row({ expiresAt: new Date(NOW.getTime() - DAY) });
    const s3 = s3Row({ expiresAt: new Date(NOW.getTime() - DAY) });
    const dir = writeLocal(local);
    state.objects.set(
      `${s3.keyPrefix}db-hris-0123456789.dump`,
      Buffer.from("x")
    );
    state.objects.set(`${s3.keyPrefix}deploy-x.tar.gz`, Buffer.from("y"));
    state.objects.set(
      "opsdeck-env-archives/opsdeck-test/other/keep",
      Buffer.from("z")
    );
    state.prunable = [local, s3];

    expect(await pruneEnvironmentArchives(NOW)).toEqual({
      deleted: 2,
      failed: 0,
    });
    expect(existsSync(dir)).toBe(false);
    expect(state.listed).toEqual([s3.keyPrefix]);
    expect(state.deletedKeys).toEqual([
      [
        `${s3.keyPrefix}db-hris-0123456789.dump`,
        `${s3.keyPrefix}deploy-x.tar.gz`,
      ],
    ]);
    expect([...state.objects.keys()]).toEqual([
      "opsdeck-env-archives/opsdeck-test/other/keep",
    ]);
    expect(state.removedRows).toEqual([ARCHIVE_ID, S3_ARCHIVE_ID]);
  });

  it("keeps the row when its objects could not be deleted", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const archive = s3Row();
    state.prunable = [archive];
    state.objects.set(`${archive.keyPrefix}db.dump`, Buffer.from("x"));
    state.deleteError = new Error("S3 down");
    expect(await pruneEnvironmentArchives(NOW)).toEqual({
      deleted: 0,
      failed: 1,
    });
    expect(state.removedRows).toEqual([]);

    errors.mockRestore();
  });

  it("keeps the rows of S3 archives whose connection is gone, logging once", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    state.connectionGone = true;
    state.prunable = [
      s3Row(),
      s3Row({
        id: ARCHIVE_ID,
        s3ConnectionId: null,
        keyPrefix: `opsdeck-env-archives/opsdeck-test/${ARCHIVE_ID}/`,
      }),
    ];
    expect(await pruneEnvironmentArchives(NOW)).toEqual({
      deleted: 0,
      failed: 2,
    });
    expect(state.removedRows).toEqual([]);
    expect(state.listed).toEqual([]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain("2 ");
    errors.mockRestore();
  });

  it("never deletes a local path outside the backup root", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const outside = mkdtempSync(join(tmpdir(), "env-archives-outside-"));
    try {
      state.prunable = [
        row({ keyPrefix: `${outside}/` }),
        row({ keyPrefix: `${state.root}/../x/env-archives/${ARCHIVE_ID}/` }),
        s3Row({ keyPrefix: "opsdeck-backups/opsdeck-test/" }),
      ];
      expect(await pruneEnvironmentArchives(NOW)).toEqual({
        deleted: 0,
        failed: 3,
      });
      expect(existsSync(outside)).toBe(true);
      expect(state.listed).toEqual([]);
      expect(state.removedRows).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      errors.mockRestore();
    }
  });

  it("removes the row of a local archive whose dir is already gone", async () => {
    state.prunable = [row()];
    expect(await pruneEnvironmentArchives(NOW)).toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(state.removedRows).toEqual([ARCHIVE_ID]);
  });
});

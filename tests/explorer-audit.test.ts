import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// File explorer audit: every successful write and download records one
// activity event for the signed-in user; failures and reads record none.

const SERVER_ID = "0197f3a0-1b2c-7def-8000-000000000001";
const BUCKET_ID = "0197f3a0-1b2c-7def-8000-0000000000b1";
const sftp = { kind: "sftp", serverId: SERVER_ID } as const;
const s3 = { kind: "s3", connectionId: BUCKET_ID } as const;

const state = vi.hoisted(() => ({
  activity: [] as Record<string, unknown>[],
  fail: false,
  presigned: false,
}));

vi.mock("@/lib/activity", () => ({
  recordActivity: vi.fn(async (entry: Record<string, unknown>) => {
    state.activity.push(entry);
  }),
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({ user: { id: "u1", role: "member" } }),
}));
vi.mock("@/lib/restricted-targets", () => ({
  authorizeExplorerSource: async () => ({ user: { id: "u1" } }),
}));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));
vi.mock("@/lib/explorer", () => {
  const act = async () => {
    if (state.fail) throw new Error("boom");
  };
  const backend = {
    list: async () => [],
    stat: async () => ({ name: "a", path: "a", type: "file", sizeBytes: 1 }),
    readStream: async () => {
      await act();
      return Readable.from(["x"]);
    },
    writeStream: async (_p: string, body: Readable) => {
      await act();
      body.resume();
    },
    downloadTarget: async () =>
      state.presigned
        ? { kind: "presigned", url: "https://example.test/x" }
        : { kind: "proxy" },
    remove: act,
    mkdir: act,
    rename: act,
    copy: act,
  };
  return {
    resolveBackend: async () => backend,
    targetName: async (source: { kind: string }) =>
      source.kind === "s3" ? "assets-bucket" : "web-1",
  };
});

const { explorerRouter } = await import("@/server/routes/explorer");
const explorer = await import("@/server/services/explorer");

beforeEach(() => {
  state.activity = [];
  state.fail = false;
  state.presigned = false;
});

const q = (source: unknown, extra = "") =>
  `?source=${encodeURIComponent(JSON.stringify(source))}${extra}`;

describe("explorer audit", () => {
  it("records one event per successful service action", async () => {
    await explorer.saveFileText(sftp, "etc/a.conf", "x", "lf");
    await explorer.createFolder(sftp, "etc", "new");
    await explorer.deleteEntry(s3, "old.txt");
    await explorer.renameEntry(sftp, "a.txt", "b.txt");
    await explorer.moveEntry(sftp, "a.txt", "dir/");
    await explorer.copyEntry(sftp, "a.txt", "dir/");
    await explorer.compressEntries(sftp, ["a.txt", "b.txt"], "", "bundle");

    expect(state.activity.map((e) => e.action)).toEqual([
      "files.save",
      "files.createFolder",
      "files.delete",
      "files.rename",
      "files.move",
      "files.copy",
      "files.compress",
    ]);
    for (const entry of state.activity) expect(entry.actorId).toBe("u1");
    expect(state.activity[0]).toMatchObject({
      entityType: "server",
      entityId: SERVER_ID,
      data: { target: "web-1", path: "etc/a.conf" },
    });
    expect(state.activity[2]).toMatchObject({
      entityType: "s3Connection",
      entityId: BUCKET_ID,
      data: { target: "assets-bucket", path: "old.txt" },
    });
    expect(state.activity[3]?.data).toEqual({
      target: "web-1",
      path: "a.txt",
      to: "b.txt",
    });
    expect(state.activity[6]?.data).toEqual({
      target: "web-1",
      path: "a.txt",
      count: 2,
      archive: "bundle.zip",
    });
  });

  it("records nothing when the action fails", async () => {
    state.fail = true;
    const results = [
      await explorer.saveFileText(sftp, "a.txt", "x", "lf"),
      await explorer.createFolder(sftp, "", "new"),
      await explorer.deleteEntry(sftp, "a.txt"),
      await explorer.renameEntry(sftp, "a.txt", "b.txt"),
      await explorer.moveEntry(sftp, "a.txt", "dir/"),
      await explorer.copyEntry(sftp, "a.txt", "dir/"),
    ];
    for (const r of results) expect(r.success).toBe(false);
    expect(state.activity).toEqual([]);
  });

  it("records nothing for reads or a move that changes nothing", async () => {
    await explorer.listEntries(sftp, "");
    await explorer.readFileText(sftp, "a.txt");
    await explorer.folderStats(sftp, "");
    await explorer.getDownloadTarget(sftp, "a.txt");
    await explorer.moveEntry(sftp, "a.txt", "");
    expect(state.activity).toEqual([]);
  });

  it("logs a presigned download target but not a proxy marker", async () => {
    await explorer.getDownloadTarget(s3, "a.txt");
    expect(state.activity).toEqual([]);
    state.presigned = true;
    await explorer.getDownloadTarget(s3, "a.txt");
    expect(state.activity).toEqual([
      expect.objectContaining({
        action: "files.download",
        actorId: "u1",
        data: { target: "assets-bucket", path: "a.txt" },
      }),
    ]);
  });

  it("records the proxy download, archive and upload routes", async () => {
    expect(
      (await explorerRouter.request(`/download${q(sftp, "&path=a.txt")}`))
        .status
    ).toBe(200);
    const archive = await explorerRouter.request(
      `/archive${q(sftp, "&path=a.txt&path=b.txt")}`
    );
    expect(archive.status).toBe(200);
    // Drain the lazy zip stream so it finishes before the next test.
    await archive.arrayBuffer();
    const form = new FormData();
    form.set("file", new File(["x"], "up.txt"));
    form.set("source", JSON.stringify(sftp));
    form.set("path", "inbox");
    const up = await explorerRouter.request("/upload", {
      method: "POST",
      body: form,
    });
    expect(up.status).toBe(200);

    expect(state.activity.map((e) => [e.action, e.data])).toEqual([
      ["files.download", { target: "web-1", path: "a.txt" }],
      ["files.download", { target: "web-1", path: "a.txt", count: 2 }],
      ["files.upload", { target: "web-1", path: "inbox/up.txt" }],
    ]);
  });

  it("records no route event when the transfer fails", async () => {
    state.fail = true;
    const res = await explorerRouter.request(
      `/download${q(sftp, "&path=a.txt")}`
    );
    expect(res.status).toBe(500);
    const form = new FormData();
    form.set("file", new File(["x"], "up.txt"));
    form.set("source", JSON.stringify(sftp));
    const up = await explorerRouter.request("/upload", {
      method: "POST",
      body: form,
    });
    expect(up.status).toBe(500);
    expect(state.activity).toEqual([]);
  });
});

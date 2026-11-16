import { existsSync } from "node:fs";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { HTTPException } from "hono/http-exception";
import tar from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureSnapshot,
  evictSnapshots,
  SnapshotUnavailableError,
} from "@/lib/assistant/snapshot";
import type { AssistantSource } from "@/lib/assistant/sources";

const SHA = "a".repeat(40);
const AUTH = { username: "u", token: "t" };

type Entry = {
  name: string;
  content?: string | Buffer;
  type?: "file" | "symlink" | "link" | "directory";
  linkname?: string;
};

async function makeArchive(entries: Entry[]): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    pack.on("data", (c) => chunks.push(c as Buffer));
    pack.on("end", resolve);
    pack.on("error", reject);
  });
  for (const e of entries) {
    const type = e.type ?? "file";
    if (type === "file") {
      pack.entry({ name: e.name, type }, e.content ?? "");
    } else {
      pack.entry({ name: e.name, type, linkname: e.linkname });
    }
  }
  pack.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}

const archiveEntries: Entry[] = [
  { name: "repo-abc/", type: "directory" },
  { name: "repo-abc/src/app.ts", content: "export const a = 1;\n" },
  { name: "repo-abc/README.md", content: "# hi\n" },
  { name: "repo-abc/.env", content: "API_KEY=abcdef1234567890\n" },
  { name: "repo-abc/certs/app.pem", content: "-----BEGIN PRIVATE KEY-----\n" },
  { name: "repo-abc/../evil", content: "pwned" },
  { name: "/abs/evil", content: "pwned" },
  { name: "repo-abc/link", type: "symlink", linkname: "/etc/passwd" },
  { name: "repo-abc/hard", type: "link", linkname: "repo-abc/README.md" },
  { name: "repo-abc/docs/big.txt", content: "x".repeat(5 * 1024 * 1024 + 1) },
  { name: "repo-abc/bin/blob.dat", content: Buffer.from([1, 0, 2, 0, 3]) },
];

function source(over: Partial<AssistantSource> = {}): AssistantSource {
  return {
    componentKey: "backend",
    repoFullName: "acme/widgets",
    ciConnectionId: "conn-1",
    commitSha: SHA,
    ref: "main",
    deployed: true,
    deployedAt: null,
    ...over,
  };
}

let root: string;
let archive: Buffer;
let fetchImpl: ReturnType<typeof vi.fn>;
let archiveCalls: { url: string; auth: string | null }[];
const getCredentials = vi.fn<
  (id: string) => Promise<{ forge: string; auth: typeof AUTH | null }>
>(async () => ({ forge: "bitbucket", auth: AUTH }));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "assistant-snapshot-"));
  archive = await makeArchive(archiveEntries);
  archiveCalls = [];
  getCredentials.mockClear();
  fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/refs/branches/")) {
      return Response.json({ target: { hash: "b".repeat(40) } });
    }
    archiveCalls.push({
      url,
      auth: new Headers(init?.headers).get("authorization"),
    });
    await new Promise((r) => setTimeout(r, 10));
    return new Response(new Uint8Array(archive));
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const deps = () => ({
  root,
  fetchImpl: fetchImpl as unknown as typeof fetch,
  getCredentials,
});

describe("ensureSnapshot", () => {
  it("extracts allowed files, strips the top folder and never writes secrets", async () => {
    const out = await ensureSnapshot(source(), deps());
    expect(out.commitSha).toBe(SHA);
    expect(out.dir).toBe(join(root, "acme__widgets", SHA));
    expect(await readFile(join(out.dir, "src/app.ts"), "utf8")).toBe(
      "export const a = 1;\n"
    );
    expect(existsSync(join(out.dir, ".env"))).toBe(false);
    expect(existsSync(join(out.dir, "certs/app.pem"))).toBe(false);
    expect(existsSync(join(out.dir, "bin/blob.dat"))).toBe(false);
    const withheld = JSON.parse(
      await readFile(join(out.dir, ".withheld.json"), "utf8")
    ) as string[];
    expect(withheld).toEqual(
      expect.arrayContaining([".env", "certs/app.pem", "bin/blob.dat"])
    );
    expect(out.withheld).toBe(withheld.length);
    expect(existsSync(join(out.dir, ".ready"))).toBe(true);
  });

  it("withholds an entry just over 5 MiB without writing it", async () => {
    const out = await ensureSnapshot(source(), deps());
    expect(existsSync(join(out.dir, "docs/big.txt"))).toBe(false);
    const withheld = JSON.parse(
      await readFile(join(out.dir, ".withheld.json"), "utf8")
    ) as string[];
    expect(withheld).toContain("docs/big.txt");
  });

  it("maps a deleted connection to no-connection", async () => {
    getCredentials.mockRejectedValueOnce(
      new HTTPException(404, { message: "Not Found" })
    );
    await expect(ensureSnapshot(source(), deps())).rejects.toMatchObject({
      reason: "no-connection",
    });
  });

  it("cuts a stalled body and frees the key for a retry", async () => {
    fetchImpl.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array(archive.subarray(0, 20)));
            },
          })
        )
    );
    const stalled = { ...deps(), timeouts: { idleMs: 50, totalMs: 5000 } };
    await expect(ensureSnapshot(source(), stalled)).rejects.toThrow(
      "timed out"
    );
    expect(await readdir(join(root, "acme__widgets"))).toEqual([]);
    const retry = await ensureSnapshot(source(), deps());
    expect(existsSync(join(retry.dir, ".ready"))).toBe(true);
  });

  it("caps the total download time even when data keeps trickling", async () => {
    let sent = 0;
    fetchImpl.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(c) {
              await new Promise((r) => setTimeout(r, 10));
              // One real byte at a time: never idle, never finished.
              c.enqueue(new Uint8Array(archive.subarray(sent, ++sent)));
            },
          })
        )
    );
    const slow = { ...deps(), timeouts: { idleMs: 1000, totalMs: 100 } };
    await expect(ensureSnapshot(source(), slow)).rejects.toThrow("timed out");
  });

  it("skips traversal, absolute, symlink and hardlink entries", async () => {
    const out = await ensureSnapshot(source(), deps());
    const files = (await readdir(out.dir, { recursive: true })).sort();
    expect(files).not.toContain("evil");
    expect(files).not.toContain("link");
    expect(files).not.toContain("hard");
    expect(existsSync(join(root, "acme__widgets", "evil"))).toBe(false);
    expect(existsSync(join(root, "evil"))).toBe(false);
    expect(existsSync("/abs/evil")).toBe(false);
  });

  it("does not refetch a ready snapshot and reports the withheld count", async () => {
    const first = await ensureSnapshot(source(), deps());
    const second = await ensureSnapshot(source(), deps());
    expect(archiveCalls).toHaveLength(1);
    expect(second).toEqual(first);
    expect(second.withheld).toBeGreaterThan(0);
  });

  it("fetches once for concurrent callers", async () => {
    const [a, b] = await Promise.all([
      ensureSnapshot(source(), deps()),
      ensureSnapshot(source(), deps()),
    ]);
    expect(archiveCalls).toHaveLength(1);
    expect(a.dir).toBe(b.dir);
  });

  it("sends the Basic credentials to the archive endpoint", async () => {
    await ensureSnapshot(source(), deps());
    expect(archiveCalls[0]?.url).toBe(
      `https://bitbucket.org/acme/widgets/get/${SHA}.tar.gz`
    );
    expect(archiveCalls[0]?.auth).toBe(
      `Basic ${Buffer.from("u:t").toString("base64")}`
    );
  });

  it("resolves the branch head when the commit is unknown", async () => {
    const out = await ensureSnapshot(
      source({ commitSha: null, deployed: false }),
      deps()
    );
    expect(out.commitSha).toBe("b".repeat(40));
    expect(archiveCalls[0]?.url).toContain(`/get/${"b".repeat(40)}.tar.gz`);
  });

  it("refreshes .used on every call", async () => {
    const out = await ensureSnapshot(source(), deps());
    const old = new Date(Date.now() - 5 * 86_400_000);
    await utimes(join(out.dir, ".used"), old, old);
    await ensureSnapshot(source(), deps());
    const used = (await stat(join(out.dir, ".used"))).mtimeMs;
    expect(Date.now() - used).toBeLessThan(60_000);
  });

  it("leaves nothing behind when the download fails", async () => {
    fetchImpl.mockImplementationOnce(
      async () => new Response("no", { status: 403 })
    );
    await expect(ensureSnapshot(source(), deps())).rejects.toThrow();
    const left = await readdir(join(root, "acme__widgets"));
    expect(left).toEqual([]);
    const retry = await ensureSnapshot(source(), deps());
    expect(existsSync(join(retry.dir, ".ready"))).toBe(true);
  });

  it("is unavailable without a connection, with another forge, or without credentials", async () => {
    await expect(
      ensureSnapshot(source({ ciConnectionId: null }), deps())
    ).rejects.toMatchObject({ reason: "no-connection" });
    getCredentials.mockResolvedValueOnce({ forge: "github", auth: null });
    await expect(ensureSnapshot(source(), deps())).rejects.toMatchObject({
      reason: "unsupported-forge",
    });
    getCredentials.mockResolvedValueOnce({ forge: "bitbucket", auth: null });
    const err = await ensureSnapshot(source(), deps()).catch((e) => e);
    expect(err).toBeInstanceOf(SnapshotUnavailableError);
    expect(err.reason).toBe("no-credentials");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a malformed repository name", async () => {
    await expect(
      ensureSnapshot(source({ repoFullName: "../x/y" }), deps())
    ).rejects.toThrow("Invalid repository");
  });
});

async function fakeSnapshot(
  repo: string,
  sha: string,
  ageDays: number,
  bytes = 10
) {
  const dir = join(root, repo, sha);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "f"), Buffer.alloc(bytes));
  await writeFile(join(dir, ".ready"), "");
  await writeFile(join(dir, ".used"), "");
  const when = new Date(Date.now() - ageDays * 86_400_000);
  await utimes(join(dir, ".used"), when, when);
  return dir;
}

describe("evictSnapshots", () => {
  it("removes a snapshot last used 15 days ago and keeps a recent one", async () => {
    const old = await fakeSnapshot("acme__widgets", "1".repeat(40), 15);
    const fresh = await fakeSnapshot("acme__widgets", "2".repeat(40), 1);
    expect(await evictSnapshots(new Date(), { root })).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("evicts the least recently used first when over the size cap", async () => {
    const a = await fakeSnapshot("acme__widgets", "1".repeat(40), 5, 1000);
    const b = await fakeSnapshot("acme__widgets", "2".repeat(40), 3, 1000);
    const c = await fakeSnapshot("acme__widgets", "3".repeat(40), 1, 1000);
    expect(await evictSnapshots(new Date(), { root, maxBytes: 2500 })).toBe(1);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
    expect(existsSync(c)).toBe(true);
  });

  it("never removes anything outside its own naming", async () => {
    const { mkdir } = await import("node:fs/promises");
    const old = new Date(Date.now() - 400 * 86_400_000);
    const strayDir = join(root, "backups");
    await mkdir(join(strayDir, "2020"), { recursive: true });
    await writeFile(join(strayDir, "2020", "dump.sql"), "x");
    await writeFile(join(root, "notes.txt"), "x");
    const wrongChild = join(root, "acme__widgets", "keep-me");
    await mkdir(wrongChild, { recursive: true });
    for (const p of [strayDir, join(strayDir, "2020"), wrongChild]) {
      await utimes(p, old, old);
    }
    await fakeSnapshot("acme__widgets", "1".repeat(40), 15);
    expect(await evictSnapshots(new Date(), { root })).toBe(1);
    expect(existsSync(join(strayDir, "2020", "dump.sql"))).toBe(true);
    expect(existsSync(join(root, "notes.txt"))).toBe(true);
    expect(existsSync(wrongChild)).toBe(true);
  });

  it("returns 0 when the cache root does not exist", async () => {
    expect(
      await evictSnapshots(new Date(), { root: join(root, "missing") })
    ).toBe(0);
  });
});

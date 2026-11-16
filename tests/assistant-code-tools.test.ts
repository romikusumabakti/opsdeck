import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listFiles,
  readFile,
  type SnapshotRef,
  searchCode,
} from "@/lib/assistant/tools/code";

let root: string;
let snap: SnapshotRef;

async function put(rel: string, content: string) {
  const p = join(root, "snap", rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "code-tools-"));
  await mkdir(join(root, "snap"), { recursive: true });
  snap = {
    componentKey: "api",
    dir: join(root, "snap"),
    commitSha: "a".repeat(40),
  };
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("listFiles", () => {
  it("caps at 500 paths", async () => {
    for (let i = 0; i < 501; i++) await put(`src/f${i}.ts`, "x");
    const r = await listFiles([snap], "api/src/**");
    expect(r.ok && r.data.paths.length).toBe(500);
    expect(r.ok && r.data.truncated).toBe(true);
  });

  it("hides bookkeeping and withheld files", async () => {
    await put(".ready", "");
    await put(".used", "");
    await put(".withheld.json", "[]");
    await put("src/a.ts", "x");
    await put(".env", "A=1");
    const r = await listFiles([snap], "**");
    expect(r.ok && r.data.paths).toEqual(["api/src/a.ts"]);
    expect(r.meta.withheld).toBe(1);
  });
});

describe("searchCode", () => {
  it("never returns lines from withheld files", async () => {
    await put("src/ok.ts", "const hello = 1;\n");
    await put(
      "src/leak.ts",
      `const hello = 2;\nconst token = "ghp_${"a".repeat(36)}";\n`
    );
    await put(".env", "hello=1\n");
    const r = await searchCode([snap], { pattern: "hello" });
    expect(r.ok && r.data.matches.map((m) => m.path)).toEqual([
      "api/src/ok.ts",
    ]);
    expect(JSON.stringify(r)).not.toContain("ghp_");
    expect(r.meta.withheld).toBeGreaterThanOrEqual(1);
  });

  it("returns context and stops at 100 matches", async () => {
    await put("a.ts", "l1\nfoo\nl3\n");
    const one = await searchCode([snap], { pattern: "foo" });
    expect(one.ok && one.data.matches[0]).toMatchObject({
      line: 2,
      context: ["l1", "l3"],
    });
    await put("b.ts", "foo\n".repeat(150));
    const many = await searchCode([snap], { pattern: "foo" });
    expect(many.ok && many.data.matches.length).toBe(100);
    expect(many.ok && many.data.truncated).toBe(true);
  });

  it("invalid regex is a tool error", async () => {
    const r = await searchCode([snap], { pattern: "(", regex: true });
    expect(r.ok).toBe(false);
  });

  it("treats the pattern literally unless regex, honours ignoreCase", async () => {
    await put("a.ts", "a.b\nAxB\n");
    const r = await searchCode([snap], { pattern: "a.b", ignoreCase: true });
    expect(r.ok && r.data.matches.length).toBe(1);
  });
});

describe("readFile", () => {
  it("clamps the range to totalLines and numbers lines", async () => {
    await put("a.ts", "one\ntwo\nthree\n");
    const r = await readFile([snap], {
      path: "api/a.ts",
      startLine: 2,
      endLine: 99,
    });
    expect(r.ok && r.data).toMatchObject({
      startLine: 2,
      endLine: 3,
      totalLines: 3,
      text: "2: two\n3: three",
    });
    expect(r.meta.ranges).toEqual(["api/a.ts:2-3"]);
  });

  it("caps at 400 lines", async () => {
    await put(
      "a.ts",
      Array.from({ length: 1000 }, (_, i) => `l${i}`).join("\n")
    );
    const r = await readFile([snap], { path: "api/a.ts" });
    expect(r.ok && r.data.endLine).toBe(400);
  });

  it("rejects traversal, absolute, unknown component and symlink escape", async () => {
    await writeFile(join(root, "secret.txt"), "top");
    await symlink(join(root, "secret.txt"), join(root, "snap", "link.txt"));
    for (const path of [
      "../../etc/passwd",
      "api/../../etc/passwd",
      "/etc/passwd",
      "other/a.ts",
      "api/link.txt",
    ]) {
      const r = await readFile([snap], { path });
      expect(r.ok, path).toBe(false);
    }
  });

  it("refuses withheld paths and secret content", async () => {
    await put(".env", "A=1");
    await put("src/leak.ts", `const t = "ghp_${"a".repeat(36)}";`);
    expect((await readFile([snap], { path: "api/.env" })).ok).toBe(false);
    expect((await readFile([snap], { path: "api/src/leak.ts" })).ok).toBe(
      false
    );
    expect((await readFile([snap], { path: "api/.ready" })).ok).toBe(false);
  });
});

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listFiles,
  MAX_LIST_PATHS,
  MAX_READ_BYTES,
  MAX_READ_LINES,
  MAX_SEARCH_BYTES,
  MAX_SEARCH_MATCHES,
  MAX_WITHHELD_PATHS,
  readFile,
  type SnapshotRef,
  searchCode,
  unsafeRegex,
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
  it("caps at 150 paths", async () => {
    expect(MAX_LIST_PATHS).toBe(150);
    for (let i = 0; i < 151; i++) await put(`src/f${i}.ts`, "x");
    const r = await listFiles([snap], "api/src/**");
    expect(r.ok && r.data.paths.length).toBe(150);
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
    await put(
      "src/main/resources/application.yml",
      [
        "spring:",
        "  datasource:",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Spring placeholder
        "    password: ${DB_PASSWORD}",
        "",
      ].join("\n")
    );
    await put(
      "src/main/resources/application-prod.yml",
      "spring.datasource.password: hunter2xyz\n"
    );
    const r = await searchCode([snap], { pattern: "hello" });
    expect(r.ok && r.data.matches.map((m) => m.path)).toEqual([
      "api/src/ok.ts",
    ]);
    expect(JSON.stringify(r)).not.toContain("ghp_");
    expect(r.meta.withheld).toBeGreaterThanOrEqual(1);
    for (const pattern of ["datasource", "password"]) {
      const s = await searchCode([snap], { pattern });
      expect(JSON.stringify(s)).not.toContain("hunter2xyz");
      expect(s.ok && s.data.matches.map((m) => m.path)).not.toContain(
        "api/src/main/resources/application-prod.yml"
      );
      expect(s.meta.withheld).toBeGreaterThanOrEqual(1);
    }
    const read = await readFile([snap], {
      path: "api/src/main/resources/application-prod.yml",
    });
    expect(read.ok).toBe(false);
  });

  it("caps total search output at 32 KiB", async () => {
    expect(MAX_SEARCH_BYTES).toBe(32 * 1024);
    await put("big.ts", `${"x".repeat(1500)}\n`.repeat(30));
    const r = await searchCode([snap], { pattern: "xxx" });
    expect(r.ok && r.data.truncated).toBe(true);
    expect(r.ok && r.data.matches.length).toBeLessThan(MAX_SEARCH_MATCHES);
    expect(JSON.stringify(r.ok && r.data.matches).length).toBeLessThan(
      MAX_SEARCH_BYTES
    );
  });

  it("rejects dangerous regexes and accepts ordinary ones", async () => {
    for (const p of [
      "(a+)+",
      "(a*)*",
      "(\\w+\\s?)*",
      "(a{2,})+",
      "x".repeat(201),
    ]) {
      expect(
        (await searchCode([snap], { pattern: p, regex: true })).ok,
        p
      ).toBe(false);
    }
    for (const p of [
      "foo\\(bar\\)+",
      "(foo|bar)+",
      "\\w+\\s*=",
      "(ab)?c+",
      "[(a+]+",
    ]) {
      expect(unsafeRegex(p), p).toBeNull();
    }
    // literal search is never screened
    expect((await searchCode([snap], { pattern: "(a+)+" })).ok).toBe(true);
  });

  it("returns context and stops at 40 matches", async () => {
    await put("a.ts", "l1\nfoo\nl3\n");
    const one = await searchCode([snap], { pattern: "foo" });
    expect(one.ok && one.data.matches[0]).toMatchObject({
      line: 2,
      context: ["l1", "l3"],
    });
    await put("b.ts", "foo\n".repeat(150));
    const many = await searchCode([snap], { pattern: "foo" });
    expect(MAX_SEARCH_MATCHES).toBe(40);
    expect(many.ok && many.data.matches.length).toBe(40);
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

  it("caps at 250 lines and 48 KiB", async () => {
    expect(MAX_READ_LINES).toBe(250);
    expect(MAX_READ_BYTES).toBe(48 * 1024);
    await put(
      "a.ts",
      Array.from({ length: 1000 }, (_, i) => `l${i}`).join("\n")
    );
    const r = await readFile([snap], { path: "api/a.ts" });
    expect(r.ok && r.data.endLine).toBe(250);
    await put("wide.ts", `${"y".repeat(1000)}\n`.repeat(100));
    const wide = await readFile([snap], { path: "api/wide.ts" });
    expect(wide.ok && wide.data.endLine).toBeLessThan(50);
    expect(wide.ok && wide.data.text.length).toBeLessThanOrEqual(
      MAX_READ_BYTES
    );
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

  it("refuses symlinks to withheld files, bookkeeping files and symlinked dirs", async () => {
    await put(".env", "A=1");
    await put(".withheld.json", "[]");
    await put("src/real/a.ts", "ok");
    await symlink(
      join(root, "snap", ".env"),
      join(root, "snap", "src", "alias.txt")
    );
    await symlink(
      join(root, "snap", ".withheld.json"),
      join(root, "snap", "w.txt")
    );
    await symlink(
      join(root, "snap", "src", "real"),
      join(root, "snap", "linked")
    );
    for (const path of ["api/src/alias.txt", "api/w.txt", "api/linked/a.ts"]) {
      expect((await readFile([snap], { path })).ok, path).toBe(false);
    }
    expect((await readFile([snap], { path: "api/src/real/a.ts" })).ok).toBe(
      true
    );
  });

  it("ignores non-integer line bounds and rejects directories", async () => {
    await put("src/a.ts", "one\ntwo\n");
    const r = await readFile([snap], {
      path: "api/src/a.ts",
      startLine: Number.NaN,
      endLine: 1.5,
    });
    expect(r.ok && r.data).toMatchObject({ startLine: 1, endLine: 2 });
    const d = await readFile([snap], { path: "api/src" });
    expect(d).toMatchObject({ ok: false, error: "Not a file." });
    expect(d.meta.withheld).toBeUndefined();
  });
});

describe("withheld files listed in .withheld.json", () => {
  // ensureSnapshot never writes these files; only their paths are recorded.
  const WITHHELD = [
    ".env.example",
    "backend/src/main/resources/application.yml",
    "backend/src/main/resources/application-test.yml",
    "compose.yaml",
    "docs/logo.png",
  ];
  beforeEach(async () => {
    await put(".withheld.json", JSON.stringify(WITHHELD));
    await put("backend/src/main/resources/application-prod.yml", "a: 1\n");
    await put("backend/src/main/java/App.java", "class App { int iuran; }\n");
  });

  it("list_files counts and names the matching withheld paths", async () => {
    const r = await listFiles([snap], "**/application*");
    expect(r.ok && r.data.paths).toEqual([
      "api/backend/src/main/resources/application-prod.yml",
    ]);
    expect(r.ok && r.data.withheld).toBe(2);
    expect(r.ok && r.data.withheldPaths).toEqual([
      "api/backend/src/main/resources/application.yml",
      "api/backend/src/main/resources/application-test.yml",
    ]);
    expect(r.meta.withheld).toBe(2);

    const all = await listFiles([snap], "**");
    expect(all.meta.withheld).toBe(WITHHELD.length);
    expect(all.ok && all.data.paths).not.toContain("api/.withheld.json");

    const none = await listFiles([snap], "**/*.java");
    expect(none.ok && none.data).toEqual({
      paths: ["api/backend/src/main/java/App.java"],
      truncated: false,
    });
    expect(none.meta.withheld).toBe(0);
  });

  it(`list_files names at most ${MAX_WITHHELD_PATHS} withheld paths`, async () => {
    const many = Array.from({ length: 60 }, (_, i) => `secrets/s${i}.pem`);
    await put(".withheld.json", JSON.stringify(many));
    const r = await listFiles([snap], "**");
    expect(r.meta.withheld).toBe(60);
    expect(r.ok && r.data.withheld).toBe(60);
    expect(r.ok && r.data.withheldPaths).toHaveLength(MAX_WITHHELD_PATHS);
  });

  it("search_code counts withheld paths in scope", async () => {
    const all = await searchCode([snap], { pattern: "iuran" });
    expect(all.ok && all.data.matches.map((m) => m.path)).toEqual([
      "api/backend/src/main/java/App.java",
    ]);
    expect(all.meta.withheld).toBe(WITHHELD.length);
    expect(all.ok && all.data.withheld).toBe(WITHHELD.length);

    const yml = await searchCode([snap], { pattern: "a", glob: "**/*.yml" });
    expect(yml.meta.withheld).toBe(2);
    const java = await searchCode([snap], {
      pattern: "iuran",
      glob: "**/*.java",
    });
    expect(java.meta.withheld).toBe(0);
    expect(java.ok && java.data.withheld).toBeUndefined();
  });

  it("read_file says a withheld path is withheld, not missing", async () => {
    for (const path of [
      "api/backend/src/main/resources/application.yml",
      "api/.env.example",
      "api/compose.yaml",
    ]) {
      const r = await readFile([snap], { path });
      expect(r, path).toEqual({
        ok: false,
        error:
          "File withheld: it may contain credentials (not sent to the assistant).",
        meta: { withheld: 1 },
      });
    }
    const missing = await readFile([snap], { path: "api/nope.yml" });
    expect(missing).toEqual({
      ok: false,
      error: "File not found.",
      meta: {},
    });
  });

  it("ignores a missing or malformed .withheld.json", async () => {
    await put(".withheld.json", "{not json");
    const r = await listFiles([snap], "**");
    expect(r.meta.withheld).toBe(0);
  });
});

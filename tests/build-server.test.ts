import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The runtime image ships dist/ without node_modules, so no bundle may load a
// file from this machine's node_modules (jsdom's sync-XHR worker did; see
// scripts/build-server.ts).
const nodeModules = [
  join(process.cwd(), "node_modules"),
  realpathSync(join(process.cwd(), "node_modules")),
];
const BARE_ENV = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

/**
 * Lines that load or resolve a file by its absolute node_modules path. Bundled
 * CommonJS also keeps `var __dirname = "/…/node_modules/x"` constants
 * (msgpackr-extract, ioredis, ssh2); they predate this check and are only
 * used for optional native lookups, so they are not counted.
 */
function absoluteNodeModulesRefs(code: string): string[] {
  return code
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .filter((line) =>
      nodeModules.some((dir) =>
        [
          `require.resolve("${dir}`,
          `__require("${dir}`,
          `require("${dir}`,
          `import("${dir}`,
          `from "${dir}`,
        ].some((call) => line.includes(call))
      )
    );
}

describe("server bundle (scripts/build-server.ts)", () => {
  let outDir: string;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "server-build-"));
    // The package's own step, so the test and the real build cannot drift.
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const step = String(pkg.scripts.build)
      .split("&&")
      .map((part) => part.trim())
      .find((part) => part.startsWith("bun scripts/build-server.ts"));
    expect(step).toBe("bun scripts/build-server.ts dist/server");
    const result = spawnSync(
      "sh",
      ["-c", String(step).replace("dist/server", outDir)],
      { encoding: "utf8" }
    );
    expect(result.status, result.stderr).toBe(0);
  }, 120_000);

  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it("loads no file from node_modules by absolute path", () => {
    const code = readFileSync(join(outDir, "index.js"), "utf8");
    // The sanitizer is in the bundle, and the plugin stubbed jsdom's worker.
    expect(code).toContain("uponSanitizeAttribute");
    expect(code).toContain("syncWorkerFile = null");
    expect(absoluteNodeModulesRefs(code)).toEqual([]);
  });
});

describe("sanitizer bundle", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), "svg-build-"));
    const { jsdomNoSyncXhrWorker } = await import("../scripts/build-server");
    const result = await Bun.build({
      entrypoints: ["lib/svg-sanitize.ts"],
      target: "bun",
      outdir: outDir,
      plugins: [jsdomNoSyncXhrWorker],
    });
    expect(result.success, String(result.logs)).toBe(true);
  }, 60_000);

  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  const PROBE = `const m = await import("./svg-sanitize.js");
const r = await m.sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>x</script><rect onload="x"/></svg>');
console.log(r.svg);`;
  const CLEAN =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect/></svg>';

  it("loads no node_modules file and sanitizes from outside the repo", () => {
    const code = readFileSync(join(outDir, "svg-sanitize.js"), "utf8");
    expect(absoluteNodeModulesRefs(code)).toEqual([]);
    const result = spawnSync("bun", ["-e", PROBE], {
      cwd: outDir,
      encoding: "utf8",
      env: BARE_ENV,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(CLEAN);
  });

  // The real proof: a container with only the bundle, no node_modules at all.
  it.runIf(process.env.BUILD_ISOLATED === "1")(
    "sanitizes in a container with no node_modules (BUILD_ISOLATED=1, podman)",
    () => {
      const isolated = mkdtempSync(join(tmpdir(), "svg-isolated-"));
      try {
        cpSync(
          join(outDir, "svg-sanitize.js"),
          join(isolated, "svg-sanitize.js")
        );
        const result = spawnSync(
          "podman",
          [
            "run",
            "--rm",
            "-v",
            `${isolated}:/app:ro,Z`,
            "-w",
            "/app",
            `docker.io/oven/bun:${Bun.version}`,
            "bun",
            "-e",
            PROBE,
          ],
          { encoding: "utf8" }
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(CLEAN);
      } finally {
        rmSync(isolated, { recursive: true, force: true });
      }
    },
    120_000
  );
});

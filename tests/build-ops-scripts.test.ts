import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const scripts = ["deploy-app.js", "encrypt-legacy-secrets.js"];

describe("build:ops", () => {
  let outDir: string;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "ops-build-"));
    // Reuse the package's own command so the test and the real build cannot drift.
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const command = String(pkg.scripts["build:ops"]);
    expect(command).toContain("--outdir dist");
    expect(pkg.scripts.build).toContain("build:ops");
    const result = spawnSync(
      "sh",
      ["-c", command.replace("--outdir dist", `--outdir ${outDir}`)],
      { encoding: "utf8" }
    );
    expect(result.status, result.stderr).toBe(0);
  }, 60_000);

  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it.each(scripts)("emits %s and prints usage on --help without a DB", (name) => {
    const file = join(outDir, name);
    expect(existsSync(file)).toBe(true);
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const result = spawnSync("bun", [file, "--help"], { encoding: "utf8", env });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`bun dist/${name}`);
  });
});

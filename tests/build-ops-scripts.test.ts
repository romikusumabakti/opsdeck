import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const scripts = [
  "cli.js",
  "deploy-app.js",
  "encrypt-legacy-secrets.js",
  "backfill-build-actors.js",
];

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

  it.each(scripts)(
    "emits %s and prints usage on --help without a DB",
    (name) => {
      const file = join(outDir, name);
      expect(existsSync(file)).toBe(true);
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
      };
      const result = spawnSync("bun", [file, "--help"], {
        encoding: "utf8",
        env,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`bun dist/${name}`);
    }
  );
});

describe("build:ops cli.js loads the auth module", () => {
  let outDir: string;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "ops-build-auth-"));
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const command = String(pkg.scripts["build:ops"]);
    const result = spawnSync(
      "sh",
      ["-c", command.replace("--outdir dist", `--outdir ${outDir}`)],
      { encoding: "utf8" }
    );
    expect(result.status, result.stderr).toBe(0);
  }, 60_000);

  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  // `seed demo` imports lib/auth (better-auth's passkey plugin pulls in
  // tsyringe), which needs the reflect-metadata polyfill loaded first, as
  // server/index.ts does. Without a database the run must fail on the
  // database, never on the missing polyfill.
  it("seed demo fails on the database, not on a missing reflect polyfill", () => {
    const result = spawnSync("bun", [join(outDir, "cli.js"), "seed", "demo"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
        BETTER_AUTH_SECRET: "test-secret-not-used-anywhere-000000",
        BETTER_AUTH_URL: "http://localhost:3000",
        SECRETS_KEY: Buffer.alloc(32, 1).toString("base64"),
      },
      timeout: 60_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("reflect polyfill");
  }, 90_000);
});

describe("deploy-app database failures", () => {
  it.each([
    [
      "create",
      [
        "create",
        "demo-app",
        "dss/demo-bundle",
        "--app",
        "demo",
        "--repo",
        "dss/demo",
        "--ci",
        "Woodpecker",
      ],
    ],
    ["rotate", ["rotate", "demo-app"]],
  ])(
    "%s prints no query params or ciphertext when the DB is unreachable",
    (_name, args) => {
      const result = spawnSync("bun", ["scripts/deploy-app.ts", ...args], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          DATABASE_URL: "postgres://u:p@127.0.0.1:1/none",
          SECRETS_KEY: Buffer.alloc(32, 1).toString("base64"),
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Database error (");
      for (const leak of ["enc:v1:", "params", "Failed query"]) {
        expect(result.stderr).not.toContain(leak);
        expect(result.stdout).not.toContain(leak);
      }
    },
    30_000
  );
});

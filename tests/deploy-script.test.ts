import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDeployScript, type DeployScriptInput } from "@/lib/deploy/script";

// The deploy script is what runs on a client's Compose host over SSH. Like the
// job command builders, it is tested both by asserting on the produced text
// (ordering, what it must never contain) and by running it under `sh` against
// stub `docker`/`curl` binaries on PATH.

const PRE_START_MARKER = "echo PRE_START_MARKER";

const base: DeployScriptInput = {
  registry: "192.168.10.113:5000",
  bundleImage: "dplk-accounting-deploy",
  tag: "origin-kestrel-development-abc1234",
  deployDir: "/srv/accounting",
  services: ["backend"],
  tagVariable: "IMAGE_TAG",
  preStartCommand: PRE_START_MARKER,
  healthUrl: null,
  healthTimeoutSeconds: 180,
};

describe("buildDeployScript validation", () => {
  it('rejects tag "latest" and "LATEST"', () => {
    expect(() => buildDeployScript({ ...base, tag: "latest" })).toThrow();
    expect(() => buildDeployScript({ ...base, tag: "LATEST" })).toThrow();
  });

  it("rejects tag with shell metacharacters", () => {
    expect(() => buildDeployScript({ ...base, tag: "x;rm -rf /" })).toThrow();
    expect(() => buildDeployScript({ ...base, tag: "a$(whoami)" })).toThrow();
    expect(() => buildDeployScript({ ...base, tag: "a\nb" })).toThrow();
  });

  it("rejects an over-long tag", () => {
    expect(() =>
      buildDeployScript({ ...base, tag: `a${"b".repeat(128)}` })
    ).toThrow();
    expect(() =>
      buildDeployScript({ ...base, tag: `a${"b".repeat(127)}` })
    ).not.toThrow();
  });

  it("rejects invalid deploy dirs, services, tag variables and empty service lists", () => {
    expect(() =>
      buildDeployScript({ ...base, deployDir: "srv/accounting" })
    ).toThrow();
    expect(() =>
      buildDeployScript({ ...base, deployDir: "/srv/../etc" })
    ).toThrow();
    expect(() =>
      buildDeployScript({ ...base, services: ["backend; reboot"] })
    ).toThrow();
    expect(() => buildDeployScript({ ...base, services: [] })).toThrow();
    expect(() =>
      buildDeployScript({ ...base, tagVariable: "IMAGE_TAG=x" })
    ).toThrow();
    expect(() =>
      buildDeployScript({ ...base, healthUrl: "file:///etc/passwd" })
    ).toThrow();
    expect(() =>
      buildDeployScript({ ...base, healthTimeoutSeconds: 0 })
    ).toThrow();
  });
});

describe("buildDeployScript output", () => {
  it("never stops or removes the stack", () => {
    const script = buildDeployScript({
      ...base,
      services: ["backend", "frontend"],
      healthUrl: "http://localhost:8080/actuator/health",
    });
    expect(script).not.toMatch(/compose\s+(down|stop|rm)/);
    expect(script).toContain("up -d --no-deps");
  });

  it("orders bundle → env → pull → pre-start → up → health", () => {
    const script = buildDeployScript(base);
    const markers = [
      "docker pull",
      "docker cp",
      "sed -i",
      "docker compose pull",
      PRE_START_MARKER,
      "up -d --no-deps",
      "docker compose ps",
    ];
    const indexes = markers.map((m) => script.indexOf(m));
    for (const i of indexes) expect(i).toBeGreaterThanOrEqual(0);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(indexes).size).toBe(indexes.length);
    // The append branch belongs to the env step too: after cp, before pull.
    const append = script.indexOf(">> .env");
    expect(append).toBeGreaterThan(script.indexOf("docker cp"));
    expect(append).toBeLessThan(script.indexOf("docker compose pull"));
  });

  it("starts with set -eu and cd into the quoted deploy dir", () => {
    const script = buildDeployScript(base);
    expect(script.startsWith("set -eu\ncd '/srv/accounting'\n")).toBe(true);
  });

  it("omits the pre-start step when none is configured", () => {
    const script = buildDeployScript({ ...base, preStartCommand: null });
    expect(script).not.toContain(PRE_START_MARKER);
  });
});

// --- Stub runs -------------------------------------------------------------

const STUB_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$1" in
  create) echo stubcid ;;
  cp) mkdir -p "$3" && printf 'services: {}\\n' > "$3/compose.yaml" ;;
  compose)
    if [ "$2" = ps ]; then printf '%s\\n' "$STUB_PS"; fi ;;
esac
exit 0
`;

const STUB_CURL = `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$STUB_LOG"
exit 0
`;

function runStub(
  input: Partial<DeployScriptInput>,
  envFile: string | null,
  psOutput: string
): {
  status: number | null;
  stdout: string;
  env: string;
  log: string;
  elapsedMs: number;
} {
  const root = mkdtempSync(join(tmpdir(), "deploy-script-"));
  const bin = join(root, "bin");
  const deployDir = join(root, "deploy");
  mkdirSync(bin);
  mkdirSync(deployDir);
  writeFileSync(join(bin, "docker"), STUB_DOCKER);
  writeFileSync(join(bin, "curl"), STUB_CURL);
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  if (envFile !== null) writeFileSync(join(deployDir, ".env"), envFile);
  const log = join(root, "argv.log");
  writeFileSync(log, "");

  const script = buildDeployScript({ ...base, deployDir, ...input });
  const started = Date.now();
  const out = spawnSync("sh", ["-c", script], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_LOG: log,
      STUB_PS: psOutput,
    },
  });
  const elapsedMs = Date.now() - started;
  const result = {
    status: out.status,
    stdout: out.stdout,
    env: readFileSync(join(deployDir, ".env"), "utf8"),
    log: readFileSync(log, "utf8"),
    elapsedMs,
  };
  rmSync(root, { recursive: true });
  return result;
}

describe("buildDeployScript stub runs", () => {
  it("stub run, healthy", () => {
    const r = runStub(
      { healthUrl: "http://localhost:8080/health" },
      "IMAGE_TAG=old\nOTHER=1\n",
      "backend running healthy"
    );
    expect(r.status).toBe(0);
    expect(r.env).toBe(`IMAGE_TAG=${base.tag}\nOTHER=1\n`);
    const img = `${base.registry}/${base.bundleImage}:${base.tag}`;
    expect(r.log).toContain(`pull ${img}\n`);
    expect(r.log).toContain(`create ${img} noop\n`);
    expect(r.log).toContain("cp stubcid:/bundle/. .\n");
    expect(r.log).toContain("rm stubcid\n");
    expect(r.log).toContain("compose pull backend\n");
    expect(r.log).toContain("compose up -d --no-deps backend\n");
    expect(r.log).toContain(
      "curl -fsS -o /dev/null --max-time 5 http://localhost:8080/health\n"
    );
    expect(r.stdout).toContain("PRE_START_MARKER");
  });

  it("stub run, no healthcheck counts as healthy", () => {
    const r = runStub({}, "IMAGE_TAG=old\n", "backend running ");
    expect(r.status).toBe(0);
  });

  it("stub run, tag variable absent", () => {
    const r = runStub(
      { tagVariable: "BACKEND_IMAGE_TAG" },
      "IMAGE_TAG=old\nOTHER=1",
      "backend running healthy"
    );
    expect(r.status).toBe(0);
    expect(r.env).toBe(
      `IMAGE_TAG=old\nOTHER=1\nBACKEND_IMAGE_TAG=${base.tag}\n`
    );
  });

  it("stub run, never healthy", () => {
    const r = runStub(
      { healthTimeoutSeconds: 6 },
      "IMAGE_TAG=old\n",
      "backend restarting"
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("HEALTH TIMEOUT");
    expect(r.elapsedMs).toBeLessThan(15_000);
  }, 20_000);

  it("stub run, one of two services missing is not healthy", () => {
    const r = runStub(
      { services: ["backend", "frontend"], healthTimeoutSeconds: 1 },
      "IMAGE_TAG=old\n",
      "backend running healthy"
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("HEALTH TIMEOUT");
  }, 20_000);
});

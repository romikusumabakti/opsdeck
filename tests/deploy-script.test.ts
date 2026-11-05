import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDeployScript, type DeployScriptInput } from "@/lib/deploy/script";
import { deployDirSchema } from "@/lib/deploy/validation";

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
  // Most stub runs only need one OK poll; the stability window has its own tests.
  stableSeconds: 0,
};

const DEPLOYMENT_ID = "0197f3a0-1b2c-7def-8000-0123456789a4";
const STAGED = `.env.opsdeck-new.${DEPLOYMENT_ID}`;
const MANAGED = { deploymentId: DEPLOYMENT_ID, variableCount: 3 };

// Lines that install the staged `.env` (the only lines the option adds).
const INSTALL_LINES = [
  "if [ ! -e .env.opsdeck-unmanaged ] && [ -e .env ]; then cp -p .env .env.opsdeck-unmanaged && chmod 600 .env.opsdeck-unmanaged || { echo 'ENV INSTALL FAILED'; exit 1; }; fi",
  "if [ -f .env ]; then cp -p .env .env.opsdeck-prev && chmod 600 .env.opsdeck-prev || { echo 'ENV INSTALL FAILED'; exit 1; }; fi",
  `chmod 600 '${STAGED}' && mv -f '${STAGED}' .env || { echo 'ENV INSTALL FAILED'; exit 1; }`,
  "rm -f .env.opsdeck-new* || true",
  "echo 'Wrote .env (3 variables)'",
];

// Deploy dirs are compared as strings (shared-dir guard, multi-component tag
// lookup), so only one spelling of a directory is valid: no trailing '/', no
// empty, '.' or '..' segment.
describe("deployDirSchema", () => {
  it("accepts normalized absolute paths, including every live value", () => {
    for (const dir of [
      "/srv/accounting",
      "/opt/a.b/c_d-e",
      // `select distinct deploy_dir from deploy_targets` on the migrated
      // live copy, 2026-11-05.
      "/deployments/dplk-accounting",
      "/deployments/dplk-customer-portal",
      "/deployments/dplk-customer-portal-cms",
      "/deployments/dplk-investment",
      "/deployments/dplk-membership",
      "/deployments/hris",
    ]) {
      expect(deployDirSchema.safeParse(dir).success, dir).toBe(true);
    }
  });

  it("rejects a trailing slash, '//', '.' and '..' segments", () => {
    for (const dir of [
      "/srv/app/",
      "/srv/app//",
      "/srv//app",
      "//srv/app",
      "/srv/./app",
      "/srv/app/.",
      "/srv/../app",
      "/srv/app/..",
      "/./srv/app",
    ]) {
      expect(deployDirSchema.safeParse(dir).success, dir).toBe(false);
    }
  });
});

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
    expect(() =>
      buildDeployScript({ ...base, healthTimeoutSeconds: 901 })
    ).toThrow();
    expect(() =>
      buildDeployScript({ ...base, healthTimeoutSeconds: 900 })
    ).not.toThrow();
    for (const deployDir of [
      "/",
      "/.",
      "//",
      "/etc",
      "/a//b",
      "/a/./b",
      "/a/",
    ]) {
      expect(() => buildDeployScript({ ...base, deployDir })).toThrow();
    }
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

  it("starts with set -eu, ignores HUP/PIPE, cds and takes the deploy lock", () => {
    const script = buildDeployScript(base);
    expect(
      script.startsWith(
        [
          "set -eu",
          "trap '' HUP PIPE",
          "cd '/srv/accounting'",
          "exec 9>.opsdeck-deploy.lock",
          "flock -w 600 9 || { echo 'DEPLOY LOCKED'; exit 1; }",
          "",
        ].join("\n")
      )
    ).toBe(true);
    // The lock is held before anything touches the deploy dir.
    expect(script.indexOf("flock")).toBeLessThan(script.indexOf("docker"));
  });

  it("default stableSeconds is 30 when omitted", () => {
    const { stableSeconds: _omitted, ...withoutStable } = base;
    const script = buildDeployScript(withoutStable);
    expect(script).toMatch(/\$\(\( now - ok_since \)\) -ge 30 \]/);
    expect(buildDeployScript({ ...base, stableSeconds: 45 })).toMatch(
      /\$\(\( now - ok_since \)\) -ge 45 \]/
    );
  });

  it("rejects stableSeconds outside 0..600 or non-integer", () => {
    expect(() => buildDeployScript({ ...base, stableSeconds: -1 })).toThrow();
    expect(() => buildDeployScript({ ...base, stableSeconds: 601 })).toThrow();
    expect(() => buildDeployScript({ ...base, stableSeconds: 1.5 })).toThrow();
  });

  it("runs the pre-start command in a subshell", () => {
    const script = buildDeployScript(base);
    expect(script).toContain(`\n(\n${PRE_START_MARKER}\n\n)\n`);
  });

  it("omits the pre-start step when none is configured", () => {
    const script = buildDeployScript({ ...base, preStartCommand: null });
    expect(script).not.toContain(PRE_START_MARKER);
  });

  // Review Focus 2: an environment without a managed .env gets exactly the
  // script it got before the flag existed. The snapshot was recorded from the
  // code before `installStagedEnvFile` was added.
  it("without installStagedEnvFile the script is unchanged (snapshot)", () => {
    const input = {
      ...base,
      services: ["backend", "frontend"],
      healthUrl: "http://localhost:8080/actuator/health",
    };
    const script = buildDeployScript(input);
    expect(script).toMatchSnapshot();
    expect(
      buildDeployScript({ ...input, installStagedEnvFile: undefined })
    ).toBe(script);
    expect(script).not.toContain(".env.opsdeck");
  });

  it("with installStagedEnvFile installs the staged .env after the bundle step and before the tag step and any compose pull", () => {
    const without = buildDeployScript(base);
    const script = buildDeployScript({
      ...base,
      installStagedEnvFile: MANAGED,
    });
    const install = script.indexOf(INSTALL_LINES.join("\n"));
    expect(install).toBeGreaterThan(script.indexOf("flock -w"));
    expect(install).toBeGreaterThan(script.indexOf("docker pull"));
    expect(install).toBeGreaterThan(
      script.indexOf('docker rm "$cid" >/dev/null\n')
    );
    expect(install).toBeLessThan(script.indexOf("grep -q"));
    expect(install).toBeLessThan(script.indexOf("sed -i"));
    expect(install).toBeLessThan(script.indexOf("docker compose pull"));
    // Nothing else changes.
    expect(script.replace(`${INSTALL_LINES.join("\n")}\n`, "")).toBe(without);
  });

  it("rejects a staged-file deployment id that is not a UUID, or a bad count", () => {
    for (const deploymentId of ["x", "../etc/passwd", `${DEPLOYMENT_ID}*`]) {
      expect(() =>
        buildDeployScript({
          ...base,
          installStagedEnvFile: { deploymentId, variableCount: 1 },
        })
      ).toThrow();
    }
    expect(() =>
      buildDeployScript({
        ...base,
        installStagedEnvFile: {
          deploymentId: DEPLOYMENT_ID,
          variableCount: -1,
        },
      })
    ).toThrow();
  });
});

// --- Stub runs -------------------------------------------------------------
//
// The script runs under `sh` with stub `docker`/`curl` on PATH that log argv.
// STUB_CONTAINERS describes the containers as `<service> <status> [<health>]`
// lines; `compose ps -q <svc>` lists their ids and `inspect` reports them.
// STUB_CONTAINERS_ALT, when set, is served on every other `compose ps` call
// (a flapping service). STUB_RESTARTING bumps RestartCount/StartedAt on every
// inspect (a crash loop that `compose ps` still shows as running).
//
// A success needs at least two polls (5 s apart; the first is the baseline),
// so these run concurrently with an async spawn.

const STUB_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$1" in
  create) echo stubcid ;;
  cp)
    if [ -n "\${STUB_CP_FAIL:-}" ]; then echo 'cp failed' >&2; exit 1; fi
    mkdir -p "$3" && printf 'services: {}\\n' > "$3/compose.yaml"
    if [ -n "\${STUB_CP_ENV:-}" ]; then printf 'FROM_BUNDLE=1\\n' > "$3/.env"; fi ;;
  compose)
    if [ "$2" = ps ]; then
      table=$STUB_CONTAINERS
      if [ -n "\${STUB_CONTAINERS_ALT:-}" ]; then
        n=$(cat "$STUB_LOG.polls" 2>/dev/null || echo 0)
        echo $((n + 1)) > "$STUB_LOG.polls"
        if [ $((n % 2)) = 1 ]; then table=$STUB_CONTAINERS_ALT; fi
        printf '%s\\n' "$table" > "$STUB_LOG.current"
      fi
      printf '%s\\n' "$table" | awk -v s="$4" '$1 == s { print "c-" s "-" NR }'
    fi ;;
  inspect)
    table=$STUB_CONTAINERS
    if [ -f "$STUB_LOG.current" ]; then table=$(cat "$STUB_LOG.current"); fi
    r=0
    if [ -n "\${STUB_RESTARTING:-}" ]; then
      r=$(cat "$STUB_LOG.restarts" 2>/dev/null || echo 0)
      echo $((r + 1)) > "$STUB_LOG.restarts"
    fi
    printf '%s\\n' "$table" | awk -v id="$4" -v r="$r" \\
      '"c-" $1 "-" NR == id { print r, "2026-11-03T00:00:" r "Z", $2, $3 }' ;;
esac
exit 0
`;

const STUB_CURL = `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$STUB_LOG"
if [ -n "\${STUB_CURL_FAIL:-}" ]; then exit 22; fi
exit 0
`;

interface StubRun {
  status: number | null;
  stdout: string;
  env: string;
  envMode: number;
  /** `.env.opsdeck-prev`, null when absent. */
  prev: string | null;
  prevMode: number | null;
  /** `.env.opsdeck-unmanaged`, null when absent. */
  unmanaged: string | null;
  unmanagedMode: number | null;
  /** Staged files still in the deploy dir. */
  stagedLeft: string[];
  log: string;
  elapsedMs: number;
}

const modeOf = (path: string) => statSync(path).mode & 0o777;

async function runStub(
  input: Partial<DeployScriptInput>,
  envFile: string | null,
  containers: string,
  stubEnv: Record<string, string> = {},
  extraStubs: Record<string, string> = {},
  staged: string | null = null,
  leftovers: string[] = []
): Promise<StubRun> {
  const root = mkdtempSync(join(tmpdir(), "deploy-script-"));
  const bin = join(root, "bin");
  const deployDir = join(root, "deploy");
  mkdirSync(bin);
  mkdirSync(deployDir);
  writeFileSync(join(bin, "docker"), STUB_DOCKER);
  writeFileSync(join(bin, "curl"), STUB_CURL);
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  for (const [name, body] of Object.entries(extraStubs)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  if (envFile !== null) {
    writeFileSync(join(deployDir, ".env"), envFile);
    chmodSync(join(deployDir, ".env"), 0o644);
  }
  if (staged !== null) {
    writeFileSync(join(deployDir, STAGED), staged);
    chmodSync(join(deployDir, STAGED), 0o644);
  }
  for (const name of leftovers) writeFileSync(join(deployDir, name), "OLD=1\n");
  const log = join(root, "argv.log");
  writeFileSync(log, "");

  const script = buildDeployScript({ ...base, deployDir, ...input });
  const started = Date.now();
  const child = spawn("sh", ["-c", script], {
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_LOG: log,
      STUB_CONTAINERS: containers,
      ...stubEnv,
    },
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const envPath = join(deployDir, ".env");
  const prevPath = join(deployDir, ".env.opsdeck-prev");
  const unmanagedPath = join(deployDir, ".env.opsdeck-unmanaged");
  const result = {
    status,
    stdout,
    env: readFileSync(envPath, "utf8"),
    envMode: modeOf(envPath),
    prev: existsSync(prevPath) ? readFileSync(prevPath, "utf8") : null,
    prevMode: existsSync(prevPath) ? modeOf(prevPath) : null,
    unmanaged: existsSync(unmanagedPath)
      ? readFileSync(unmanagedPath, "utf8")
      : null,
    unmanagedMode: existsSync(unmanagedPath) ? modeOf(unmanagedPath) : null,
    stagedLeft: readdirSync(deployDir).filter((f) =>
      f.startsWith(".env.opsdeck-new")
    ),
    log: readFileSync(log, "utf8"),
    elapsedMs: Date.now() - started,
  };
  rmSync(root, { recursive: true });
  return result;
}

const SLOW = 20_000;

describe.concurrent("buildDeployScript stub runs", () => {
  it(
    "stub run, healthy",
    async () => {
      const r = await runStub(
        { healthUrl: "http://localhost:8080/health" },
        "IMAGE_TAG=old\nOTHER=1\n",
        "backend running healthy"
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("HEALTHY");
      expect(r.env).toBe(`IMAGE_TAG=${base.tag}\nOTHER=1\n`);
      const img = `${base.registry}/${base.bundleImage}:${base.tag}`;
      expect(r.log).toContain(`pull ${img}\n`);
      expect(r.log).toContain(`create ${img} noop\n`);
      expect(r.log).toContain("cp stubcid:/bundle/. .\n");
      expect(r.log).toContain("rm stubcid\n");
      expect(r.log).toContain("compose pull backend\n");
      expect(r.log).toContain("compose up -d --no-deps backend\n");
      expect(r.log).toContain("compose ps -q backend\n");
      expect(r.log).toMatch(/^inspect -f .* c-backend-1$/m);
      expect(r.log).toContain(
        "curl -fsS -o /dev/null --max-time 5 http://localhost:8080/health\n"
      );
      expect(r.stdout).toContain("PRE_START_MARKER");
    },
    SLOW
  );

  it(
    "stub run, no healthcheck counts as healthy",
    async () => {
      const r = await runStub({}, "IMAGE_TAG=old\n", "backend running");
      expect(r.status).toBe(0);
    },
    SLOW
  );

  it(
    "stub run, health starting is not healthy",
    async () => {
      const r = await runStub(
        { healthTimeoutSeconds: 6 },
        "IMAGE_TAG=old\n",
        "backend running starting"
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("HEALTH TIMEOUT");
    },
    SLOW
  );

  it(
    "stub run, tag variable absent",
    async () => {
      const r = await runStub(
        { tagVariable: "BACKEND_IMAGE_TAG" },
        "IMAGE_TAG=old\nOTHER=1",
        "backend running healthy"
      );
      expect(r.status).toBe(0);
      expect(r.env).toBe(
        `IMAGE_TAG=old\nOTHER=1\nBACKEND_IMAGE_TAG=${base.tag}\n`
      );
    },
    SLOW
  );

  it(
    "stub run, never healthy",
    async () => {
      const r = await runStub(
        { healthTimeoutSeconds: 6 },
        "IMAGE_TAG=old\n",
        "backend restarting"
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("HEALTH TIMEOUT");
      expect(r.elapsedMs).toBeLessThan(15_000);
    },
    SLOW
  );

  it(
    "stub run, crash loop that compose ps shows as running",
    async () => {
      const r = await runStub(
        { healthTimeoutSeconds: 6 },
        "IMAGE_TAG=old\n",
        "backend running",
        { STUB_RESTARTING: "1" }
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("HEALTH TIMEOUT");
      expect(r.elapsedMs).toBeLessThan(15_000);
    },
    SLOW
  );

  it(
    "stub run, healthy only after staying OK for stableSeconds",
    async () => {
      const r = await runStub(
        { stableSeconds: 5, healthTimeoutSeconds: 30 },
        "IMAGE_TAG=old\n",
        "backend running"
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("HEALTHY");
      // Baseline poll, first OK poll, then one 5 s later closes the window.
      expect(r.elapsedMs).toBeGreaterThanOrEqual(10_000);
      expect(r.log.match(/^compose ps -q /gm)?.length).toBe(3);
    },
    SLOW
  );

  it(
    "flapping service resets the stability window",
    async () => {
      const r = await runStub(
        { stableSeconds: 5, healthTimeoutSeconds: 8 },
        "IMAGE_TAG=old\n",
        "backend running",
        { STUB_CONTAINERS_ALT: "backend restarting" }
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("HEALTH TIMEOUT");
      expect(r.stdout).not.toContain("HEALTHY\n");
      expect(r.elapsedMs).toBeLessThan(15_000);
    },
    SLOW
  );

  it(
    "stub run, pre-start exit 0 does not end the script",
    async () => {
      const r = await runStub(
        { preStartCommand: "exit 0" },
        "IMAGE_TAG=old\n",
        "backend running healthy"
      );
      expect(r.status).toBe(0);
      expect(r.log).toContain("compose up -d --no-deps backend\n");
      expect(r.log).toContain("compose ps -q backend\n");
      expect(r.stdout).toContain("HEALTHY");
    },
    SLOW
  );

  it("stub run, failing pre-start aborts before up", async () => {
    const r = await runStub(
      { preStartCommand: "false" },
      "IMAGE_TAG=old\n",
      "backend running healthy"
    );
    expect(r.status).not.toBe(0);
    expect(r.log).not.toContain("compose up");
  });

  it("stub run, docker cp fails: bundle container removed, script fails", async () => {
    const r = await runStub({}, "IMAGE_TAG=old\n", "backend running healthy", {
      STUB_CP_FAIL: "1",
    });
    expect(r.status).not.toBe(0);
    expect(r.log).toContain("rm stubcid\n");
    expect(r.log).not.toContain("compose pull");
    expect(r.env).toBe("IMAGE_TAG=old\n");
  });

  it(
    "stub run, compose healthy but health URL fails",
    async () => {
      const r = await runStub(
        { healthUrl: "http://localhost:8080/health", healthTimeoutSeconds: 6 },
        "IMAGE_TAG=old\n",
        "backend running healthy",
        { STUB_CURL_FAIL: "1" }
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("HEALTH TIMEOUT");
      expect(r.log).toMatch(/^curl /m);
    },
    SLOW
  );

  it(
    "stub run, a listed service without containers is not healthy",
    async () => {
      const r = await runStub(
        { services: ["backend", "frontend"], healthTimeoutSeconds: 1 },
        "IMAGE_TAG=old\n",
        "backend running healthy"
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("HEALTH TIMEOUT");
    },
    SLOW
  );

  it(
    "stub run, deploy dir locked by another script",
    async () => {
      const r = await runStub(
        {},
        "IMAGE_TAG=old\n",
        "backend running healthy",
        {},
        { flock: "#!/bin/sh\nexit 1\n" }
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("DEPLOY LOCKED");
      expect(r.log).toBe("");
      expect(r.env).toBe("IMAGE_TAG=old\n");
    },
    SLOW
  );

  it(
    "stub run, two services healthy",
    async () => {
      const r = await runStub(
        { services: ["backend", "frontend"] },
        "IMAGE_TAG=old\n",
        "backend running healthy\nfrontend running"
      );
      expect(r.status).toBe(0);
      expect(r.log).toContain("compose up -d --no-deps backend frontend\n");
    },
    SLOW
  );

  it(
    "stub run, staged .env installed with mode 0600, previous kept once",
    async () => {
      const staged = `SECRET='s3cr3t'\nIMAGE_TAG=${base.tag}\n`;
      const r = await runStub(
        { installStagedEnvFile: MANAGED },
        "IMAGE_TAG=old\nOLD=1\n",
        "backend running healthy",
        {},
        {},
        staged
      );
      expect(r.status).toBe(0);
      // The tag line already carries the deploying tag: the sed is a no-op.
      expect(r.env).toBe(staged);
      expect(r.envMode).toBe(0o600);
      expect(r.prev).toBe("IMAGE_TAG=old\nOLD=1\n");
      expect(r.prevMode).toBe(0o600);
      expect(r.stagedLeft).toEqual([]);
      expect(r.stdout).toContain("Wrote .env (3 variables)\n");
    },
    SLOW
  );

  // The hand-written .env from before the Panel managed it is kept once and
  // never overwritten, so it survives later deploys and rollbacks.
  it(
    "stub run, first managed install keeps the hand-written .env once (0600)",
    async () => {
      const r = await runStub(
        { installStagedEnvFile: MANAGED },
        "IMAGE_TAG=old\nHAND=written\n",
        "backend running healthy",
        {},
        {},
        `IMAGE_TAG=${base.tag}\n`
      );
      expect(r.status).toBe(0);
      expect(r.unmanaged).toBe("IMAGE_TAG=old\nHAND=written\n");
      expect(r.unmanagedMode).toBe(0o600);
    },
    SLOW
  );

  it(
    "stub run, an existing .env.opsdeck-unmanaged is never overwritten",
    async () => {
      const r = await runStub(
        { installStagedEnvFile: MANAGED },
        "IMAGE_TAG=old\nMANAGED=1\n",
        "backend running healthy",
        {},
        {},
        `IMAGE_TAG=${base.tag}\n`,
        [".env.opsdeck-unmanaged"]
      );
      expect(r.status).toBe(0);
      expect(r.unmanaged).toBe("OLD=1\n");
      expect(r.prev).toBe("IMAGE_TAG=old\nMANAGED=1\n");
    },
    SLOW
  );

  it(
    "stub run, staged .env installed when the server has no .env yet",
    async () => {
      const staged = `IMAGE_TAG=${base.tag}\n`;
      const r = await runStub(
        { installStagedEnvFile: MANAGED },
        null,
        "backend running healthy",
        {},
        {},
        staged
      );
      expect(r.status).toBe(0);
      expect(r.env).toBe(staged);
      expect(r.envMode).toBe(0o600);
      expect(r.prev).toBeNull();
      expect(r.unmanaged).toBeNull();
    },
    SLOW
  );

  it(
    "stub run, leftover staged files are removed after the install",
    async () => {
      const r = await runStub(
        { installStagedEnvFile: MANAGED },
        "IMAGE_TAG=old\n",
        "backend running healthy",
        {},
        {},
        `IMAGE_TAG=${base.tag}\n`,
        [
          ".env.opsdeck-new",
          ".env.opsdeck-new.0197f3a0-1b2c-7def-8000-000000000001",
        ]
      );
      expect(r.status).toBe(0);
      expect(r.stagedLeft).toEqual([]);
    },
    SLOW
  );

  it(
    "stub run, the managed .env wins over a .env shipped in the bundle",
    async () => {
      const staged = `A='1'\nIMAGE_TAG=${base.tag}\n`;
      const r = await runStub(
        { installStagedEnvFile: MANAGED },
        "IMAGE_TAG=old\n",
        "backend running healthy",
        { STUB_CP_ENV: "1" },
        {},
        staged
      );
      expect(r.status).toBe(0);
      expect(r.env).toBe(staged);
    },
    SLOW
  );

  // Review Focus 3: a failed bundle step or install stops before the tag step
  // and any compose pull, and leaves the previous .env in place.
  it("stub run, managed: a failed bundle step leaves .env untouched", async () => {
    const r = await runStub(
      { installStagedEnvFile: MANAGED },
      "IMAGE_TAG=old\n",
      "backend running healthy",
      { STUB_CP_FAIL: "1" },
      {},
      "IMAGE_TAG=new\n"
    );
    expect(r.status).not.toBe(0);
    expect(r.log).not.toContain("compose");
    expect(r.env).toBe("IMAGE_TAG=old\n");
    expect(r.prev).toBeNull();
  });

  it("stub run, staged .env missing: fails before any pull, .env untouched", async () => {
    const r = await runStub(
      { installStagedEnvFile: MANAGED },
      "IMAGE_TAG=old\n",
      "backend running healthy"
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("ENV INSTALL FAILED");
    expect(r.log).toContain("rm stubcid\n");
    expect(r.log).not.toContain("compose");
    expect(r.env).toBe("IMAGE_TAG=old\n");
  });

  it("stub run, backup copy fails: fails before any pull, .env untouched", async () => {
    const r = await runStub(
      { installStagedEnvFile: MANAGED },
      "IMAGE_TAG=old\n",
      "backend running healthy",
      {},
      { cp: "#!/bin/sh\nexit 1\n" },
      "IMAGE_TAG=new\n"
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("ENV INSTALL FAILED");
    expect(r.log).toContain("rm stubcid\n");
    expect(r.log).not.toContain("compose");
    expect(r.env).toBe("IMAGE_TAG=old\n");
  });

  it("stub run, keeping the hand-written .env fails: fails before any pull, .env untouched", async () => {
    const r = await runStub(
      { installStagedEnvFile: MANAGED },
      "IMAGE_TAG=old\n",
      "backend running healthy",
      {},
      { chmod: "#!/bin/sh\nexit 1\n" },
      "IMAGE_TAG=new\n"
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("ENV INSTALL FAILED");
    expect(r.log).not.toContain("compose");
    expect(r.env).toBe("IMAGE_TAG=old\n");
    expect(r.prev).toBeNull();
  });

  it("stub run, rename fails: fails before any pull, .env untouched", async () => {
    const r = await runStub(
      { installStagedEnvFile: MANAGED },
      "IMAGE_TAG=old\n",
      "backend running healthy",
      {},
      { mv: "#!/bin/sh\nexit 1\n" },
      "IMAGE_TAG=new\n"
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("ENV INSTALL FAILED");
    expect(r.log).toContain("rm stubcid\n");
    expect(r.log).not.toContain("compose");
    expect(r.env).toBe("IMAGE_TAG=old\n");
  });
});

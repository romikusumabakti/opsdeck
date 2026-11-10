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
import {
  type ArtifactDeployScriptInput,
  artifactStagingDir,
  buildArtifactDeployScript,
  buildArtifactExtractCommand,
  NGINX_LOCK_FILE,
} from "@/lib/deploy/artifact-script";

// The artifact deploy scripts run as root on a legacy (Rocky 8) VM over SSH.
// Like tests/deploy-script.test.ts, they are tested on their text and by
// running them under `sh` against stub `systemctl`, `nginx`, `curl`, `chcon`,
// `selinuxenabled`, `chown`, `chmod` and `flock` binaries on PATH that log argv
// (chown, chmod and flock then run the real binary).

type JarInput = Extract<ArtifactDeployScriptInput, { kind: "jar" }>;
type StaticInput = Extract<ArtifactDeployScriptInput, { kind: "static" }>;

const ID = "0197f3a0-1b2c-7def-8000-0123456789a4";
const OTHER_ID = "0197f3a0-1b2c-7def-8000-0123456789b5";
const INCOMING = `.opsdeck-incoming-${ID}`;

const jarBase: JarInput = {
  kind: "jar",
  deployDir: "/srv/core",
  deploymentId: ID,
  jarName: "core-web-service.jar",
  systemdUnit: "core",
  healthUrl: null,
  healthTimeoutSeconds: 180,
  stableSeconds: 0,
};

const staticBase: StaticInput = {
  kind: "static",
  deployDir: "/usr/share/nginx/html",
  deploymentId: ID,
  healthTimeoutSeconds: 180,
};

describe("artifactStagingDir and buildArtifactExtractCommand", () => {
  it("puts the jar staging inside the deploy dir, the static one beside the web root", () => {
    expect(artifactStagingDir("jar", "/srv/core", ID)).toBe(
      `/srv/core/.opsdeck-incoming-${ID}`
    );
    expect(artifactStagingDir("static", "/usr/share/nginx/html", ID)).toBe(
      `/usr/share/nginx/html.opsdeck-incoming-${ID}`
    );
  });

  it("is per deployment, in the path and in the script", () => {
    for (const kind of ["jar", "static"] as const) {
      const mine = artifactStagingDir(kind, "/srv/core", ID);
      const other = artifactStagingDir(kind, "/srv/core", OTHER_ID);
      expect(mine).not.toBe(other);
      const base = kind === "jar" ? jarBase : staticBase;
      const script = buildArtifactDeployScript({
        ...base,
        deployDir: "/srv/core",
      });
      expect(script).toContain(mine);
      expect(script).not.toContain(OTHER_ID);
    }
  });

  it("rejects an invalid deploy dir or deployment id", () => {
    expect(() => artifactStagingDir("jar", "/", ID)).toThrow();
    expect(() => artifactStagingDir("static", "/srv/a b", ID)).toThrow();
    expect(() => artifactStagingDir("jar", "/srv/core", "x; reboot")).toThrow();
    expect(() =>
      buildArtifactDeployScript({ ...jarBase, deploymentId: "../x" })
    ).toThrow();
    expect(() =>
      buildArtifactDeployScript({ ...staticBase, deploymentId: "" })
    ).toThrow();
  });

  it("recreates the staging dir and extracts only bundle/artifact from stdin", () => {
    expect(buildArtifactExtractCommand("/srv/core/.opsdeck-incoming")).toBe(
      "rm -rf '/srv/core/.opsdeck-incoming' && mkdir -p '/srv/core/.opsdeck-incoming' && tar -xzf - -C '/srv/core/.opsdeck-incoming' bundle/artifact"
    );
    expect(() => buildArtifactExtractCommand("/srv/x'y")).toThrow();
    expect(() => buildArtifactExtractCommand("/")).toThrow();
  });
});

describe("buildArtifactDeployScript validation", () => {
  it("rejects a deploy dir with a space, a quote or no depth", () => {
    for (const deployDir of ["/srv/core app", "/srv/core'app", "/", "/srv"]) {
      expect(() =>
        buildArtifactDeployScript({ ...jarBase, deployDir })
      ).toThrow();
      expect(() =>
        buildArtifactDeployScript({ ...staticBase, deployDir })
      ).toThrow();
    }
  });

  it("rejects invalid jar names, units, URLs and timeouts", () => {
    for (const bad of [
      { jarName: "core.war" },
      { jarName: "../core.jar" },
      { jarName: "a b.jar" },
      { systemdUnit: "core.service" },
      { systemdUnit: "core; reboot" },
      { healthUrl: "file:///etc/passwd" },
      { healthTimeoutSeconds: 0 },
      { healthTimeoutSeconds: 901 },
      { stableSeconds: -1 },
    ]) {
      expect(
        () => buildArtifactDeployScript({ ...jarBase, ...bad }),
        JSON.stringify(bad)
      ).toThrow();
    }
  });
});

// Removes every single-quoted word (joining `'\\''` escapes first), so what is
// left is the unquoted text. The trap's nested quoting has its own exact test.
const unquoted = (script: string) =>
  script.replaceAll("'\\''", "").replace(/'[^']*'/g, "''");

describe("buildArtifactDeployScript output", () => {
  it("jar: starts with set -eu, ignores HUP/PIPE and takes the deploy-dir lock", () => {
    const script = buildArtifactDeployScript(jarBase);
    expect(
      script.startsWith(
        [
          "set -eu",
          "trap '' HUP PIPE",
          `trap 'rm -rf '\\''/srv/core/${INCOMING}'\\''' EXIT`,
          "cd '/srv/core'",
          "exec 9>'/srv/core/.opsdeck-deploy.lock'",
          "flock -w 600 9 || { echo 'DEPLOY LOCKED'; exit 1; }",
          "",
        ].join("\n")
      )
    ).toBe(true);
  });

  it("static: takes the sibling deploy lock, then the host-wide nginx lock", () => {
    const script = buildArtifactDeployScript(staticBase);
    expect(script).toContain(
      "exec 9>'/usr/share/nginx/html.opsdeck-deploy.lock'\nflock -w 600 9 || { echo 'DEPLOY LOCKED'; exit 1; }"
    );
    expect(NGINX_LOCK_FILE).toBe("/run/opsdeck-nginx.lock");
    expect(script).toContain(
      "exec 8>'/run/opsdeck-nginx.lock'\nflock -w 120 8 || { echo 'DEPLOY LOCKED'; exit 1; }"
    );
    expect(script.indexOf("flock -w 120 8")).toBeLessThan(
      script.indexOf("nginx -t")
    );
  });

  it("quotes every path, jar name and unit", () => {
    const jar = buildArtifactDeployScript({
      ...jarBase,
      healthUrl: "http://localhost:8080/actuator/health",
    });
    for (const value of ["/srv/core", "core-web-service.jar", "localhost"]) {
      expect(jar).toContain(value);
      expect(unquoted(jar)).not.toContain(value);
    }
    expect(unquoted(jar)).not.toMatch(/systemctl \w+(-\w+)? core\b/);
    const web = buildArtifactDeployScript(staticBase);
    expect(web).toContain("/usr/share/nginx/html");
    expect(unquoted(web)).not.toContain("/usr/share");
  });

  it("jar: stops before moving the jar, starts after", () => {
    const script = buildArtifactDeployScript(jarBase);
    const order = [
      "systemctl cat",
      "systemctl is-enabled",
      "systemctl stop",
      "mkdir -p '/srv/core/.opsdeck-prev'",
      "systemctl start",
      "systemctl show",
    ].map((m) => script.indexOf(m));
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

const STUB_SYSTEMCTL = `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$STUB_LOG"
case "$1" in
  cat) if [ -n "\${STUB_UNIT_MISSING:-}" ]; then echo "No files found for $2." >&2; exit 1; fi; echo "[Unit]" ;;
  is-enabled) s=\${STUB_ENABLED:-enabled}; echo "$s"; case "$s" in enabled|enabled-runtime|static|indirect|generated|alias) exit 0 ;; *) exit 1 ;; esac ;;
  show)
    case "$3" in
      ActiveState) echo "\${STUB_STATE:-active}" ;;
      MainPID)
        if [ -n "\${STUB_PID_CHANGES:-}" ]; then
          n=$(cat "$STUB_DIR/pid" 2>/dev/null || echo 100); n=$((n + 1)); echo "$n" > "$STUB_DIR/pid"; echo "$n"
        else echo 4242; fi ;;
    esac ;;
esac
exit 0
`;

const STUB_CURL = `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$STUB_LOG"
printf '%s' "\${STUB_HTTP_CODE:-200}"
`;

const STUB_NGINX = `#!/bin/sh
printf 'nginx %s\\n' "$*" >> "$STUB_LOG"
if [ "$1" = -t ] && [ -n "\${STUB_NGINX_FAIL:-}" ]; then echo "nginx: configuration file test failed" >&2; exit 1; fi
exit 0
`;

const STUB_CHCON = `#!/bin/sh
printf 'chcon %s\\n' "$*" >> "$STUB_LOG"
`;

const STUB_SELINUXENABLED = `#!/bin/sh
exit "\${STUB_SELINUX:-0}"
`;

const loggingWrapper = (name: string) => `#!/bin/sh
printf '${name} %s\\n' "$*" >> "$STUB_LOG"
exec /usr/bin/${name} "$@"
`;

// Logs the path open on the fd it is asked to lock, then locks it for real.
const STUB_FLOCK = `#!/bin/sh
for fd; do :; done
printf 'flock %s -> %s\\n' "$*" "$(readlink "/proc/$$/fd/$fd")" >> "$STUB_LOG"
if [ -n "\${STUB_FLOCK_FAIL:-}" ]; then exit 1; fi
exec /usr/bin/flock "$@"
`;

interface Run {
  status: number | null;
  stdout: string;
  log: string;
  root: string;
}

async function runScript(
  script: string,
  root: string,
  stubEnv: Record<string, string>
): Promise<Run> {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const stubs: Record<string, string> = {
    systemctl: STUB_SYSTEMCTL,
    curl: STUB_CURL,
    nginx: STUB_NGINX,
    chcon: STUB_CHCON,
    selinuxenabled: STUB_SELINUXENABLED,
    chown: loggingWrapper("chown"),
    chmod: loggingWrapper("chmod"),
    flock: STUB_FLOCK,
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(root, "argv.log");
  writeFileSync(log, "");
  const child = spawn("sh", ["-c", script], {
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_LOG: log,
      STUB_DIR: root,
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
  return { status, stdout, log: readFileSync(log, "utf8"), root };
}

const read = (path: string) => readFileSync(path, "utf8");
const modeOf = (path: string) => statSync(path).mode & 0o777;

/** Stages `jars` (name → content) the way buildArtifactExtractCommand leaves them. */
async function runJar(
  input: Partial<JarInput>,
  options: {
    jars?: Record<string, string>;
    current?: string | null;
    currentMode?: number;
    env?: Record<string, string>;
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "artifact-script-"));
  const deployDir = join(root, "deploy");
  const artifact = join(
    artifactStagingDir("jar", deployDir, ID),
    "bundle/artifact"
  );
  mkdirSync(artifact, { recursive: true });
  for (const [name, body] of Object.entries(
    options.jars ?? { "core-0.0.1-SNAPSHOT.jar": "NEW" }
  )) {
    writeFileSync(join(artifact, name), body);
    chmodSync(join(artifact, name), 0o644);
  }
  // Another deployment's upload of the same target, still in flight.
  const other = join(
    artifactStagingDir("jar", deployDir, OTHER_ID),
    "bundle/artifact"
  );
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "other.jar"), "OTHER");
  const current = options.current === undefined ? "OLD" : options.current;
  if (current !== null) {
    writeFileSync(join(deployDir, "core-web-service.jar"), current);
    chmodSync(
      join(deployDir, "core-web-service.jar"),
      options.currentMode ?? 0o644
    );
  }
  const script = buildArtifactDeployScript({ ...jarBase, deployDir, ...input });
  const run = await runScript(script, root, options.env ?? {});
  return { ...run, deployDir };
}

async function runStatic(
  options: {
    index?: boolean;
    current?: string | null;
    staleNext?: boolean;
    rootMode?: number;
    env?: Record<string, string>;
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "artifact-script-"));
  const webRoot = join(root, "html");
  const artifact = join(
    artifactStagingDir("static", webRoot, ID),
    "bundle/artifact"
  );
  mkdirSync(join(artifact, "assets"), { recursive: true });
  chmodSync(artifact, 0o755);
  if (options.index ?? true) writeFileSync(join(artifact, "index.html"), "NEW");
  writeFileSync(join(artifact, "assets/app.js"), "js");
  chmodSync(join(artifact, "assets/app.js"), 0o644);
  // Another deployment's upload of the same target, still in flight.
  const other = join(
    artifactStagingDir("static", webRoot, OTHER_ID),
    "bundle/artifact"
  );
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "index.html"), "OTHER");
  const current = options.current === undefined ? "OLD" : options.current;
  if (current !== null) {
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, "index.html"), current);
    chmodSync(webRoot, options.rootMode ?? 0o755);
  }
  if (options.staleNext) {
    mkdirSync(`${webRoot}.opsdeck-new`);
    writeFileSync(`${webRoot}.opsdeck-new/stale.html`, "stale");
  }
  const lock = join(root, "nginx.lock");
  // /run is root-only here: point the constant at a temp file; the stub flock
  // logs the path it locks.
  const script = buildArtifactDeployScript({
    ...staticBase,
    deployDir: webRoot,
  }).replaceAll(NGINX_LOCK_FILE, lock);
  const run = await runScript(script, root, options.env ?? {});
  return { ...run, webRoot, lock };
}

const SLOW = 20_000;

describe.concurrent("buildArtifactDeployScript stub runs (jar)", () => {
  it("happy path: keeps the current jar as prev, renames the staged one, starts, HEALTHY", async () => {
    const r = await runJar({});
    try {
      expect(r.stdout).toContain("HEALTHY");
      expect(r.status).toBe(0);
      expect(read(join(r.deployDir, "core-web-service.jar"))).toBe("NEW");
      expect(
        read(join(r.deployDir, ".opsdeck-prev/core-web-service.jar"))
      ).toBe("OLD");
      expect(existsSync(join(r.deployDir, INCOMING))).toBe(false);
      const calls = r.log
        .split("\n")
        .filter((l) => /^systemctl (stop|start|enable)/.test(l));
      expect(calls).toEqual(["systemctl stop core", "systemctl start core"]);
      expect(r.log).toContain(
        `flock -w 600 9 -> ${r.deployDir}/.opsdeck-deploy.lock`
      );
      expect(r.stdout).not.toContain("Enabled");
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("first deploy with no current jar", async () => {
    const r = await runJar({}, { current: null });
    try {
      expect(r.status).toBe(0);
      expect(read(join(r.deployDir, "core-web-service.jar"))).toBe("NEW");
      expect(readdirSync(join(r.deployDir, ".opsdeck-prev"))).toEqual([]);
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("unknown unit: UNIT NOT FOUND, the current jar unchanged, nothing stopped", async () => {
    const r = await runJar({}, { env: { STUB_UNIT_MISSING: "1" } });
    try {
      expect(r.stdout).toContain("UNIT NOT FOUND");
      expect(r.status).toBe(1);
      expect(read(join(r.deployDir, "core-web-service.jar"))).toBe("OLD");
      expect(existsSync(join(r.deployDir, ".opsdeck-prev"))).toBe(false);
      expect(r.log).not.toMatch(/systemctl (stop|start)/);
      expect(existsSync(join(r.deployDir, INCOMING))).toBe(false);
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("leaves another deployment's staging dir alone", async () => {
    const r = await runJar({});
    try {
      expect(r.status).toBe(0);
      expect(existsSync(join(r.deployDir, INCOMING))).toBe(false);
      expect(
        read(
          join(
            artifactStagingDir("jar", r.deployDir, OTHER_ID),
            "bundle/artifact/other.jar"
          )
        )
      ).toBe("OTHER");
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("removes its own staging dir when the target is locked", async () => {
    const root = mkdtempSync(join(tmpdir(), "artifact-script-"));
    const deployDir = join(root, "deploy");
    const staging = artifactStagingDir("jar", deployDir, ID);
    mkdirSync(join(staging, "bundle/artifact"), { recursive: true });
    const script = buildArtifactDeployScript({ ...jarBase, deployDir });
    // A flock that times out, as when another deploy holds the lock.
    const r = await runScript(script, root, { STUB_FLOCK_FAIL: "1" });
    try {
      expect(r.stdout).toContain("DEPLOY LOCKED");
      expect(r.status).toBe(1);
      expect(existsSync(staging)).toBe(false);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  for (const state of ["static", "indirect", "generated", "enabled-runtime"]) {
    it(`unit reporting ${state}: deploys without enable`, async () => {
      const r = await runJar({}, { env: { STUB_ENABLED: state } });
      try {
        expect(r.stdout).toContain("HEALTHY");
        expect(r.status).toBe(0);
        expect(r.log).not.toContain("systemctl enable");
        expect(r.stdout).not.toContain("Enabled");
      } finally {
        rmSync(r.root, { recursive: true });
      }
    });
  }

  it("new jar takes the owner and mode of the jar it replaces", async () => {
    const r = await runJar({}, { currentMode: 0o600 });
    try {
      expect(r.status).toBe(0);
      const target = join(r.deployDir, "core-web-service.jar");
      expect(modeOf(target)).toBe(0o600);
      const staged = join(
        r.deployDir,
        INCOMING,
        "bundle/artifact/core-0.0.1-SNAPSHOT.jar"
      );
      expect(r.log).toContain(`chown --reference=${target} ${staged}\n`);
      expect(r.log).toContain(`chmod --reference=${target} ${staged}\n`);
      expect(r.log.indexOf("chown --reference")).toBeLessThan(
        r.log.indexOf("systemctl stop")
      );
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("first jar keeps the extracted owner and mode", async () => {
    const r = await runJar({}, { current: null });
    try {
      expect(r.status).toBe(0);
      expect(modeOf(join(r.deployDir, "core-web-service.jar"))).toBe(0o644);
      expect(r.log).not.toMatch(/^(chown|chmod) /m);
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("disabled unit: enables it and prints Enabled core", async () => {
    const r = await runJar({}, { env: { STUB_ENABLED: "disabled" } });
    try {
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Enabled core\n");
      expect(r.log).toContain("systemctl enable core\n");
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it(
    "crash loop (MainPID changes every poll): HEALTH TIMEOUT",
    async () => {
      const r = await runJar(
        { stableSeconds: 2, healthTimeoutSeconds: 5 },
        { env: { STUB_PID_CHANGES: "1" } }
      );
      try {
        expect(r.stdout).toContain("HEALTH TIMEOUT");
        expect(r.stdout).not.toContain("HEALTHY");
        expect(r.status).toBe(1);
        // No automatic revert.
        expect(read(join(r.deployDir, "core-web-service.jar"))).toBe("NEW");
      } finally {
        rmSync(r.root, { recursive: true });
      }
    },
    SLOW
  );

  it(
    "stable PID over the window: HEALTHY",
    async () => {
      const r = await runJar({ stableSeconds: 2, healthTimeoutSeconds: 10 });
      try {
        expect(r.stdout).toContain("HEALTHY");
        expect(r.status).toBe(0);
        expect(
          r.log.split("\n").filter((l) => l.includes("MainPID")).length
        ).toBeGreaterThanOrEqual(2);
      } finally {
        rmSync(r.root, { recursive: true });
      }
    },
    SLOW
  );

  it(
    "unit not active: HEALTH TIMEOUT",
    async () => {
      const r = await runJar(
        { healthTimeoutSeconds: 3 },
        { env: { STUB_STATE: "activating" } }
      );
      try {
        expect(r.stdout).toContain("HEALTH TIMEOUT");
        expect(r.status).toBe(1);
      } finally {
        rmSync(r.root, { recursive: true });
      }
    },
    SLOW
  );

  it(
    "health URL answering 503: HEALTH TIMEOUT",
    async () => {
      const r = await runJar(
        { healthUrl: "http://localhost:8080/health", healthTimeoutSeconds: 3 },
        { env: { STUB_HTTP_CODE: "503" } }
      );
      try {
        expect(r.stdout).toContain("HEALTH TIMEOUT");
        expect(r.status).toBe(1);
        expect(r.log).toContain(
          "curl -s -o /dev/null -w %{http_code} --max-time 5 http://localhost:8080/health"
        );
      } finally {
        rmSync(r.root, { recursive: true });
      }
    },
    SLOW
  );

  it("health URL answering 404: HEALTHY (below 500)", async () => {
    const r = await runJar(
      { healthUrl: "http://localhost:8080/health" },
      { env: { STUB_HTTP_CODE: "404" } }
    );
    try {
      expect(r.stdout).toContain("HEALTHY");
      expect(r.status).toBe(0);
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it(
    "health URL not answering (000): HEALTH TIMEOUT",
    async () => {
      const r = await runJar(
        { healthUrl: "http://localhost:8080/health", healthTimeoutSeconds: 2 },
        { env: { STUB_HTTP_CODE: "000" } }
      );
      try {
        expect(r.stdout).toContain("HEALTH TIMEOUT");
        expect(r.status).toBe(1);
      } finally {
        rmSync(r.root, { recursive: true });
      }
    },
    SLOW
  );

  for (const [label, jars] of [
    ["two jars", { "a.jar": "A", "b.jar": "B" }],
    ["no jar", { "readme.txt": "x" }],
    ["an empty jar", { "core.jar": "" }],
  ] as const) {
    it(`${label} staged: ARTIFACT INVALID, nothing touched`, async () => {
      const r = await runJar({}, { jars });
      try {
        expect(r.stdout).toContain("ARTIFACT INVALID");
        expect(r.status).toBe(1);
        expect(read(join(r.deployDir, "core-web-service.jar"))).toBe("OLD");
        expect(r.log).not.toMatch(/systemctl (stop|start)/);
        expect(existsSync(join(r.deployDir, INCOMING))).toBe(false);
      } finally {
        rmSync(r.root, { recursive: true });
      }
    });
  }
});

describe.concurrent("buildArtifactDeployScript stub runs (static)", () => {
  it("happy path: keeps prev, copies owner/mode/context, reloads, HEALTHY", async () => {
    const r = await runStatic();
    try {
      expect(r.stdout).toContain("HEALTHY");
      expect(r.status).toBe(0);
      expect(read(join(r.webRoot, "index.html"))).toBe("NEW");
      expect(read(join(r.webRoot, "assets/app.js"))).toBe("js");
      expect(read(`${r.webRoot}.opsdeck-prev/index.html`)).toBe("OLD");
      expect(existsSync(`${r.webRoot}.opsdeck-new`)).toBe(false);
      expect(existsSync(`${r.webRoot}${INCOMING}`)).toBe(false);
      const staged = `${r.webRoot}${INCOMING}/bundle/artifact`;
      expect(r.log).toContain(`chown -R --reference=${r.webRoot} ${staged}\n`);
      expect(r.log).toContain(`chmod --reference=${r.webRoot} ${staged}\n`);
      expect(r.log).not.toContain("chmod -R");
      expect(r.log).toContain(`chcon -R --reference=${r.webRoot} ${staged}\n`);
      expect(r.log.indexOf("nginx -t")).toBeLessThan(
        r.log.indexOf("systemctl reload nginx")
      );
      expect(r.log).toContain(
        `flock -w 600 9 -> ${r.webRoot}.opsdeck-deploy.lock`
      );
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("new root gets the old root dir's mode; file modes stay as built", async () => {
    const r = await runStatic({ rootMode: 0o750 });
    try {
      expect(r.status).toBe(0);
      expect(modeOf(r.webRoot)).toBe(0o750);
      expect(modeOf(join(r.webRoot, "assets/app.js"))).toBe(0o644);
      expect(modeOf(join(r.webRoot, "assets"))).toBe(0o755);
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("leaves another deployment's staging dir alone", async () => {
    const r = await runStatic();
    try {
      expect(r.status).toBe(0);
      expect(existsSync(`${r.webRoot}${INCOMING}`)).toBe(false);
      expect(
        read(
          join(
            artifactStagingDir("static", r.webRoot, OTHER_ID),
            "bundle/artifact/index.html"
          )
        )
      ).toBe("OTHER");
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("SELinux disabled: no chcon", async () => {
    const r = await runStatic({ env: { STUB_SELINUX: "1" } });
    try {
      expect(r.status).toBe(0);
      expect(r.log).not.toContain("chcon");
      expect(r.log).toContain("chown -R --reference");
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("first deploy with no web root: no chown/chmod/chcon, root created, reload", async () => {
    const r = await runStatic({ current: null });
    try {
      expect(r.stdout).toContain("HEALTHY");
      expect(r.status).toBe(0);
      expect(read(join(r.webRoot, "index.html"))).toBe("NEW");
      expect(existsSync(`${r.webRoot}.opsdeck-prev`)).toBe(false);
      expect(r.log).not.toMatch(/^(chown|chmod|chcon) /m);
      expect(r.log).toContain("systemctl reload nginx");
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("nginx -t failing: old root restored, new tree removed, NGINX CONFIG INVALID, no reload", async () => {
    const r = await runStatic({ env: { STUB_NGINX_FAIL: "1" } });
    try {
      expect(r.stdout).toContain("NGINX CONFIG INVALID");
      expect(r.stdout).not.toContain("HEALTHY");
      expect(r.status).toBe(1);
      expect(read(join(r.webRoot, "index.html"))).toBe("OLD");
      expect(existsSync(`${r.webRoot}.opsdeck-prev`)).toBe(false);
      expect(existsSync(`${r.webRoot}.opsdeck-new`)).toBe(false);
      expect(existsSync(`${r.webRoot}${INCOMING}`)).toBe(false);
      expect(r.log).not.toContain("systemctl reload");
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("nginx -t failing on a first deploy: no web root left behind", async () => {
    const r = await runStatic({
      current: null,
      env: { STUB_NGINX_FAIL: "1" },
    });
    try {
      expect(r.stdout).toContain("NGINX CONFIG INVALID");
      expect(r.status).toBe(1);
      expect(existsSync(r.webRoot)).toBe(false);
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("replaces a stale .opsdeck-new left by an earlier run", async () => {
    const r = await runStatic({ staleNext: true });
    try {
      expect(r.status).toBe(0);
      expect(readdirSync(r.webRoot).sort()).toEqual(["assets", "index.html"]);
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("swaps the root under the host-wide nginx lock", async () => {
    const r = await runStatic();
    try {
      expect(r.status).toBe(0);
      const lockLine = r.log.indexOf(`flock -w 120 8 -> ${r.lock}`);
      expect(lockLine).toBeGreaterThanOrEqual(0);
      expect(lockLine).toBeLessThan(r.log.indexOf("nginx -t"));
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });

  it("no index.html staged: ARTIFACT INVALID, root untouched", async () => {
    const r = await runStatic({ index: false });
    try {
      expect(r.stdout).toContain("ARTIFACT INVALID");
      expect(r.status).toBe(1);
      expect(read(join(r.webRoot, "index.html"))).toBe("OLD");
      expect(r.log).not.toContain("nginx");
      expect(existsSync(`${r.webRoot}${INCOMING}`)).toBe(false);
    } finally {
      rmSync(r.root, { recursive: true });
    }
  });
});

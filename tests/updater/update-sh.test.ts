import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  serializeUpdateRequest,
  type UpdateRequest,
  updateRequestSchema,
  updateStatusSchema,
} from "@/lib/updates/request";

// ops/install/update.sh runs as root on the host. Here it runs as the test
// user under `sh` against a temp install dir, with stub `docker`, `curl` and
// `sleep` on PATH. The docker stub reads OPSDECK_VERSION from ./.env (compose's
// working dir) on every call, so the log shows which release each step ran
// under; `up` "deploys" that version, and the health stub reports it.

const SCRIPT = join(__dirname, "..", "..", "ops/install/update.sh");
const SECRET = "secrets-key-Zq9!do-not-log";

const STUB_DOCKER = `#!/bin/sh
v=$(sed -n 's/^OPSDECK_VERSION=//p' ./.env)
printf 'docker %s [%s]\\n' "$*" "$v" >> "$STUB_LOG"
case "$*" in
  "compose run --rm app opsdeck backup run --trigger update") step=backup ;;
  "compose pull") step=pull ;;
  "compose run --rm migrate") step=migrate ;;
  "compose up -d --wait --wait-timeout 180") step=up ;;
  "compose stop app terminal") step=stop ;;
  "compose run --rm app opsdeck restore "*) step=restore ;;
  *) echo "unexpected docker call" >&2; exit 99 ;;
esac
if [ "$step" = "\${STUB_SNAPSHOT:-}" ]; then cp updates/status.json "$STUB_STATE/snapshot.json"; fi
if [ "$step" = "\${STUB_FAIL:-}" ] && [ ! -e "$STUB_STATE/failed-$step" ]; then
  : > "$STUB_STATE/failed-$step"
  if [ "$step" = backup ]; then
    echo '{"id":null,"status":"alreadyRunning","location":"local","objectKey":null,"errorCode":"backupAlreadyRunning"}'
  fi
  echo "$step went wrong" >&2
  exit 1
fi
case $step in
  backup) echo '{"id":"b1","status":"succeeded","location":"local","objectKey":"opsdeck/x/","errorCode":null}' ;;
  up) printf '%s' "$v" > "$STUB_STATE/deployed" ;;
esac
exit 0
`;

const STUB_CURL = `#!/bin/sh
out=; host=; url=
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift ;;
    -H) host=$2; shift ;;
    -w|--max-time|--proto|--proto-redir) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
printf 'curl %s %s\\n' "$url" "$host" >> "$STUB_LOG"
case $url in
  https://github.com/romikusumabakti/opsdeck/releases/download/v*/release.json)
    ver=\${url#*/download/v}; ver=\${ver%%/*}
    if [ -f "$STUB_RELEASES/$ver.json" ]; then
      cp "$STUB_RELEASES/$ver.json" "$out"; printf 200
    else
      printf 'Not Found' > "$out"; printf 404
    fi ;;
  http://127.0.0.1:8080/api/health)
    d=$(cat "$STUB_STATE/deployed")
    if [ "$host" != "Host: panel.example.test" ] || [ "$d" = "\${STUB_HEALTH_FAIL_VERSION:-}" ]; then
      printf 'bad gateway' > "$out"; printf 502
    else
      printf '{"ok":true,"version":"%s"}' "$d" > "$out"; printf 200
    fi ;;
  *) exit 6 ;;
esac
`;

const IMAGE_KEYS = {
  OPSDECK_IMAGE: ["app", "ghcr.io/romikusumabakti/opsdeck"],
  POSTGRES_IMAGE: ["postgres", "docker.io/library/postgres"],
  VALKEY_IMAGE: ["valkey", "docker.io/valkey/valkey"],
  GARAGE_IMAGE: ["garage", "docker.io/dxflrs/garage"],
  IMGPROXY_IMAGE: ["imgproxy", "ghcr.io/imgproxy/imgproxy"],
  CADDY_IMAGE: ["caddy", "docker.io/library/caddy"],
} as const;

function image(name: string, version: string) {
  const digest = createHash("sha256")
    .update(`${name}@${version}`)
    .digest("hex");
  return `${name}:${version}@sha256:${digest}`;
}

function imageLines(version: string) {
  return [
    `OPSDECK_VERSION=${version}`,
    ...Object.entries(IMAGE_KEYS).map(
      ([key, [, name]]) => `${key}=${image(name, version)}`
    ),
  ];
}

function releaseJson(version: string, minFrom: string) {
  const images = Object.fromEntries(
    Object.values(IMAGE_KEYS).map(([key, name]) => [key, image(name, version)])
  );
  return JSON.stringify({
    version,
    minFrom,
    images,
    notesUrl: `https://github.com/romikusumabakti/opsdeck/releases/tag/v${version}`,
  });
}

function envFile(version: string) {
  return [
    "# opsdeck instance",
    "COMPOSE_PROJECT_NAME=opsdeck",
    "OPSDECK_DIR=/opt/opsdeck",
    ...imageLines(version),
    "OPSDECK_HTTP_PORT=8080",
    "BETTER_AUTH_URL=https://panel.example.test",
    `SECRETS_KEY=${SECRET}`,
    "POSTGRES_PASSWORD=pg-pass-do-not-log",
    "",
  ].join("\n");
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

type Setup = {
  current?: string;
  releases?: Record<string, string>;
};

function setup({ current = "1.2.0", releases = {} }: Setup = {}) {
  const root = mkdtempSync(join(tmpdir(), "update-sh-"));
  roots.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const rel = join(root, "releases");
  const dir = join(root, "opsdeck");
  const updates = join(dir, "updates");
  for (const d of [bin, state, rel, updates]) mkdirSync(d, { recursive: true });
  chmodSync(updates, 0o770);
  for (const [name, body] of [
    ["docker", STUB_DOCKER],
    ["curl", STUB_CURL],
    ["sleep", "#!/bin/sh\nexit 0\n"],
  ] as const) {
    writeFileSync(join(bin, name), body, { mode: 0o755 });
  }
  const defaults: Record<string, string> = {
    "1.2.0": "1.0.0",
    "1.3.0": "1.0.0",
    "2.0.0": "1.3.0",
    "1.1.0": "1.0.0",
  };
  for (const [v, minFrom] of Object.entries({ ...defaults, ...releases })) {
    writeFileSync(join(rel, `${v}.json`), `${releaseJson(v, minFrom)}\n`);
  }
  const env = envFile(current);
  writeFileSync(join(dir, ".env"), env, { mode: 0o600 });
  writeFileSync(join(state, "deployed"), current);
  const log = join(state, "calls.log");
  writeFileSync(log, "");

  const writeRequest = (content: string) =>
    writeFileSync(join(updates, "request.json"), content);
  const request = (r: UpdateRequest) => writeRequest(serializeUpdateRequest(r));

  const run = (extraEnv: Record<string, string> = {}, wrap: string[] = []) => {
    const result = spawnSync(wrap[0] ?? "sh", [...wrap.slice(1), SCRIPT, dir], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: root,
        STUB_LOG: log,
        STUB_STATE: state,
        STUB_RELEASES: rel,
        ...extraEnv,
      },
    });
    return result;
  };

  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const dockerCalls = () => calls().filter((c) => c.startsWith("docker "));
  const statusPath = join(updates, "status.json");
  const status = () =>
    updateStatusSchema.parse(JSON.parse(readFileSync(statusPath, "utf8")));
  const readEnv = () => readFileSync(join(dir, ".env"), "utf8");
  const logs = () => {
    const logsDir = join(updates, "logs");
    return existsSync(logsDir)
      ? readdirSync(logsDir).map((f) => readFileSync(join(logsDir, f), "utf8"))
      : [];
  };

  return {
    root,
    dir,
    updates,
    state,
    env,
    run,
    request,
    writeRequest,
    calls,
    dockerCalls,
    status,
    statusPath,
    readEnv,
    logs,
  };
}

const by = { requestedBy: "0195f0c2-7d1e-7abc-8def-0123456789ab" };
const at = { requestedAt: "2026-11-09T10:00:00.000Z" };
const updateTo = (version: string): UpdateRequest => ({
  action: "update",
  version,
  ...by,
  ...at,
});

function expectNoSecrets(t: ReturnType<typeof setup>) {
  for (const text of [...t.logs(), readFileSync(t.statusPath, "utf8")]) {
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("pg-pass-do-not-log");
  }
}

describe("update.sh", () => {
  it.each([
    ["shell metacharacters", '"1.2.3; rm -rf /"'],
    ["a path", '"../x"'],
  ])("rejects non-version request (%s)", (_name, version) => {
    const t = setup();
    t.writeRequest(
      `{"action":"update","version":${version},"requestedBy":"u1","requestedAt":"2026-11-09T10:00:00.000Z"}\n`
    );
    const result = t.run();
    expect(result.status).toBe(1);
    expect(t.status()).toMatchObject({
      action: null,
      version: null,
      from: "1.2.0",
      step: "validate",
      state: "refused",
      code: "invalidRequest",
    });
    expect(t.calls()).toEqual([]);
    expect(t.readEnv()).toBe(t.env);
  });

  it.each([
    [
      "extra key",
      '{"action":"update","version":"1.3.0","requestedBy":"u1","requestedAt":"2026-11-09T10:00:00.000Z","x":1}',
    ],
    [
      "two lines",
      '{"action":"update","version":"1.3.0",\n"requestedBy":"u1","requestedAt":"2026-11-09T10:00:00.000Z"}',
    ],
    [
      "restore key with ..",
      '{"action":"restore","objectKey":"local:a/../../etc/","version":"1.2.0","requestedBy":"u1","requestedAt":"2026-11-09T10:00:00.000Z"}',
    ],
    [
      "restore key over 511 characters",
      `{"action":"restore","objectKey":"local:${"a".repeat(512)}","version":"1.2.0","requestedBy":"u1","requestedAt":"2026-11-09T10:00:00.000Z"}`,
    ],
    [
      "restore key as an option",
      '{"action":"restore","objectKey":"--help","version":"1.2.0","requestedBy":"u1","requestedAt":"2026-11-09T10:00:00.000Z"}',
    ],
  ])("rejects a non-canonical request (%s)", (_name, content) => {
    const t = setup();
    t.writeRequest(content);
    expect(t.run().status).toBe(1);
    expect(t.status()).toMatchObject({
      state: "refused",
      code: "invalidRequest",
    });
    expect(t.calls()).toEqual([]);
  });

  it("does not follow a symlinked request", () => {
    const t = setup();
    const target = join(t.root, "elsewhere.json");
    writeFileSync(target, serializeUpdateRequest(updateTo("1.3.0")));
    symlinkSync(target, join(t.updates, "request.json"));
    expect(t.run().status).toBe(1);
    expect(t.status()).toMatchObject({
      state: "refused",
      code: "invalidRequest",
    });
    expect(t.calls()).toEqual([]);
  });

  it("rejects below minFrom", () => {
    const t = setup();
    t.request(updateTo("2.0.0"));
    expect(t.run().status).toBe(1);
    expect(t.status()).toMatchObject({
      action: "update",
      version: "2.0.0",
      from: "1.2.0",
      state: "refused",
      code: "belowMinFrom",
    });
    expect(t.dockerCalls()).toEqual([]);
    expect(t.readEnv()).toBe(t.env);
  });

  it("rejects downgrade", () => {
    const t = setup();
    t.request(updateTo("1.1.0"));
    expect(t.run().status).toBe(1);
    expect(t.status()).toMatchObject({ state: "refused", code: "downgrade" });
    expect(t.dockerCalls()).toEqual([]);
  });

  it("refuses a release.json with a non-digest image", () => {
    const t = setup();
    const bad = JSON.parse(releaseJson("1.3.0", "1.0.0"));
    bad.images.app = "ghcr.io/romikusumabakti/opsdeck:latest";
    writeFileSync(join(t.root, "releases", "1.3.0.json"), JSON.stringify(bad));
    t.request(updateTo("1.3.0"));
    expect(t.run().status).toBe(1);
    expect(t.status()).toMatchObject({
      state: "refused",
      code: "invalidRelease",
    });
    expect(t.dockerCalls()).toEqual([]);
  });

  it("backup failure aborts update", () => {
    const t = setup();
    t.request(updateTo("1.3.0"));
    expect(t.run({ STUB_FAIL: "backup" }).status).toBe(1);
    const status = t.status();
    expect(status).toMatchObject({
      step: "backup",
      state: "failed",
      code: "backupFailed",
    });
    expect(status.logTail.join("\n")).toContain("backupAlreadyRunning");
    expect(t.dockerCalls()).toEqual([
      "docker compose run --rm app opsdeck backup run --trigger update [1.2.0]",
    ]);
    expect(t.readEnv()).toBe(t.env);
  });

  it("rolls back when health fails", () => {
    const t = setup();
    t.request(updateTo("1.3.0"));
    expect(t.run({ STUB_HEALTH_FAIL_VERSION: "1.3.0" }).status).toBe(1);
    expect(t.status()).toMatchObject({
      step: "rollback",
      state: "rolled_back",
      code: "healthFailed",
    });
    expect(t.readEnv()).toBe(t.env);
    const previous = readFileSync(join(t.updates, "previous.env"), "utf8");
    expect(previous).toBe(`${imageLines("1.2.0").join("\n")}\n`);
    const envLines = t.readEnv().split("\n");
    for (const line of previous.trim().split("\n")) {
      expect(envLines).toContain(line);
    }
    expect(t.dockerCalls()).toEqual([
      "docker compose run --rm app opsdeck backup run --trigger update [1.2.0]",
      "docker compose pull [1.3.0]",
      "docker compose run --rm migrate [1.3.0]",
      "docker compose up -d --wait --wait-timeout 180 [1.3.0]",
      "docker compose up -d --wait --wait-timeout 180 [1.2.0]",
    ]);
    expectNoSecrets(t);
  });

  it("rolls back when migrate fails", () => {
    const t = setup();
    t.request(updateTo("1.3.0"));
    expect(t.run({ STUB_FAIL: "migrate" }).status).toBe(1);
    expect(t.status()).toMatchObject({
      state: "rolled_back",
      code: "migrateFailed",
    });
    expect(t.readEnv()).toBe(t.env);
    expect(t.dockerCalls().at(-1)).toBe(
      "docker compose up -d --wait --wait-timeout 180 [1.2.0]"
    );
  });

  it("succeeds", () => {
    const t = setup();
    t.request(updateTo("1.3.0"));
    const result = t.run();
    expect(result.status, result.stderr).toBe(0);
    expect(t.calls()).toEqual([
      "curl https://github.com/romikusumabakti/opsdeck/releases/download/v1.3.0/release.json ",
      "docker compose run --rm app opsdeck backup run --trigger update [1.2.0]",
      "docker compose pull [1.3.0]",
      "docker compose run --rm migrate [1.3.0]",
      "docker compose up -d --wait --wait-timeout 180 [1.3.0]",
      "curl http://127.0.0.1:8080/api/health Host: panel.example.test",
    ]);
    const status = t.status();
    expect(status).toMatchObject({
      action: "update",
      version: "1.3.0",
      from: "1.2.0",
      step: "done",
      state: "succeeded",
      code: null,
    });
    expect(status.finishedAt).not.toBeNull();
    // Only the pinned lines changed; secrets and everything else are kept.
    expect(t.readEnv()).toBe(
      t.env
        .split("\n")
        .map((line) => {
          const key = line.split("=")[0] ?? "";
          const next = imageLines("1.3.0").find((l) => l.startsWith(`${key}=`));
          return next ?? line;
        })
        .join("\n")
    );
    expect(statSync(join(t.dir, ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(t.statusPath).mode & 0o777).toBe(0o640);
    // The request is consumed, so it cannot be replayed.
    expect(existsSync(join(t.updates, "request.json"))).toBe(false);
    expectNoSecrets(t);
  });

  it("status survives app restart", () => {
    // The app never writes status.json: the host run records each step while
    // `up` replaces the app container, and the final result is on disk for
    // the new app to read.
    const t = setup();
    t.request(updateTo("1.3.0"));
    expect(t.run({ STUB_SNAPSHOT: "up" }).status).toBe(0);
    const during = updateStatusSchema.parse(
      JSON.parse(readFileSync(join(t.state, "snapshot.json"), "utf8"))
    );
    expect(during).toMatchObject({
      step: "up",
      state: "running",
      finishedAt: null,
    });
    const after = t.status();
    expect(after).toMatchObject({ runId: during.runId, state: "succeeded" });
    expect(after.logTail.length).toBeGreaterThan(0);
    const logsDir = join(t.updates, "logs");
    expect(readdirSync(logsDir)).toContain(`${after.runId}.log`);
    expect(statSync(logsDir).mode & 0o777).toBe(0o750);
    expect(statSync(t.updates).mode & 0o7777).toBe(0o1770);
  });

  it("restore pins manifest version, then updates to the newer one", () => {
    const t = setup({ current: "1.3.0" });
    t.request({
      action: "restore",
      objectKey: "opsdeck-backups/opsdeck/2026-11-08T023000.000Z-a1b2c3-1.2.0/",
      version: "1.2.0",
      ...by,
      ...at,
    });
    const result = t.run();
    expect(result.status, result.stderr).toBe(0);
    expect(t.dockerCalls()).toEqual([
      "docker compose pull [1.2.0]",
      "docker compose stop app terminal [1.2.0]",
      "docker compose run --rm app opsdeck restore opsdeck-backups/opsdeck/2026-11-08T023000.000Z-a1b2c3-1.2.0/ [1.2.0]",
      "docker compose up -d --wait --wait-timeout 180 [1.2.0]",
      "docker compose pull [1.3.0]",
      "docker compose run --rm migrate [1.3.0]",
      "docker compose up -d --wait --wait-timeout 180 [1.3.0]",
    ]);
    expect(
      t.calls().filter((c) => c.startsWith("curl http://127.0.0.1"))
    ).toHaveLength(2);
    expect(t.status()).toMatchObject({
      action: "restore",
      version: "1.2.0",
      from: "1.3.0",
      step: "done",
      state: "succeeded",
    });
    expect(t.readEnv()).toBe(t.env);
  });

  it("restore stays on the manifest version when it is current", () => {
    const t = setup({ current: "1.2.0" });
    t.request({
      action: "restore",
      objectKey: "local:opsdeck/2026-11-08T023000.000Z-a1b2c3-1.2.0/",
      version: "1.2.0",
      ...by,
      ...at,
    });
    expect(t.run().status).toBe(0);
    expect(t.dockerCalls().map((c) => c.split(" ")[2])).toEqual([
      "pull",
      "stop",
      "run",
      "up",
    ]);
  });

  it("rolls back a failed restore to the running images", () => {
    const t = setup({ current: "1.3.0" });
    t.request({
      action: "restore",
      objectKey: "local:opsdeck/x/",
      version: "1.2.0",
      ...by,
      ...at,
    });
    expect(t.run({ STUB_FAIL: "restore" }).status).toBe(1);
    expect(t.status()).toMatchObject({
      state: "rolled_back",
      code: "restoreFailed",
    });
    expect(t.readEnv()).toBe(t.env);
    expect(t.dockerCalls().at(-1)).toBe(
      "docker compose up -d --wait --wait-timeout 180 [1.3.0]"
    );
  });

  it("refuses newer backup", () => {
    const t = setup({ current: "1.2.0" });
    t.request({
      action: "restore",
      objectKey: "local:opsdeck/x/",
      version: "1.4.0",
      ...by,
      ...at,
    });
    expect(t.run().status).toBe(1);
    expect(t.status()).toMatchObject({
      action: "restore",
      version: "1.4.0",
      state: "refused",
      code: "backupTooNew",
    });
    expect(t.dockerCalls()).toEqual([]);
    expect(t.readEnv()).toBe(t.env);
  });

  it("lock prevents a second run", () => {
    const t = setup();
    t.request(updateTo("1.3.0"));
    const lock = join(t.updates, ".lock");
    writeFileSync(lock, "");
    // flock(1) holds the lock while the script runs inside it.
    const result = t.run({}, ["flock", lock, "sh"]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(t.statusPath)).toBe(false);
    expect(existsSync(join(t.updates, "request.json"))).toBe(true);
    expect(t.calls()).toEqual([]);
  });

  it("does nothing without a request", () => {
    const t = setup();
    expect(t.run().status).toBe(0);
    expect(existsSync(t.statusPath)).toBe(false);
    expect(t.calls()).toEqual([]);
  });

  it("shellcheck clean", (ctx) => {
    const probe = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      console.warn("shellcheck not found; skipping the lint of update.sh");
      ctx.skip();
    }
    const result = spawnSync("shellcheck", ["-s", "sh", SCRIPT], {
      encoding: "utf8",
    });
    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("update request file", () => {
  it("serializes the canonical single line update.sh accepts", () => {
    expect(serializeUpdateRequest(updateTo("1.3.0-beta.2"))).toBe(
      '{"action":"update","version":"1.3.0-beta.2","requestedBy":"0195f0c2-7d1e-7abc-8def-0123456789ab","requestedAt":"2026-11-09T10:00:00.000Z"}\n'
    );
  });

  it.each([
    { ...updateTo("1.2.3; rm -rf /") },
    { ...updateTo("v1.2.3") },
    { ...updateTo("1.2.3"), extra: true },
    {
      action: "restore",
      objectKey: "local:a/../b/",
      version: "1.2.0",
      ...by,
      ...at,
    },
  ])("rejects %o", (input) => {
    expect(updateRequestSchema.safeParse(input).success).toBe(false);
  });
});

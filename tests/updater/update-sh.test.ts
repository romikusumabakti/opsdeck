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
// under; `up` "deploys" that version, and the health stub reports it. Each
// release's compose.yaml starts with `# compose v<version>`: a call made with
// a compose.yaml of another release than .env's is marked `compose=<v>`.

const SCRIPT = join(__dirname, "..", "..", "ops/install/update.sh");
const SECRET = "secrets-key-Zq9!do-not-log";

const STUB_DOCKER = `#!/bin/sh
v=$(sed -n 's/^OPSDECK_VERSION=//p' ./.env)
c=$(sed -n 's/^# compose v//p' ./compose.yaml)
if [ "$c" = "$v" ]; then
  printf 'docker %s [%s]\\n' "$*" "$v" >> "$STUB_LOG"
else
  printf 'docker %s [%s] compose=%s\\n' "$*" "$v" "$c" >> "$STUB_LOG"
fi
case "$*" in
  "compose run --rm --no-deps app opsdeck backup run --trigger "*) step=backup ;;
  "compose pull") step=pull ;;
  "compose run --rm migrate") step=migrate ;;
  "compose up -d --wait --wait-timeout 180") step=up ;;
  "compose stop app terminal") step=stop ;;
  "compose run --rm --no-deps app opsdeck restore "*) step=restore ;;
  *) echo "unexpected docker call" >&2; exit 99 ;;
esac
if [ "$step" = "\${STUB_SNAPSHOT:-}" ]; then cp updates/status.json "$STUB_STATE/snapshot.json"; fi
# A request written while this run is busy.
if [ "$step" = up ] && [ -n "\${STUB_NEW_REQUEST:-}" ] && [ ! -e "$STUB_STATE/new-request" ]; then
  : > "$STUB_STATE/new-request"
  cp "$STUB_NEW_REQUEST" updates/request.json
fi
if [ "$step" = "\${STUB_NOISY:-}" ]; then
  printf '\\033[1;31mred alert\\033[0m \\033]0;title\\007done\\n'
  printf 'x%0200d\\n' 0 | sed 's/0/é/g'
fi
# What systemd does on stop or timeout: TERM while a step is running.
if [ "$step" = "\${STUB_KILL:-}" ] || [ "$step@$v" = "\${STUB_KILL:-}" ]; then
  kill -TERM "$PPID"
  sleep 1
  exit 1
fi
if [ "$step" = "\${STUB_FAIL:-}" ] && [ ! -e "$STUB_STATE/failed-$step" ]; then
  : > "$STUB_STATE/failed-$step"
  if [ "$step" = backup ]; then
    echo '{"id":null,"status":"alreadyRunning","location":"local","objectKey":null,"errorCode":"backupAlreadyRunning"}'
  fi
  echo "$step went wrong" >&2
  exit 1
fi
if [ "$step" = restore ] && [ -n "\${STUB_RESTORE_REFUSE:-}" ]; then
  echo '{"status":"refused","errorCode":"'"$STUB_RESTORE_REFUSE"'"}'
  exit 3
fi
case "$*" in
  *"--trigger restore") if [ -n "\${STUB_BACKUP_GARBLED:-}" ]; then echo 'backup done'; exit 0; fi ;;
esac
case $step in
  backup)
    if [ -n "\${STUB_BACKUP_NO_LOCAL:-}" ]; then local_key=null; else local_key='"opsdeck/2026-11-09T100000.000Z-abcdef-'"$v"'/"'; fi
    echo '{"id":"0195f0c2-0000-7abc-8def-0123456789ab","status":"succeeded","location":"s3","objectKey":"opsdeck-backups/opsdeck/2026-11-09T100000.000Z-abcdef-'"$v"'/","localObjectKey":'"$local_key"',"errorCode":null}' ;;
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
  https://github.com/romikusumabakti/opsdeck/releases/download/v*/compose.yaml | https://github.com/romikusumabakti/opsdeck/releases/download/v*/update.sh)
    rest=\${url#*/download/v}; ver=\${rest%%/*}; asset=\${rest#*/}
    if [ -f "$STUB_RELEASES/$ver/$asset" ]; then
      cp "$STUB_RELEASES/$ver/$asset" "$out"; printf 200
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

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** The release's compose.yaml and update.sh (as published next to it). */
const composeOf = (version: string) => `# compose v${version}\nservices: {}\n`;
const updaterOf = (version: string) =>
  `#!/bin/sh\n# update.sh of v${version}\nexit 0\n`;

function releaseJson(version: string, minFrom: string) {
  const images = Object.fromEntries(
    Object.values(IMAGE_KEYS).map(([key, name]) => [key, image(name, version)])
  );
  return JSON.stringify({
    version,
    minFrom,
    images,
    assets: {
      "compose.yaml": sha256(composeOf(version)),
      "update.sh": sha256(updaterOf(version)),
    },
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
    // Health retries need no real wait; the TERM stub's own `sleep 1` is real.
    ["sleep", '#!/bin/sh\n[ "$1" = 1 ] && exec /bin/sleep 1\nexit 0\n'],
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
    mkdirSync(join(rel, v));
    writeFileSync(join(rel, v, "compose.yaml"), composeOf(v));
    writeFileSync(join(rel, v, "update.sh"), updaterOf(v));
  }
  const env = envFile(current);
  writeFileSync(join(dir, ".env"), env, { mode: 0o600 });
  writeFileSync(join(dir, "compose.yaml"), composeOf(current));
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
  const readCompose = () => readFileSync(join(dir, "compose.yaml"), "utf8");
  const updater = join(dir, ".updater");
  const logs = () => {
    const logsDir = join(updates, "logs");
    return existsSync(logsDir)
      ? readdirSync(logsDir).map((f) => readFileSync(join(logsDir, f), "utf8"))
      : [];
  };

  return {
    root,
    bin,
    dir,
    updates,
    updater,
    rel,
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
    readCompose,
    logs,
  };
}

const by = { requestedBy: "0195f0c2-7d1e-7abc-8def-0123456789ab" };
const at = { requestedAt: "2026-11-09T10:00:00.000Z" };
const restoreOf = (version: string): UpdateRequest => ({
  action: "restore",
  objectKey: `local:opsdeck/2026-11-08T023000.000Z-a1b2c3-${version}/`,
  version,
  ...by,
  ...at,
});
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
      "docker compose run --rm --no-deps app opsdeck backup run --trigger update [1.2.0]",
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
    const previous = readFileSync(join(t.updater, "previous.env"), "utf8");
    expect(previous).toBe(`${imageLines("1.2.0").join("\n")}\n`);
    const envLines = t.readEnv().split("\n");
    for (const line of previous.trim().split("\n")) {
      expect(envLines).toContain(line);
    }
    expect(t.dockerCalls()).toEqual([
      "docker compose run --rm --no-deps app opsdeck backup run --trigger update [1.2.0]",
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
      "curl https://github.com/romikusumabakti/opsdeck/releases/download/v1.3.0/compose.yaml ",
      "curl https://github.com/romikusumabakti/opsdeck/releases/download/v1.3.0/update.sh ",
      "docker compose run --rm --no-deps app opsdeck backup run --trigger update [1.2.0]",
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
      "docker compose run --rm --no-deps app opsdeck backup run --trigger restore [1.3.0]",
      "docker compose pull [1.2.0]",
      "docker compose stop app terminal [1.2.0]",
      "docker compose run --rm --no-deps app opsdeck restore opsdeck-backups/opsdeck/2026-11-08T023000.000Z-a1b2c3-1.2.0/ [1.2.0]",
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
      // The update phase started from the restored version.
      from: "1.2.0",
      step: "done",
      state: "succeeded",
      // The local copy, so undoing never needs the destination settings.
      safetyBackup: {
        id: "0195f0c2-0000-7abc-8def-0123456789ab",
        location: "local",
        objectKey: "opsdeck/2026-11-09T100000.000Z-abcdef-1.3.0/",
      },
    });
    expect(t.readEnv()).toBe(t.env);
  });

  it("a failed update after a restore rolls back to the restored version", () => {
    const t = setup({ current: "1.3.0" });
    t.request(restoreOf("1.2.0"));
    expect(t.run({ STUB_HEALTH_FAIL_VERSION: "1.3.0" }).status).toBe(1);
    expect(t.status()).toMatchObject({
      state: "rolled_back",
      code: "healthFailed",
      from: "1.2.0",
    });
    expect(t.readEnv()).toBe(envFile("1.2.0"));
  });

  it("a failed safety backup aborts the restore", () => {
    const t = setup({ current: "1.3.0" });
    t.request(restoreOf("1.2.0"));
    expect(t.run({ STUB_FAIL: "backup" }).status).toBe(1);
    expect(t.status()).toMatchObject({ state: "failed", code: "backupFailed" });
    expect(t.dockerCalls()).toEqual([
      "docker compose run --rm --no-deps app opsdeck backup run --trigger restore [1.3.0]",
    ]);
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
      "run",
      "pull",
      "stop",
      "run",
      "up",
    ]);
  });

  it("a failed restore stays on the restore version and offers the safety backup", () => {
    const t = setup({ current: "1.3.0" });
    t.request(restoreOf("1.2.0"));
    expect(t.run({ STUB_FAIL: "restore" }).status).toBe(1);
    const status = t.status();
    expect(status).toMatchObject({ state: "failed", code: "restoreFailed" });
    expect(status.safetyBackup).toMatchObject({
      location: "local",
      objectKey: "opsdeck/2026-11-09T100000.000Z-abcdef-1.3.0/",
    });
    expect(t.readEnv()).toBe(envFile("1.2.0"));
    expect(t.dockerCalls().at(-1)).toBe(
      "docker compose up -d --wait --wait-timeout 180 [1.2.0]"
    );
  });

  it.each([
    ["restoreKeyMismatch", "restoreKeyMismatch"],
    ["somethingNew", "restoreRefused"],
  ])("a refused restore (exit 3, %s) rolls back", (cliCode, code) => {
    const t = setup({ current: "1.3.0" });
    t.request(restoreOf("1.2.0"));
    expect(t.run({ STUB_RESTORE_REFUSE: cliCode }).status).toBe(1);
    expect(t.status()).toMatchObject({ state: "rolled_back", code });
    expect(t.readEnv()).toBe(t.env);
    expect(t.dockerCalls().at(-1)).toBe(
      "docker compose up -d --wait --wait-timeout 180 [1.3.0]"
    );
  });

  it("a safety backup without a local copy aborts the restore", () => {
    const t = setup({ current: "1.3.0" });
    t.request(restoreOf("1.2.0"));
    expect(t.run({ STUB_BACKUP_NO_LOCAL: "1" }).status).toBe(1);
    expect(t.status()).toMatchObject({ state: "failed", code: "backupFailed" });
    expect(t.dockerCalls()).toEqual([
      "docker compose run --rm --no-deps app opsdeck backup run --trigger restore [1.3.0]",
    ]);
    expect(t.readEnv()).toBe(t.env);
  });

  it("an unreadable safety backup result aborts the restore", () => {
    const t = setup({ current: "1.3.0" });
    t.request(restoreOf("1.2.0"));
    expect(t.run({ STUB_BACKUP_GARBLED: "1" }).status).toBe(1);
    expect(t.status()).toMatchObject({ state: "failed", code: "backupFailed" });
    expect(t.dockerCalls()).toEqual([
      "docker compose run --rm --no-deps app opsdeck backup run --trigger restore [1.3.0]",
    ]);
    expect(existsSync(join(t.updater, "previous.env"))).toBe(false);
    expect(t.readEnv()).toBe(t.env);
  });

  it("TERM in the update after a restore rolls back to the restored version", () => {
    const t = setup({ current: "1.3.0" });
    t.request(restoreOf("1.2.0"));
    expect(t.run({ STUB_KILL: "pull@1.3.0" }).status).not.toBe(0);
    expect(t.status()).toMatchObject({
      state: "rolled_back",
      code: "interrupted",
      from: "1.2.0",
    });
    expect(t.readEnv()).toBe(envFile("1.2.0"));
    expect(t.dockerCalls().at(-1)).toBe(
      "docker compose up -d --wait --wait-timeout 180 [1.2.0]"
    );
  });

  it("a stop failure before the restore rolls back", () => {
    const t = setup({ current: "1.3.0" });
    t.request(restoreOf("1.2.0"));
    expect(t.run({ STUB_FAIL: "stop" }).status).toBe(1);
    expect(t.status()).toMatchObject({
      state: "rolled_back",
      code: "stopFailed",
    });
    expect(t.readEnv()).toBe(t.env);
  });

  it("TERM mid-migrate rolls back", () => {
    const t = setup();
    t.request(updateTo("1.3.0"));
    expect(t.run({ STUB_KILL: "migrate" }).status).not.toBe(0);
    expect(t.status()).toMatchObject({
      step: "rollback",
      state: "rolled_back",
      code: "interrupted",
    });
    expect(t.readEnv()).toBe(t.env);
    expect(t.dockerCalls().slice(-2)).toEqual([
      "docker compose run --rm migrate [1.3.0]",
      "docker compose up -d --wait --wait-timeout 180 [1.2.0]",
    ]);
  });

  it("TERM between stop and the restore brings the panel back", () => {
    const t = setup({ current: "1.3.0" });
    t.request(restoreOf("1.2.0"));
    expect(t.run({ STUB_KILL: "stop" }).status).not.toBe(0);
    expect(t.status()).toMatchObject({
      state: "rolled_back",
      code: "interrupted",
    });
    expect(t.readEnv()).toBe(t.env);
    expect(t.dockerCalls().at(-1)).toBe(
      "docker compose up -d --wait --wait-timeout 180 [1.3.0]"
    );
  });

  it("TERM mid-restore starts the restore version again", () => {
    const t = setup({ current: "1.3.0" });
    t.request(restoreOf("1.2.0"));
    expect(t.run({ STUB_KILL: "restore" }).status).not.toBe(0);
    expect(t.status()).toMatchObject({
      state: "failed",
      code: "restoreFailed",
    });
    expect(t.readEnv()).toBe(envFile("1.2.0"));
    expect(t.dockerCalls().at(-1)).toBe(
      "docker compose up -d --wait --wait-timeout 180 [1.2.0]"
    );
  });

  it("processes a request written during a run", () => {
    const t = setup();
    const next = join(t.root, "next.json");
    writeFileSync(next, serializeUpdateRequest(updateTo("1.3.0")));
    t.request(updateTo("1.3.0"));
    const first = t.run({ STUB_NEW_REQUEST: next });
    expect(first.status, first.stderr).toBe(0);
    const runLogs = readdirSync(join(t.updates, "logs"))
      .filter((f) => f.endsWith(".log"))
      .sort();
    expect(runLogs).toHaveLength(2);
    const status = t.status();
    expect(runLogs).toContain(`${status.runId}.log`);
    expect(status.state).toBe("succeeded");
    expect(
      t.dockerCalls().filter((c) => c.includes("backup run"))
    ).toHaveLength(2);
    expect(existsSync(join(t.updates, "request.json"))).toBe(false);
  });

  it("log tail drops ANSI escapes and never splits UTF-8", () => {
    const t = setup();
    t.request(updateTo("1.3.0"));
    t.run({ STUB_NOISY: "pull", STUB_FAIL: "pull" });
    const raw = readFileSync(t.statusPath);
    // Throws on any invalid UTF-8 sequence.
    new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const tail = t.status().logTail;
    expect(tail).toContain("red alert done");
    expect(tail.join("\n")).not.toMatch(/\[[0-9;]*m|title/);
    const long = tail.find((l) => l.startsWith("xé"));
    expect(long).toBeDefined();
    expect(Buffer.byteLength(long ?? "")).toBeLessThanOrEqual(300);
    expect(long).toMatch(/^xé+$/);
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
    mkdirSync(t.updater, { mode: 0o700 });
    const lock = join(t.updater, ".lock");
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

// awk on PATH that breaks only the program writing the new .env (like a full
// disk under the write): STUB_AWK=fail every time, fail-once the first time,
// truncate (output cut short, exit 0) the first time.
const REAL_AWK = spawnSync("sh", ["-c", "command -v awk"], {
  encoding: "utf8",
}).stdout.trim();
const STUB_AWK = `#!/bin/sh
case "$*" in
  *'line[$1] = $0'*)
    n=$(cat "$STUB_STATE/awk-calls" 2>/dev/null || echo 0); n=$((n + 1))
    echo "$n" > "$STUB_STATE/awk-calls"
    if [ "$STUB_AWK" = fail ] || { [ "$STUB_AWK" = fail-once ] && [ "$n" = 1 ]; }; then
      printf 'COMPOSE_PROJECT_NAME=opsdeck\\n'
      echo "awk: write error: No space left on device" >&2
      exit 2
    fi
    if [ "$STUB_AWK" = truncate ] && [ "$n" = 1 ]; then
      ${REAL_AWK} "$@" | head -n 2
      exit 0
    fi ;;
esac
exec ${REAL_AWK} "$@"
`;

describe("update.sh writes .env, compose.yaml and its state safely", () => {
  function withAwk(t: ReturnType<typeof setup>) {
    writeFileSync(join(t.bin, "awk"), STUB_AWK, { mode: 0o755 });
  }
  const leftovers = (dir: string) =>
    readdirSync(dir).filter((f) => /^\.(env|compose)\./.test(f));

  it("a failing .env write leaves .env as it was (rollbackFailed when the rollback cannot write either)", () => {
    const t = setup();
    withAwk(t);
    t.request(updateTo("1.3.0"));
    expect(t.run({ STUB_AWK: "fail" }).status).not.toBe(0);
    expect(t.readEnv()).toBe(t.env);
    expect(t.status()).toMatchObject({
      state: "failed",
      code: "rollbackFailed",
    });
    expect(t.status().logTail.join("\n")).toContain(".env is unchanged");
    expect(leftovers(t.dir)).toEqual([]);
    // No container ever ran under a half-written .env.
    expect(t.dockerCalls()).toEqual([
      "docker compose run --rm --no-deps app opsdeck backup run --trigger update [1.2.0]",
    ]);
    expectNoSecrets(t);
  });

  it("a failing .env write rolls back and keeps the last good .env in .updater/.env.prev", () => {
    const t = setup();
    withAwk(t);
    t.request(updateTo("1.3.0"));
    expect(t.run({ STUB_AWK: "fail-once" }).status).not.toBe(0);
    expect(t.readEnv()).toBe(t.env);
    expect(t.readCompose()).toBe(composeOf("1.2.0"));
    expect(t.status()).toMatchObject({
      state: "rolled_back",
      code: "updaterError",
    });
    const prev = join(t.updater, ".env.prev");
    expect(readFileSync(prev, "utf8")).toBe(t.env);
    expect(statSync(prev).mode & 0o777).toBe(0o600);
    expect(statSync(t.updater).mode & 0o777).toBe(0o700);
  });

  it("refuses a truncated .env (awk exit 0, lines missing)", () => {
    const t = setup();
    withAwk(t);
    t.request(updateTo("1.3.0"));
    expect(t.run({ STUB_AWK: "truncate" }).status).not.toBe(0);
    expect(t.readEnv()).toBe(t.env);
    expect(t.readEnv()).toContain(`SECRETS_KEY=${SECRET}`);
    expect(t.status()).toMatchObject({ state: "rolled_back" });
    expect(t.status().logTail.join("\n")).toContain(
      ".env: the new file is incomplete"
    );
  });

  it("keeps duplicate pinned lines from counting as truncation", () => {
    const t = setup();
    writeFileSync(join(t.dir, ".env"), `${t.env}OPSDECK_VERSION=1.2.0\n`, {
      mode: 0o600,
    });
    t.request(updateTo("1.3.0"));
    const result = t.run();
    expect(result.status, result.stderr).toBe(0);
    expect(
      t
        .readEnv()
        .split("\n")
        .filter((l) => l.startsWith("OPSDECK_VERSION="))
    ).toEqual(["OPSDECK_VERSION=1.3.0"]);
  });

  it("installs the release's compose.yaml with the images and keeps the previous one", () => {
    const t = setup();
    t.request(updateTo("1.3.0"));
    expect(t.run().status).toBe(0);
    expect(t.readCompose()).toBe(composeOf("1.3.0"));
    expect(statSync(join(t.dir, "compose.yaml")).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(t.updater, "compose.yaml.prev"), "utf8")).toBe(
      composeOf("1.2.0")
    );
    // Every step ran with the compose.yaml of its .env's release.
    expect(t.dockerCalls().join("\n")).not.toContain("compose=");
  });

  it("rolls compose.yaml back together with .env", () => {
    const t = setup();
    t.request(updateTo("1.3.0"));
    expect(t.run({ STUB_HEALTH_FAIL_VERSION: "1.3.0" }).status).toBe(1);
    expect(t.status()).toMatchObject({ state: "rolled_back" });
    expect(t.readEnv()).toBe(t.env);
    expect(t.readCompose()).toBe(composeOf("1.2.0"));
    expect(t.dockerCalls().join("\n")).not.toContain("compose=");
  });

  it("a restore runs under the backup's compose.yaml, then the current one", () => {
    const t = setup({ current: "1.3.0" });
    t.request(restoreOf("1.2.0"));
    expect(t.run().status).toBe(0);
    expect(t.readCompose()).toBe(composeOf("1.3.0"));
    expect(t.dockerCalls()).toContain(
      "docker compose run --rm --no-deps app opsdeck restore local:opsdeck/2026-11-08T023000.000Z-a1b2c3-1.2.0/ [1.2.0]"
    );
    expect(t.dockerCalls().join("\n")).not.toContain("compose=");
  });

  it.each(["compose.yaml", "update.sh"])(
    "refuses a release whose %s does not match its sha256 (invalidRelease)",
    (asset) => {
      const t = setup();
      writeFileSync(join(t.rel, "1.3.0", asset), "# tampered\n");
      t.request(updateTo("1.3.0"));
      expect(t.run().status).toBe(1);
      expect(t.status()).toMatchObject({
        state: "refused",
        code: "invalidRelease",
      });
      expect(t.dockerCalls()).toEqual([]);
      expect(t.readEnv()).toBe(t.env);
      expect(t.readCompose()).toBe(composeOf("1.2.0"));
    }
  );

  it("refuses a release.json without the asset checksums", () => {
    const t = setup();
    const bad = JSON.parse(releaseJson("1.3.0", "1.0.0"));
    delete bad.assets;
    writeFileSync(join(t.rel, "1.3.0.json"), JSON.stringify(bad));
    t.request(updateTo("1.3.0"));
    expect(t.run().status).toBe(1);
    expect(t.status()).toMatchObject({ code: "invalidRelease" });
    expect(t.dockerCalls()).toEqual([]);
  });

  it("installs the release's update.sh for the next run only after a success", () => {
    const failed = setup();
    failed.request(updateTo("1.3.0"));
    expect(failed.run({ STUB_HEALTH_FAIL_VERSION: "1.3.0" }).status).toBe(1);
    expect(existsSync(join(failed.updater, "update.sh"))).toBe(false);

    const ok = setup();
    ok.request(updateTo("1.3.0"));
    expect(ok.run().status).toBe(0);
    const installed = join(ok.updater, "update.sh");
    expect(readFileSync(installed, "utf8")).toBe(updaterOf("1.3.0"));
    expect(statSync(installed).mode & 0o777).toBe(0o700);
  });

  it("after a restore that continues to the current version, installs that version's update.sh", () => {
    const t = setup({ current: "1.3.0" });
    t.request(restoreOf("1.2.0"));
    expect(t.run().status).toBe(0);
    expect(readFileSync(join(t.updater, "update.sh"), "utf8")).toBe(
      updaterOf("1.3.0")
    );
  });

  it("marks a restore that succeeded before its follow-up update rolled back", () => {
    const t = setup({ current: "1.3.0" });
    t.request(restoreOf("1.2.0"));
    expect(t.run({ STUB_HEALTH_FAIL_VERSION: "1.3.0" }).status).toBe(1);
    expect(t.status()).toMatchObject({
      action: "restore",
      state: "rolled_back",
      restored: true,
    });

    const refused = setup({ current: "1.3.0" });
    refused.request(restoreOf("1.2.0"));
    refused.run({ STUB_RESTORE_REFUSE: "restoreKeyMismatch" });
    expect(refused.status().state).toBe("rolled_back");
    expect(refused.status().restored).toBeUndefined();
  });

  it("replaces a directory the app planted as status.json", () => {
    const t = setup();
    mkdirSync(join(t.updates, "status.json", "inner"), { recursive: true });
    t.request(updateTo("1.3.0"));
    expect(t.run().status).toBe(0);
    expect(statSync(t.statusPath).isFile()).toBe(true);
    expect(t.status()).toMatchObject({ state: "succeeded" });
  });

  it("keeps its private state out of updates/", () => {
    const t = setup();
    // The app can create entries in updates/; nothing there is read as state.
    mkdirSync(join(t.updates, "previous.env"));
    mkdirSync(join(t.updates, ".lock"));
    t.request(updateTo("1.3.0"));
    expect(t.run({ STUB_HEALTH_FAIL_VERSION: "1.3.0" }).status).toBe(1);
    expect(t.status()).toMatchObject({ state: "rolled_back" });
    expect(t.readEnv()).toBe(t.env);
    expect(readdirSync(t.updater).sort()).toEqual(
      [".env.prev", ".lock", "compose.yaml.prev", "previous.env"].sort()
    );
  });

  it("refuses (and consumes) a request when .env is missing", () => {
    const t = setup();
    rmSync(join(t.dir, ".env"));
    t.request(updateTo("1.3.0"));
    expect(t.run().status).toBe(1);
    expect(t.status()).toMatchObject({
      state: "refused",
      code: "invalidInstall",
    });
    expect(existsSync(join(t.updates, "request.json"))).toBe(false);
    expect(t.calls()).toEqual([]);
  });
});

describe("update.sh and a run that never finished", () => {
  const stale = {
    runId: "20261109T200000Z-0a0b0c0d",
    action: "update",
    version: "1.3.0",
    from: "1.2.0",
    step: "migrate",
    state: "running",
    code: null,
    startedAt: "2026-11-09T20:00:00Z",
    finishedAt: null,
    logTail: ['step: migrate "state":"running","code":null,'],
  };

  it("records a status left running as failed/interrupted, without a request", () => {
    const t = setup();
    writeFileSync(t.statusPath, `${JSON.stringify(stale)}\n`);
    expect(t.run().status).toBe(0);
    const status = t.status();
    expect(status).toMatchObject({
      runId: stale.runId,
      step: "migrate",
      state: "failed",
      code: "interrupted",
      logTail: stale.logTail,
    });
    expect(status.finishedAt).not.toBeNull();
    expect(statSync(t.statusPath).mode & 0o777).toBe(0o640);
    expect(t.calls()).toEqual([]);
  });

  it("leaves a finished status alone", () => {
    const t = setup();
    const done = `${JSON.stringify({ ...stale, state: "succeeded", step: "done", finishedAt: "2026-11-09T20:05:00Z" })}\n`;
    writeFileSync(t.statusPath, done);
    expect(t.run().status).toBe(0);
    expect(readFileSync(t.statusPath, "utf8")).toBe(done);
  });

  it("leaves a running status alone while another run holds the lock", () => {
    const t = setup();
    writeFileSync(t.statusPath, `${JSON.stringify(stale)}\n`);
    mkdirSync(t.updater, { mode: 0o700 });
    const lock = join(t.updater, ".lock");
    writeFileSync(lock, "");
    expect(t.run({}, ["flock", lock, "sh"]).status).toBe(0);
    expect(t.status().state).toBe("running");
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

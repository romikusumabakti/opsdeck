import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// ops/install/install.sh runs as root on a Debian/Ubuntu host. Here only its
// --dry-run runs (unprivileged, against a temp root through
// OPSDECK_INSTALL_ROOT, which is honoured with --dry-run only), with stub
// `docker` and `curl` on PATH. A dry run reads (release assets, the old .env,
// volumes) but changes nothing; it prints every action it would take.

const REPO = join(__dirname, "..", "..");
const SCRIPT = join(REPO, "ops/install/install.sh");
const COMPOSE = join(REPO, "ops/install/compose.yaml");
const ENV_EXAMPLE = join(REPO, "ops/install/env.example");
const WORKFLOW = join(REPO, ".github/workflows/release.yml");

const STUB_DOCKER = `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$STUB_LOG"
case "$1 $2" in
  "compose version") echo "Docker Compose version v2.40.0" ;;
  "volume inspect")
    for v in \${STUB_VOLUMES:-}; do [ "$v" = "$3" ] && exit 0; done
    exit 1 ;;
  "ps -q")
    case "$*" in *"volume=\${STUB_BUSY_VOLUME:-none}") echo 0123abcd ;; esac ;;
esac
exit 0
`;

const STUB_CURL = `#!/bin/sh
out=; url=
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift ;;
    -w|--max-time|--proto|--proto-redir|-H) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
printf 'curl %s\\n' "$url" >> "$STUB_LOG"
emit() { if [ -n "$out" ]; then cat > "$out"; else cat; fi; }
case $url in
  https://api.github.com/repos/romikusumabakti/opsdeck/releases/latest)
    printf '{"url":"x","tag_name": "v1.3.0","prerelease":false}' | emit ;;
  "https://api.github.com/repos/romikusumabakti/opsdeck/releases?per_page=1")
    printf '[{"tag_name":"v1.4.0-beta.1","prerelease":true}]' | emit ;;
  https://github.com/romikusumabakti/opsdeck/releases/download/v*)
    rest=\${url#*/download/v}; ver=\${rest%%/*}; asset=\${rest#*/}
    [ -f "$STUB_RELEASES/$ver/$asset" ] || exit 22
    emit < "$STUB_RELEASES/$ver/$asset" ;;
  *) exit 6 ;;
esac
`;

const IMAGE_NAMES = {
  app: "ghcr.io/romikusumabakti/opsdeck",
  postgres: "docker.io/library/postgres",
  valkey: "docker.io/valkey/valkey",
  garage: "docker.io/dxflrs/garage",
  imgproxy: "ghcr.io/imgproxy/imgproxy",
  caddy: "docker.io/library/caddy",
};

function image(name: string, version: string) {
  const digest = createHash("sha256")
    .update(`${name}@${version}`)
    .digest("hex");
  return `${name}:${version}@sha256:${digest}`;
}

function releaseJson(version: string) {
  return JSON.stringify({
    version,
    minFrom: "0.1.0",
    images: Object.fromEntries(
      Object.entries(IMAGE_NAMES).map(([k, n]) => [k, image(n, version)])
    ),
    notesUrl: `https://github.com/romikusumabakti/opsdeck/releases/tag/v${version}`,
  });
}

// Values that must never appear in the output.
const OLD_SECRETS = {
  POSTGRES_PASSWORD: "pg-Old!pass+word",
  BETTER_AUTH_SECRET: "auth-Old/secret=",
  SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
  MICROSOFT_CLIENT_SECRET: "ms-Old-secret",
  RESEND_API_KEY: "re_old_resend_key",
  S3_SECRET_KEY: "s3-old-secret-value",
  GARAGE_RPC_SECRET: "a1".repeat(32),
  GARAGE_ADMIN_TOKEN: "garage-admin-old",
  IMGPROXY_KEY: "b2".repeat(32),
  IMGPROXY_SALT: "c3".repeat(32),
};

const OLD_ENV = [
  "# old stack",
  `POSTGRES_PASSWORD=${OLD_SECRETS.POSTGRES_PASSWORD}`,
  `DATABASE_URL=postgres://postgres:${encodeURIComponent(OLD_SECRETS.POSTGRES_PASSWORD)}@opsdeck-postgres:5432/opsdeck`,
  "BETTER_AUTH_URL=https://panel.example.test",
  `BETTER_AUTH_SECRET=${OLD_SECRETS.BETTER_AUTH_SECRET}`,
  `SECRETS_KEY=${OLD_SECRETS.SECRETS_KEY}`,
  "MICROSOFT_CLIENT_ID=ms-client-id-value",
  "MICROSOFT_TENANT_ID=ms-tenant-id-value",
  `MICROSOFT_CLIENT_SECRET=${OLD_SECRETS.MICROSOFT_CLIENT_SECRET}`,
  `RESEND_API_KEY=${OLD_SECRETS.RESEND_API_KEY}`,
  "BRAND=dss",
  "S3_ACCESS_KEY=GKold0123456789abcdef0123",
  `S3_SECRET_KEY=${OLD_SECRETS.S3_SECRET_KEY}`,
  `GARAGE_RPC_SECRET=${OLD_SECRETS.GARAGE_RPC_SECRET}`,
  `GARAGE_ADMIN_TOKEN=${OLD_SECRETS.GARAGE_ADMIN_TOKEN}`,
  `IMGPROXY_KEY=${OLD_SECRETS.IMGPROXY_KEY}`,
  `IMGPROXY_SALT=${OLD_SECRETS.IMGPROXY_SALT}`,
  "SITE_ADDRESS=panel.example.test",
  "",
].join("\n");

const LEGACY_VOLUMES =
  "opsdeck_postgres_data opsdeck_valkey_data opsdeck_garage_meta opsdeck_garage_data opsdeck_caddy_data opsdeck_caddy_config";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "install-sh-"));
  roots.push(root);
  const bin = join(root, "bin");
  const opt = join(root, "opt");
  const releases = join(root, "releases");
  mkdirSync(bin);
  mkdirSync(opt);
  writeFileSync(join(bin, "docker"), STUB_DOCKER, { mode: 0o755 });
  writeFileSync(join(bin, "curl"), STUB_CURL, { mode: 0o755 });
  for (const version of ["1.2.0", "1.3.0", "1.4.0-beta.1"]) {
    const d = join(releases, version);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "release.json"), releaseJson(version));
    for (const asset of [
      "compose.yaml",
      "env.example",
      "update.sh",
      "opsdeck-updater@.path",
      "opsdeck-updater@.service",
    ]) {
      copyFileSync(join(REPO, "ops/install", asset), join(d, asset));
    }
  }
  const log = join(root, "stub.log");
  writeFileSync(log, "");
  return { root, bin, opt, releases, log, dir: join(opt, "opsdeck") };
}

type Ctx = ReturnType<typeof setup>;

function install(ctx: Ctx, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("sh", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${ctx.bin}:/usr/bin:/bin`,
      HOME: ctx.root,
      OPSDECK_INSTALL_ROOT: ctx.opt,
      STUB_LOG: ctx.log,
      STUB_RELEASES: ctx.releases,
      ...env,
    },
  });
  return { ...result, all: `${result.stdout}${result.stderr}` };
}

function inOrder(text: string, markers: string[]) {
  let at = -1;
  for (const m of markers) {
    const i = text.indexOf(m, at + 1);
    expect(i, `"${m}" after position ${at}`).toBeGreaterThan(at);
    at = i;
  }
}

function writeBackup(ctx: Ctx, version: string, key: string) {
  const backup = join(ctx.root, "2026-11-08T023000.000Z-a1b2c3-1.2.0");
  mkdirSync(backup);
  const fingerprint = createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 16);
  writeFileSync(
    join(backup, "manifest.json"),
    `${JSON.stringify(
      {
        format: 1,
        version,
        createdAt: "2026-11-08T02:30:00.000Z",
        database: { file: "database.dump", sha256: "0".repeat(64), bytes: 1 },
        garage: { objects: 0, bytes: 0 },
        secretsKeyFingerprint: fingerprint,
      },
      null,
      2
    )}\n`
  );
  const keyFile = join(ctx.root, "secrets-key");
  writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  return { backup, keyFile };
}

describe("install.sh --dry-run", () => {
  it("prints the install in order and changes nothing", () => {
    const ctx = setup();
    const r = install(ctx, [
      "--dry-run",
      "--version",
      "v1.2.0",
      "--dir",
      ctx.dir,
      "--hostname",
      "panel.example.test",
    ]);
    expect(r.status, r.all).toBe(0);
    inOrder(r.stdout, [
      "==> Docker",
      "==> Install dir",
      `+ install -d -m 0755 ${ctx.dir}`,
      `+ install -d -m 1770 -o 0 -g 1001 ${ctx.dir}/updates`,
      `+ install -d -m 0750 -o 1001 -g 1001 ${ctx.dir}/backups`,
      "==> .env",
      `${ctx.dir}/.env (0600)`,
      "==> Updater",
      "+ install -m 0755",
      "/usr/local/lib/opsdeck/update.sh",
      "+ systemctl enable --now opsdeck-updater@opsdeck.path",
      "==> Start",
      `docker compose -f ${ctx.dir}/compose.yaml pull`,
      `docker compose -f ${ctx.dir}/compose.yaml up -d --wait`,
      "https://panel.example.test",
      "SECRETS_KEY",
    ]);
    // The keys written, never their values.
    for (const key of [
      "COMPOSE_PROJECT_NAME",
      "OPSDECK_DIR",
      "OPSDECK_VERSION",
      "OPSDECK_IMAGE",
      "CADDY_IMAGE",
      "OPSDECK_HTTP_PORT",
      "BETTER_AUTH_URL",
      "POSTGRES_PASSWORD",
      "DATABASE_URL",
      "SECRETS_KEY",
      "S3_ACCESS_KEY",
    ]) {
      expect(r.stdout).toContain(key);
    }
    expect(r.stdout).not.toMatch(/SECRETS_KEY=\S/);
    expect(r.stdout).not.toMatch(/[A-Za-z0-9+/]{43}=/);
    expect(existsSync(ctx.dir)).toBe(false);
    // Read-only calls only: the release assets and the Docker check.
    const calls = readFileSync(ctx.log, "utf8");
    expect(calls).toContain(
      "curl https://github.com/romikusumabakti/opsdeck/releases/download/v1.2.0/release.json"
    );
    expect(calls).not.toMatch(
      /docker compose (?!version)|docker run|docker volume create/
    );
  });

  it("uses the latest stable release without --version", () => {
    const ctx = setup();
    const r = install(ctx, ["--dry-run", "--dir", ctx.dir]);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain("opsdeck 1.3.0 (stable)");
    // No hostname: localhost on the HTTP port.
    expect(r.stdout).toContain("http://localhost:8080");
  });

  it("uses the newest release on the beta channel and turns auto-update on", () => {
    const ctx = setup();
    const r = install(ctx, [
      "--dry-run",
      "--channel",
      "beta",
      "--dir",
      ctx.dir,
      "--http-port",
      "8090",
    ]);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain("opsdeck 1.4.0-beta.1 (beta)");
    expect(r.stdout).toContain("update_channel = 'beta', auto_update = true");
    expect(r.stdout).toContain("http://localhost:8090");
  });

  it("refuses an existing .env without --adopt", () => {
    const ctx = setup();
    mkdirSync(ctx.dir);
    writeFileSync(join(ctx.dir, ".env"), "SECRETS_KEY=keep-me\n");
    const r = install(ctx, [
      "--dry-run",
      "--version",
      "v1.2.0",
      "--dir",
      ctx.dir,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${ctx.dir}/.env already exists`);
    expect(r.stdout).not.toContain("==> Docker");
    expect(readFileSync(join(ctx.dir, ".env"), "utf8")).toBe(
      "SECRETS_KEY=keep-me\n"
    );
  });

  it.each([
    ["a dir outside the install root", ["--dir", "/srv/opsdeck"], /must be/],
    ["a nested dir", ["--dir", "NESTED"], /must be/],
    ["a bad version", ["--version", "1.2"], /--version/],
    ["a bad channel", ["--channel", "nightly"], /--channel/],
    [
      "a beta version on the stable channel",
      ["--version", "v1.4.0-beta.1", "--channel", "stable"],
      /channel/,
    ],
    ["a bad hostname", ["--hostname", "https://x"], /--hostname/],
    ["a bad port", ["--http-port", "80a"], /--http-port/],
    ["an unknown flag", ["--force"], /unknown/],
    ["an unpublished version", ["--version", "v9.9.9"], /v9\.9\.9/],
  ])("refuses %s", (_label, args, pattern) => {
    const ctx = setup();
    const resolved = args.map((a) => (a === "NESTED" ? `${ctx.opt}/a/b` : a));
    const r = install(ctx, [
      "--dry-run",
      ...(resolved.includes("--dir") ? [] : ["--dir", ctx.dir]),
      ...resolved,
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(pattern);
  });

  it("honours OPSDECK_INSTALL_ROOT only with --dry-run", () => {
    const ctx = setup();
    const r = install(ctx, ["--version", "v1.2.0", "--dir", ctx.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/must be \/opt\/<name>|root/);
  });
});

describe("install.sh --adopt --dry-run", () => {
  function adoptSetup() {
    const ctx = setup();
    const oldEnv = join(ctx.root, "old.env");
    writeFileSync(oldEnv, OLD_ENV, { mode: 0o600 });
    return { ctx, oldEnv };
  }

  it("copies the named keys without printing them, keeps the volumes and adopts before up", () => {
    const { ctx, oldEnv } = adoptSetup();
    const r = install(
      ctx,
      [
        "--dry-run",
        "--version",
        "v1.2.0",
        "--dir",
        ctx.dir,
        "--adopt",
        oldEnv,
        "--http-port",
        "80",
      ],
      { STUB_VOLUMES: LEGACY_VOLUMES }
    );
    expect(r.status, r.all).toBe(0);
    for (const key of [
      "POSTGRES_PASSWORD",
      "BETTER_AUTH_SECRET",
      "SECRETS_KEY",
      "MICROSOFT_CLIENT_ID",
      "MICROSOFT_TENANT_ID",
      "MICROSOFT_CLIENT_SECRET",
      "RESEND_API_KEY",
      "BRAND",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
      "DATABASE_URL",
      "BETTER_AUTH_URL",
    ]) {
      expect(r.stdout).toMatch(new RegExp(`copied .*\\b${key}\\b`));
    }
    for (const value of Object.values(OLD_SECRETS)) {
      expect(r.all).not.toContain(value);
    }
    expect(r.all).not.toContain("ms-client-id-value");
    // The old container hostname is replaced by the service name.
    expect(r.stdout).toContain("DATABASE_URL: host set to postgres");
    expect(r.stdout).toContain("OPSDECK_VOLUME_POSTGRES=opsdeck_postgres_data");
    expect(r.stdout).toContain(
      "OPSDECK_VOLUME_GARAGE_DATA=opsdeck_garage_data"
    );
    inOrder(r.stdout, [
      "==> Docker",
      "==> Install dir",
      "==> .env",
      "==> Updater",
      "==> Adopt",
      `docker compose -f ${ctx.dir}/compose.yaml up -d --wait --wait-timeout 300 postgres`,
      `docker compose -f ${ctx.dir}/compose.yaml run --rm migrate opsdeck migrate --adopt`,
      "==> Start",
      `docker compose -f ${ctx.dir}/compose.yaml up -d --wait`,
      "https://panel.example.test",
    ]);
    // No beta settings and no generated SECRETS_KEY in adopt mode.
    expect(r.stdout).not.toContain("update_channel");
  });

  it("refuses while the old stack still uses the database volume", () => {
    const { ctx, oldEnv } = adoptSetup();
    const r = install(
      ctx,
      ["--dry-run", "--version", "v1.2.0", "--dir", ctx.dir, "--adopt", oldEnv],
      {
        STUB_VOLUMES: LEGACY_VOLUMES,
        STUB_BUSY_VOLUME: "opsdeck_postgres_data",
      }
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("opsdeck_postgres_data is in use");
  });

  it("refuses when the old database volume is missing", () => {
    const { ctx, oldEnv } = adoptSetup();
    const r = install(ctx, [
      "--dry-run",
      "--version",
      "v1.2.0",
      "--dir",
      ctx.dir,
      "--adopt",
      oldEnv,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("opsdeck_postgres_data");
  });

  it("refuses an old .env without SECRETS_KEY", () => {
    const { ctx } = adoptSetup();
    const oldEnv = join(ctx.root, "partial.env");
    writeFileSync(
      oldEnv,
      OLD_ENV.split("\n")
        .filter((l) => !l.startsWith("SECRETS_KEY="))
        .join("\n")
    );
    const r = install(
      ctx,
      ["--dry-run", "--version", "v1.2.0", "--dir", ctx.dir, "--adopt", oldEnv],
      { STUB_VOLUMES: LEGACY_VOLUMES }
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("SECRETS_KEY");
  });

  it("allows an existing .env in the dir in adopt mode and keeps a copy", () => {
    const { ctx, oldEnv } = adoptSetup();
    mkdirSync(ctx.dir);
    writeFileSync(join(ctx.dir, ".env"), "OPSDECK_VERSION=1.1.0\n");
    const r = install(
      ctx,
      ["--dry-run", "--version", "v1.2.0", "--dir", ctx.dir, "--adopt", oldEnv],
      { STUB_VOLUMES: LEGACY_VOLUMES }
    );
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toMatch(/\+ cp -p .*\/\.env .*\/\.env\.pre-adopt-/);
  });
});

describe("install.sh --restore --dry-run", () => {
  const KEY = Buffer.alloc(32, 9).toString("base64");

  it("installs the backup's version and restores the copied folder before up", () => {
    const ctx = setup();
    const { backup, keyFile } = writeBackup(ctx, "1.2.0", KEY);
    const r = install(ctx, [
      "--dry-run",
      "--dir",
      ctx.dir,
      "--restore",
      backup,
      "--secrets-key-file",
      keyFile,
    ]);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain("opsdeck 1.2.0 (stable)");
    inOrder(r.stdout, [
      "==> .env",
      "==> Updater",
      "==> Restore",
      `+ cp -R ${backup} ${ctx.dir}/backups/opsdeck/2026-11-08T023000.000Z-a1b2c3-1.2.0`,
      "up -d --wait --wait-timeout 300 postgres valkey garage",
      "run --rm migrate",
      "run --rm --no-deps app opsdeck restore local:opsdeck/2026-11-08T023000.000Z-a1b2c3-1.2.0/",
      "==> Start",
      "up -d --wait",
    ]);
    expect(r.all).not.toContain(KEY);
  });

  it("refuses a key that does not match the backup's fingerprint", () => {
    const ctx = setup();
    const { backup } = writeBackup(ctx, "1.2.0", KEY);
    const other = join(ctx.root, "other-key");
    writeFileSync(other, Buffer.alloc(32, 1).toString("base64"));
    const r = install(ctx, [
      "--dry-run",
      "--dir",
      ctx.dir,
      "--restore",
      backup,
      "--secrets-key-file",
      other,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("fingerprint");
  });

  it("refuses a restore without the SECRETS_KEY file", () => {
    const ctx = setup();
    const { backup } = writeBackup(ctx, "1.2.0", KEY);
    const r = install(ctx, [
      "--dry-run",
      "--dir",
      ctx.dir,
      "--restore",
      backup,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--secrets-key-file");
  });

  it("refuses an S3 object key on a fresh install, naming the way out", () => {
    const ctx = setup();
    const { keyFile } = writeBackup(ctx, "1.2.0", KEY);
    const r = install(ctx, [
      "--dry-run",
      "--dir",
      ctx.dir,
      "--restore",
      "opsdeck-backups/opsdeck/2026-11-08T023000.000Z-a1b2c3-1.2.0/",
      "--secrets-key-file",
      keyFile,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("download");
  });

  it("refuses a --version other than the backup's", () => {
    const ctx = setup();
    const { backup, keyFile } = writeBackup(ctx, "1.2.0", KEY);
    const r = install(ctx, [
      "--dry-run",
      "--dir",
      ctx.dir,
      "--version",
      "v1.3.0",
      "--restore",
      backup,
      "--secrets-key-file",
      keyFile,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("1.2.0");
  });
});

describe("product compose", () => {
  const composeAvailable =
    spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status ===
    0;

  it("is valid with env.example and keeps the product rules", (ctx) => {
    if (!composeAvailable) {
      console.warn("docker compose not found; skipping the compose check");
      ctx.skip();
    }
    const r = spawnSync(
      "docker",
      [
        "compose",
        "-f",
        COMPOSE,
        "--env-file",
        ENV_EXAMPLE,
        "config",
        "--format",
        "json",
      ],
      { encoding: "utf8" }
    );
    expect(r.status, r.stderr).toBe(0);
    const config = JSON.parse(r.stdout) as {
      name: string;
      services: Record<
        string,
        {
          image: string;
          build?: unknown;
          container_name?: string;
          ports?: { host_ip: string; published: string; target: number }[];
          environment?: Record<string, string>;
          volumes?: { type: string; source: string; target: string }[];
          depends_on?: Record<string, { condition: string }>;
        }
      >;
      volumes: Record<string, { name: string }>;
    };
    expect(Object.keys(config.services).sort()).toEqual(
      [
        "app",
        "caddy",
        "garage",
        "imgproxy",
        "migrate",
        "postgres",
        "terminal",
        "valkey",
      ].sort()
    );
    for (const [name, s] of Object.entries(config.services)) {
      expect(s.build, name).toBeUndefined();
      expect(s.container_name, name).toBeUndefined();
      expect(s.image, name).toMatch(/@sha256:[a-f0-9]{64}$/);
      expect(s.environment?.OPSDECK_VERSION, name).toBeUndefined();
      if (name !== "caddy") expect(s.ports, name).toBeUndefined();
    }
    expect(config.services.caddy?.ports).toEqual([
      expect.objectContaining({
        host_ip: "127.0.0.1",
        published: "8080",
        target: 80,
      }),
    ]);
    const app = config.services.app;
    expect(app?.depends_on?.migrate?.condition).toBe(
      "service_completed_successfully"
    );
    expect(app?.environment?.COMPOSE_PROJECT_NAME).toBe("opsdeck");
    expect(app?.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "bind",
          source: "/opt/opsdeck/updates",
          target: "/var/lib/opsdeck/updates",
        }),
        expect.objectContaining({
          type: "bind",
          source: "/opt/opsdeck/backups",
          target: "/var/lib/opsdeck/backups",
        }),
      ])
    );
    expect(config.services.terminal?.image).toBe(app?.image);
    expect(config.services.migrate?.image).toBe(app?.image);
    expect(config.volumes.postgres?.name).toBe("opsdeck_postgres");
    expect(config.volumes.garage_data?.name).toBe("opsdeck_garage_data");
  });

  it("names the volumes from OPSDECK_VOLUME_* when adopted", (ctx) => {
    if (!composeAvailable) {
      console.warn("docker compose not found; skipping the compose check");
      ctx.skip();
    }
    const r = spawnSync(
      "docker",
      [
        "compose",
        "-f",
        COMPOSE,
        "--env-file",
        ENV_EXAMPLE,
        "config",
        "--format",
        "json",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPSDECK_VOLUME_POSTGRES: "opsdeck_postgres_data",
          COMPOSE_PROJECT_NAME: "beta",
        },
      }
    );
    expect(r.status, r.stderr).toBe(0);
    const config = JSON.parse(r.stdout) as {
      volumes: Record<string, { name: string }>;
    };
    expect(config.volumes.postgres?.name).toBe("opsdeck_postgres_data");
    expect(config.volumes.valkey?.name).toBe("beta_valkey");
  });
});

describe("lint", () => {
  it("install.sh is shellcheck clean", (ctx) => {
    if (spawnSync("shellcheck", ["--version"]).status !== 0) {
      console.warn("shellcheck not found; skipping the lint of install.sh");
      ctx.skip();
    }
    const r = spawnSync("shellcheck", ["-s", "sh", SCRIPT], {
      encoding: "utf8",
    });
    expect(r.status, r.stdout).toBe(0);
  });

  it("release.yml passes actionlint", (ctx) => {
    if (spawnSync("actionlint", ["--version"]).status !== 0) {
      console.warn("actionlint not found; skipping the lint of release.yml");
      ctx.skip();
    }
    const r = spawnSync("actionlint", [WORKFLOW], { encoding: "utf8" });
    expect(r.status, r.stdout).toBe(0);
  });

  it("release.yml uploads every install asset", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    for (const asset of [
      "release.json",
      "ops/install/install.sh",
      "ops/install/update.sh",
      "ops/install/compose.yaml",
      "ops/install/env.example",
      "ops/install/opsdeck-updater@.path",
      "ops/install/opsdeck-updater@.service",
    ]) {
      expect(workflow).toContain(asset);
    }
  });
});

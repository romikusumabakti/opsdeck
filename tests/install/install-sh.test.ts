import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
import { parse as parseYaml } from "yaml";
import { hostTools, lintToolAvailable } from "../support/host-tools";

// ops/install/install.sh runs as root on a systemd Linux host. Here only its
// --dry-run runs (unprivileged, against a temp root through
// OPSDECK_INSTALL_ROOT and a fake host through OPSDECK_INSTALL_SYSROOT, both
// honoured with --dry-run only), with stub `docker`, `curl`, `id`, `uname`,
// `dpkg` and `dpkg-query` on PATH next to plain host tools only
// (support/host-tools): the host running the tests is never probed. A dry
// run reads (release assets, the old .env, volumes) but changes nothing; it
// prints every action it would take.

const REPO = join(__dirname, "..", "..");
const SCRIPT = join(REPO, "ops/install/install.sh");
const COMPOSE = join(REPO, "ops/install/compose.yaml");
const ENV_EXAMPLE = join(REPO, "ops/install/env.example");
const WORKFLOW = join(REPO, ".github/workflows/release.yml");

const STUB_DOCKER = `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$STUB_LOG"
case "$1 $2" in
  "compose version") echo "Docker Compose version v\${STUB_COMPOSE_VERSION:-2.40.0}" ;;
  "version "|"version --format")
    if [ -n "\${STUB_DOCKER_PODMAN:-}" ]; then echo "Client:       Podman Engine"; echo "Version:      5.4.0"; exit 0; fi
    echo "Client: Docker Engine - Community"; echo " Version:           29.5.3" ;;
  "info "|"info --format")
    if [ -n "\${STUB_DOCKER_INFO_FAIL:-}" ]; then
      echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2
      exit 1
    fi
    echo " Server Version: 29.5.3"; echo " Name: \${STUB_DOCKER_INFO_NAME:-docker-host}" ;;
  "volume inspect")
    if [ -n "\${STUB_DOCKER_DOWN:-}" ]; then
      echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2
      exit 1
    fi
    for v in \${STUB_VOLUMES:-}; do [ "$v" = "$3" ] && { echo '[{}]'; exit 0; }; done
    echo "Error response from daemon: get $3: no such volume" >&2
    exit 1 ;;
  "ps -aq")
    case "$*" in *"volume=\${STUB_BUSY_VOLUME:-none}") echo 0123abcd ;; esac ;;
esac
exit 0
`;

const STUB_CURL = `#!/bin/sh
printf 'curl-argv %s\n' "$*" >> "$STUB_LOG"
out=; url=; cfg=
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift ;;
    -K) cfg=$2; shift ;;
    -w|--max-time|--proto|--proto-redir|-H|--aws-sigv4) shift ;;
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
  https://r2.example.test/opsdeck-dr/*)
    # The S3 keys must come from the -K config file.
    grep -qF "user = \\"AKIDRESTORE:$STUB_S3_SECRET\\"" "$cfg" || exit 67
    key=\${url#https://r2.example.test/opsdeck-dr/}
    [ -f "$STUB_S3/$key" ] || exit 22
    emit < "$STUB_S3/$key" ;;
  *) exit 6 ;;
esac
`;

// The host as install.sh sees it: root, amd64, no distribution Docker package.
const HOST_STUBS = {
  id: '#!/bin/sh\n[ "$1" = -u ] && echo 0\n',
  uname: '#!/bin/sh\n[ "$1" = -m ] && echo x86_64 || echo Linux\n',
  dpkg: '#!/bin/sh\n[ "$1" = --print-architecture ] && echo amd64\n',
  "dpkg-query": "#!/bin/sh\nexit 1\n",
};

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

const fileSha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

function releaseJson(version: string) {
  return JSON.stringify({
    version,
    minFrom: "0.1.0",
    images: Object.fromEntries(
      Object.entries(IMAGE_NAMES).map(([k, n]) => [k, image(n, version)])
    ),
    assets: {
      "compose.yaml": fileSha256(COMPOSE),
      "update.sh": fileSha256(join(REPO, "ops/install/update.sh")),
    },
    notesUrl: `https://github.com/romikusumabakti/opsdeck/releases/tag/v${version}`,
  });
}

const S3_SECRET = "s3-restore-Secret/value+1";

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

function setup({ docker = true }: { docker?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "install-sh-"));
  roots.push(root);
  const bin = join(root, "bin");
  const opt = join(root, "opt");
  const releases = join(root, "releases");
  mkdirSync(bin);
  mkdirSync(opt);
  const hostBin = hostTools(join(root, "host-bin"));
  if (docker) writeFileSync(join(bin, "docker"), STUB_DOCKER, { mode: 0o755 });
  for (const [name, body] of Object.entries({
    ...HOST_STUBS,
    curl: STUB_CURL,
  })) {
    writeFileSync(join(bin, name), body, { mode: 0o755 });
  }
  // An Ubuntu 24.04 host with systemd.
  const sysroot = join(root, "sysroot");
  mkdirSync(join(sysroot, "etc"), { recursive: true });
  mkdirSync(join(sysroot, "run/systemd/system"), { recursive: true });
  writeFileSync(
    join(sysroot, "etc/os-release"),
    'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n'
  );
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
  return {
    root,
    bin,
    hostBin,
    sysroot,
    opt,
    releases,
    log,
    dir: join(opt, "opsdeck"),
  };
}

type Ctx = ReturnType<typeof setup>;

function install(
  ctx: Ctx,
  args: string[],
  env: Record<string, string> = {},
  { piped = false, cwd }: { piped?: boolean; cwd?: string } = {}
) {
  // piped: as `curl … | sh -s -- <args>`, the script on stdin.
  const result = spawnSync(
    "sh",
    piped ? ["-s", "--", ...args] : [SCRIPT, ...args],
    {
      encoding: "utf8",
      cwd,
      input: piped ? readFileSync(SCRIPT, "utf8") : undefined,
      env: {
        PATH: `${ctx.bin}:${ctx.hostBin}`,
        HOME: ctx.root,
        OPSDECK_INSTALL_ROOT: ctx.opt,
        OPSDECK_INSTALL_SYSROOT: ctx.sysroot,
        STUB_LOG: ctx.log,
        STUB_RELEASES: ctx.releases,
        STUB_S3: join(ctx.root, "s3"),
        STUB_S3_SECRET: S3_SECRET,
        ...env,
      },
    }
  );
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
      `+ install -d -m 0700 -o 0 -g 0 ${ctx.dir}/.updater`,
      `+ install -m 0700 -o 0 -g 0 `,
      `${ctx.dir}/.updater/update.sh`,
      "+ systemctl enable opsdeck-updater@opsdeck.service",
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
    // No updater shared between instances.
    expect(r.stdout).not.toContain("/usr/local/lib/opsdeck");
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

  it("works piped to sh -s -- (curl | sh), reading nothing from stdin", () => {
    const ctx = setup();
    const r = install(
      ctx,
      ["--dry-run", "--version", "v1.2.0", "--dir", ctx.dir],
      {},
      { piped: true }
    );
    expect(r.status, r.all).toBe(0);
    inOrder(r.stdout, ["==> Docker", "==> .env", "==> Updater", "==> Start"]);
  });

  it("refuses a fresh install over an existing <name>_postgres volume", () => {
    const ctx = setup();
    const r = install(
      ctx,
      ["--dry-run", "--version", "v1.2.0", "--dir", ctx.dir],
      { STUB_VOLUMES: "opsdeck_postgres" }
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("volume opsdeck_postgres already exists");
  });

  it("refuses when Docker cannot say whether the volume exists (daemon down)", () => {
    const ctx = setup();
    const r = install(
      ctx,
      ["--dry-run", "--version", "v1.2.0", "--dir", ctx.dir],
      { STUB_DOCKER_DOWN: "1" }
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot check Docker volume opsdeck_postgres");
    expect(r.stdout).not.toContain("==> Install dir");
  });

  it("refuses Docker Compose older than 2.23.1 (configs.content)", () => {
    const ctx = setup();
    const r = install(
      ctx,
      ["--dry-run", "--version", "v1.2.0", "--dir", ctx.dir],
      { STUB_COMPOSE_VERSION: "2.23.0" }
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Docker Compose 2.23.0 is too old");
    expect(r.stderr).toContain("2.23.1");
    const ok = install(
      ctx,
      ["--dry-run", "--version", "v1.2.0", "--dir", ctx.dir],
      { STUB_COMPOSE_VERSION: "2.23.1" }
    );
    expect(ok.status, ok.all).toBe(0);
  });

  it.each(["compose.yaml", "update.sh"])(
    "refuses a release whose %s does not match release.json",
    (asset) => {
      const ctx = setup();
      writeFileSync(join(ctx.releases, "1.2.0", asset), "# tampered\n");
      const r = install(ctx, [
        "--dry-run",
        "--version",
        "v1.2.0",
        "--dir",
        ctx.dir,
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${asset} does not match its sha256`);
    }
  );

  it("refuses to put docker-ce over the distribution's docker.io", () => {
    const ctx = setup({ docker: false });
    writeFileSync(
      join(ctx.bin, "dpkg-query"),
      '#!/bin/sh\ncase "$*" in *docker.io*) printf "install ok installed" ;; *) exit 1 ;; esac\n',
      { mode: 0o755 }
    );
    const r = install(ctx, [
      "--dry-run",
      "--version",
      "v1.2.0",
      "--dir",
      ctx.dir,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docker.io package is installed");
    expect(r.stdout).not.toContain("apt-get install");
  });

  it("installs Docker from Docker's repository when it is missing", () => {
    const ctx = setup({ docker: false });
    const r = install(ctx, [
      "--dry-run",
      "--version",
      "v1.2.0",
      "--dir",
      ctx.dir,
    ]);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).not.toContain("a real run would stop here");
    expect(r.stdout).toContain("https://download.docker.com/linux/ubuntu/gpg");
    expect(r.stdout).toContain("/etc/apt/sources.list.d/docker.sources");
    expect(r.stdout).toContain("apt-get install -y docker-ce docker-ce-cli");
  });

  it("checks the host: root, systemd (notices in a dry run)", () => {
    // The fake host comes from OPSDECK_INSTALL_SYSROOT, which install.sh
    // honours with --dry-run only (next to OPSDECK_INSTALL_ROOT in main()); a
    // real run always reads /etc/os-release and /run/systemd/system.
    const ctx = setup();
    writeFileSync(join(ctx.sysroot, "etc/os-release"), "ID=fedora\n");
    rmSync(join(ctx.sysroot, "run/systemd"), { recursive: true });
    writeFileSync(join(ctx.bin, "id"), "#!/bin/sh\necho 1000\n", {
      mode: 0o755,
    });
    const r = install(ctx, [
      "--dry-run",
      "--version",
      "v1.2.0",
      "--dir",
      ctx.dir,
    ]);
    expect(r.status, r.all).toBe(0);
    for (const problem of [
      "run as root",
      "systemd is not running on this host",
    ]) {
      expect(r.stdout).toContain(
        `dry run: a real run would stop here: ${problem}`
      );
    }
    expect(r.stdout).not.toContain("supported (this host: fedora)");
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
    expect(r.stdout).not.toContain("warning:");
  });

  it("keeps the old stack's Caddy port 80 by default and warns when overridden", () => {
    const { ctx, oldEnv } = adoptSetup();
    const args = [
      "--dry-run",
      "--version",
      "v1.2.0",
      "--dir",
      ctx.dir,
      "--adopt",
      oldEnv,
    ];
    const kept = install(ctx, args, { STUB_VOLUMES: LEGACY_VOLUMES });
    expect(kept.status, kept.all).toBe(0);
    expect(kept.stdout).toContain("Caddy on 127.0.0.1:80;");
    const moved = install(ctx, [...args, "--http-port", "8080"], {
      STUB_VOLUMES: LEGACY_VOLUMES,
    });
    expect(moved.status, moved.all).toBe(0);
    expect(moved.stdout).toContain(
      "warning: the old stack served on 127.0.0.1:80; with --http-port 8080"
    );
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
    // `docker ps -a`: a stopped container of the old stack counts too.
    expect(r.stderr).toContain("opsdeck_postgres_data is in use");
    expect(readFileSync(ctx.log, "utf8")).toContain(
      "docker ps -aq --filter volume=opsdeck_postgres_data"
    );
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
  const NAME = "2026-11-08T023000.000Z-a1b2c3-1.2.0";
  const HOST = ["--hostname", "panel.example.test"];

  it("installs the backup's version and restores the copied folder before up", () => {
    const ctx = setup();
    const { backup, keyFile } = writeBackup(ctx, "1.2.0", KEY);
    const r = install(ctx, [
      "--dry-run",
      "--dir",
      ctx.dir,
      ...HOST,
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
      `+ cp -R ${backup} ${ctx.dir}/backups/opsdeck/${NAME}`,
      "up -d --wait --wait-timeout 300 postgres valkey garage",
      "run --rm migrate",
      `run --rm --no-deps app opsdeck restore local:opsdeck/${NAME}/`,
      "==> Start",
      "up -d --wait",
      "https://panel.example.test",
    ]);
    expect(r.all).not.toContain(KEY);
  });

  it("treats a bare relative path as a folder on this host", () => {
    const ctx = setup();
    const { keyFile } = writeBackup(ctx, "1.2.0", KEY);
    const r = install(
      ctx,
      [
        "--dry-run",
        "--dir",
        ctx.dir,
        ...HOST,
        "--restore",
        NAME,
        "--secrets-key-file",
        keyFile,
      ],
      {},
      { cwd: ctx.root }
    );
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain(
      `+ cp -R ${NAME} ${ctx.dir}/backups/opsdeck/${NAME}`
    );
  });

  describe("from s3://", () => {
    const S3_KEY = `opsdeck-backups/opsdeck/${NAME}/`;

    function s3Setup(mode = 0o600) {
      const ctx = setup();
      const { backup, keyFile } = writeBackup(ctx, "1.2.0", KEY);
      mkdirSync(join(ctx.root, "s3", S3_KEY), { recursive: true });
      copyFileSync(
        join(backup, "manifest.json"),
        join(ctx.root, "s3", S3_KEY, "manifest.json")
      );
      const s3Env = join(ctx.root, "restore-s3.env");
      writeFileSync(
        s3Env,
        [
          "OPSDECK_RESTORE_S3_ENDPOINT=https://r2.example.test",
          "OPSDECK_RESTORE_S3_REGION=auto",
          "OPSDECK_RESTORE_S3_BUCKET=opsdeck-dr",
          "OPSDECK_RESTORE_S3_ACCESS_KEY_ID=AKIDRESTORE",
          `OPSDECK_RESTORE_S3_SECRET_ACCESS_KEY=${S3_SECRET}`,
          "OPSDECK_RESTORE_S3_FORCE_PATH_STYLE=true",
          "",
        ].join("\n"),
        { mode }
      );
      chmodSync(s3Env, mode);
      return { ctx, keyFile, s3Env };
    }

    it("pins the version from the manifest in the bucket and restores with the keys in the env only", () => {
      const { ctx, keyFile, s3Env } = s3Setup();
      const r = install(ctx, [
        "--dry-run",
        "--dir",
        ctx.dir,
        ...HOST,
        "--restore",
        `s3://${S3_KEY}`,
        "--s3-env-file",
        s3Env,
        "--secrets-key-file",
        keyFile,
      ]);
      expect(r.status, r.all).toBe(0);
      expect(r.stdout).toContain("opsdeck 1.2.0 (stable)");
      inOrder(r.stdout, [
        "==> Restore",
        "up -d --wait --wait-timeout 300 postgres valkey garage",
        "run --rm migrate",
        `run --rm --no-deps -e OPSDECK_RESTORE_S3_ENDPOINT -e OPSDECK_RESTORE_S3_REGION -e OPSDECK_RESTORE_S3_BUCKET -e OPSDECK_RESTORE_S3_ACCESS_KEY_ID -e OPSDECK_RESTORE_S3_SECRET_ACCESS_KEY -e OPSDECK_RESTORE_S3_FORCE_PATH_STYLE app opsdeck restore ${S3_KEY}`,
        "==> Start",
      ]);
      const calls = readFileSync(ctx.log, "utf8");
      expect(calls).toContain(
        `curl https://r2.example.test/opsdeck-dr/${S3_KEY}manifest.json`
      );
      expect(calls).toContain("--aws-sigv4 aws:amz:auto:s3");
      expect(`${r.all}${calls}`).not.toContain(S3_SECRET);
      expect(r.all).not.toContain("AKIDRESTORE");
    });

    it("refuses an s3:// restore without --s3-env-file", () => {
      const { ctx, keyFile } = s3Setup();
      const r = install(ctx, [
        "--dry-run",
        "--dir",
        ctx.dir,
        ...HOST,
        "--restore",
        `s3://${S3_KEY}`,
        "--secrets-key-file",
        keyFile,
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("--s3-env-file");
    });

    it("refuses an --s3-env-file readable by others", () => {
      const { ctx, keyFile, s3Env } = s3Setup(0o644);
      const r = install(ctx, [
        "--dry-run",
        "--dir",
        ctx.dir,
        ...HOST,
        "--restore",
        `s3://${S3_KEY}`,
        "--s3-env-file",
        s3Env,
        "--secrets-key-file",
        keyFile,
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("0600");
    });

    it("refuses when the manifest is not in the bucket", () => {
      const { ctx, keyFile, s3Env } = s3Setup();
      const r = install(ctx, [
        "--dry-run",
        "--dir",
        ctx.dir,
        ...HOST,
        "--restore",
        "s3://opsdeck-backups/opsdeck/missing/",
        "--s3-env-file",
        s3Env,
        "--secrets-key-file",
        keyFile,
      ]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        "cannot download opsdeck-backups/opsdeck/missing/manifest.json"
      );
    });
  });

  it("refuses a restore over an existing <name>_postgres volume", () => {
    const ctx = setup();
    const { backup, keyFile } = writeBackup(ctx, "1.2.0", KEY);
    const r = install(
      ctx,
      [
        "--dry-run",
        "--dir",
        ctx.dir,
        ...HOST,
        "--restore",
        backup,
        "--secrets-key-file",
        keyFile,
      ],
      { STUB_VOLUMES: "opsdeck_postgres" }
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("volume opsdeck_postgres already exists");
    expect(r.stdout).not.toContain("==> Restore");
  });

  it("refuses a restore without --hostname", () => {
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
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--hostname");
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
      ...HOST,
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
      ...HOST,
      "--restore",
      backup,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--secrets-key-file");
  });

  it("refuses a --version other than the backup's", () => {
    const ctx = setup();
    const { backup, keyFile } = writeBackup(ctx, "1.2.0", KEY);
    const r = install(ctx, [
      "--dry-run",
      "--dir",
      ctx.dir,
      ...HOST,
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

describe("install.sh way_back", () => {
  // way_back only runs after a real (root) run changed the host; here the
  // function runs on its own with the variables main() sets.
  function wayBack(vars: Record<string, string>) {
    const text = readFileSync(SCRIPT, "utf8");
    const start = text.indexOf("\nway_back() {");
    const fn = text.slice(start, text.indexOf("\n}\n", start) + 3);
    const assign = Object.entries(vars)
      .map(([k, v]) => `${k}='${v}'`)
      .join("; ");
    return spawnSync("sh", ["-c", `${fn}\n${assign}; way_back`], {
      encoding: "utf8",
    }).stderr;
  }

  it("suggests down -v only when every volume is one this run created", () => {
    const fresh = wayBack({
      adopt: "",
      preexisting: "",
      dir: "/opt/opsdeck",
      name: "opsdeck",
    });
    expect(fresh).toContain("down -v");

    const leftover = wayBack({
      adopt: "",
      preexisting: " opsdeck_caddy_data opsdeck_valkey",
      dir: "/opt/opsdeck",
      name: "opsdeck",
    });
    expect(leftover).not.toContain("down -v");
    expect(leftover).toContain("opsdeck_caddy_data opsdeck_valkey");

    const adopted = wayBack({
      adopt: "/srv/old/.env",
      preexisting: "",
      dir: "/opt/opsdeck",
      name: "opsdeck",
    });
    expect(adopted).not.toContain("down -v");
  });
});

describe("updater units", () => {
  const unit = (name: string) =>
    readFileSync(join(REPO, "ops/install", name), "utf8");

  it("runs the instance's own update.sh, also once at boot", () => {
    const service = unit("opsdeck-updater@.service");
    expect(service).toContain("ExecStart=/opt/%i/.updater/update.sh /opt/%i");
    expect(service).toMatch(/\[Install\]\nWantedBy=multi-user\.target/);
    expect(service).toContain("TimeoutStartSec=1h");
    expect(service).toContain("TimeoutStopSec=5min");
    const path = unit("opsdeck-updater@.path");
    expect(path).toContain("PathChanged=/opt/%i/updates/request.json");
    expect(path).not.toMatch(/^PathExists=/m);
  });
});

describe("install.sh on another systemd distribution (Rocky Linux 9)", () => {
  // Docker Engine and Compose come from Docker's own packages there; the
  // installer only checks them, and never calls dpkg or apt.
  function rocky({ docker = true }: { docker?: boolean } = {}) {
    const ctx = setup({ docker });
    writeFileSync(
      join(ctx.sysroot, "etc/os-release"),
      'NAME="Rocky Linux"\nVERSION="9.8 (Blue Onyx)"\nID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.8"\nPLATFORM_ID="platform:el9"\n'
    );
    // Logged, so a call shows; a Rocky host has neither tool.
    for (const tool of ["dpkg", "dpkg-query", "apt-get"]) {
      writeFileSync(
        join(ctx.bin, tool),
        `#!/bin/sh\nprintf '${tool} %s\\n' "$*" >> "$STUB_LOG"\nexit 127\n`,
        { mode: 0o755 }
      );
    }
    return ctx;
  }
  const args = (ctx: Ctx) => [
    "--dry-run",
    "--version",
    "v1.2.0",
    "--dir",
    ctx.dir,
  ];
  const noApt = (ctx: Ctx, stdout: string) => {
    expect(readFileSync(ctx.log, "utf8")).not.toMatch(/^(dpkg|apt-get)/m);
    expect(stdout).not.toContain("apt-get");
  };

  it("proceeds with Docker and Compose 5.1.4 already installed", () => {
    const ctx = rocky();
    const r = install(ctx, args(ctx), { STUB_COMPOSE_VERSION: "5.1.4" });
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).not.toContain("a real run would stop here");
    inOrder(r.stdout, [
      "==> Docker",
      "found: Docker Compose version v5.1.4",
      "==> Install dir",
      "==> Start",
    ]);
    noApt(ctx, r.stdout);
  });

  it("asks for Docker from Docker's docs when it is missing", () => {
    const ctx = rocky({ docker: false });
    const r = install(ctx, args(ctx));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "Docker Engine with the Compose v2 plugin (2.23.1 or later) is required"
    );
    expect(r.stderr).toContain("for rocky");
    expect(r.stderr).toContain("https://docs.docker.com/engine/install/");
    expect(r.stdout).not.toContain("==> Install dir");
    noApt(ctx, r.stdout);
  });

  it("refuses Docker Compose 2.20", () => {
    const ctx = rocky();
    const r = install(ctx, args(ctx), { STUB_COMPOSE_VERSION: "2.20.3" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Docker Compose 2.20.3 is too old");
    expect(r.stdout).not.toContain("==> Install dir");
    noApt(ctx, r.stdout);
  });

  const stops = (stdout: string, problem: string) =>
    expect(stdout).toContain(`dry run: a real run would stop here: ${problem}`);
  const SELINUX = "SELinux is enforcing on this host";

  it("refuses SELinux in enforcing mode, and runs when it is permissive or disabled", () => {
    const ctx = rocky();
    const getenforce = join(ctx.bin, "getenforce");
    writeFileSync(getenforce, "#!/bin/sh\necho Enforcing\n", { mode: 0o755 });
    const r = install(ctx, args(ctx), { STUB_COMPOSE_VERSION: "5.1.4" });
    expect(r.status, r.all).toBe(0);
    stops(r.stdout, SELINUX);
    for (const mode of ["Permissive", "Disabled"]) {
      writeFileSync(getenforce, `#!/bin/sh\necho ${mode}\n`, { mode: 0o755 });
      const ok = install(ctx, args(ctx), { STUB_COMPOSE_VERSION: "5.1.4" });
      expect(ok.status, ok.all).toBe(0);
      expect(ok.stdout).not.toContain("a real run would stop here");
    }
  });

  it("reads selinuxfs without getenforce, or when getenforce fails", () => {
    const ctx = rocky();
    // No getenforce and no selinuxfs: SELinux is off.
    const off = install(ctx, args(ctx), { STUB_COMPOSE_VERSION: "5.1.4" });
    expect(off.status, off.all).toBe(0);
    expect(off.stdout).not.toContain(SELINUX);
    const selinuxfs = join(ctx.sysroot, "sys/fs/selinux");
    mkdirSync(selinuxfs, { recursive: true });
    writeFileSync(join(selinuxfs, "enforce"), "1");
    const absent = install(ctx, args(ctx), { STUB_COMPOSE_VERSION: "5.1.4" });
    stops(absent.stdout, SELINUX);
    writeFileSync(join(ctx.bin, "getenforce"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const failing = install(ctx, args(ctx), { STUB_COMPOSE_VERSION: "5.1.4" });
    stops(failing.stdout, SELINUX);
    writeFileSync(join(selinuxfs, "enforce"), "0");
    const permissive = install(ctx, args(ctx), {
      STUB_COMPOSE_VERSION: "5.1.4",
    });
    expect(permissive.stdout).not.toContain(SELINUX);
  });

  it("stops when the Docker Engine daemon is not running", () => {
    const ctx = rocky();
    const r = install(ctx, args(ctx), {
      STUB_COMPOSE_VERSION: "5.1.4",
      STUB_DOCKER_INFO_FAIL: "1",
    });
    expect(r.status, r.all).toBe(0);
    stops(
      r.stdout,
      "the Docker Engine daemon is not running: start docker.service"
    );
  });

  it.each(["rocky", "ubuntu"])("refuses Podman posing as docker (%s)", (id) => {
    const ctx = id === "rocky" ? rocky() : setup();
    const r = install(ctx, args(ctx), { STUB_DOCKER_PODMAN: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "Docker Engine is required, podman is not supported"
    );
    expect(r.stdout).not.toContain("==> Install dir");
  });

  it("accepts Docker Engine on a host whose name says podman", () => {
    const ctx = rocky();
    const r = install(ctx, args(ctx), { STUB_DOCKER_INFO_NAME: "podman-box" });
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).not.toContain("a real run would stop here");
  });

  it.each([
    ["Fedora", "ID=fedora\nVERSION_ID=43\n"],
    ["an unknown distribution", "ID=someos\n"],
    ["a host without os-release", null],
  ])("passes the host checks on %s with Docker installed", (_, osRelease) => {
    const ctx = rocky();
    const file = join(ctx.sysroot, "etc/os-release");
    if (osRelease === null) rmSync(file);
    else writeFileSync(file, osRelease);
    const r = install(ctx, args(ctx));
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).not.toContain("a real run would stop here");
    inOrder(r.stdout, ["==> Docker", "found: Docker Compose", "==> Start"]);
    noApt(ctx, r.stdout);
  });
});

describe("install.sh on Debian", () => {
  function debian({ docker = true }: { docker?: boolean } = {}) {
    const ctx = setup({ docker });
    writeFileSync(
      join(ctx.sysroot, "etc/os-release"),
      'ID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\n'
    );
    return ctx;
  }
  const args = (ctx: Ctx) => [
    "--dry-run",
    "--version",
    "v1.2.0",
    "--dir",
    ctx.dir,
  ];

  it("installs Docker from Docker's Debian repository when it is missing", () => {
    const ctx = debian({ docker: false });
    const r = install(ctx, args(ctx));
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).not.toContain("a real run would stop here");
    expect(r.stdout).toContain("https://download.docker.com/linux/debian/gpg");
    expect(r.stdout).toContain("apt-get install -y docker-ce docker-ce-cli");
  });

  it("refuses to put docker-ce over the distribution's docker.io", () => {
    const ctx = debian({ docker: false });
    writeFileSync(
      join(ctx.bin, "dpkg-query"),
      '#!/bin/sh\ncase "$*" in *docker.io*) printf "install ok installed" ;; *) exit 1 ;; esac\n',
      { mode: 0o755 }
    );
    const r = install(ctx, args(ctx));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docker.io package is installed");
    expect(r.stdout).not.toContain("apt-get install");
  });
});

describe("lint", () => {
  it("install.sh is shellcheck clean", (ctx) => {
    if (!lintToolAvailable("shellcheck")) {
      console.warn("shellcheck not found; skipping the lint of install.sh");
      ctx.skip();
    }
    const r = spawnSync("shellcheck", ["-s", "sh", SCRIPT], {
      encoding: "utf8",
    });
    expect(r.status, r.stdout).toBe(0);
  });

  it("the workflows pass actionlint", (ctx) => {
    if (!lintToolAvailable("actionlint")) {
      console.warn("actionlint not found; skipping the lint of the workflows");
      ctx.skip();
    }
    // Every file in .github/workflows, with the local actions they use.
    const r = spawnSync("actionlint", [], { cwd: REPO, encoding: "utf8" });
    expect(r.status, r.stdout).toBe(0);
  });

  it("install.sh, update.sh and release-manifest.ts share IMAGE_RE, IMAGE_KEYS and the release/health checks", async () => {
    const install = readFileSync(SCRIPT, "utf8");
    const update = readFileSync(join(REPO, "ops/install/update.sh"), "utf8");
    const line = (text: string, name: string) =>
      text.split("\n").find((l) => l.startsWith(`${name}=`));
    for (const name of ["VERSION_RE", "IMAGE_RE", "IMAGE_KEYS"]) {
      expect(line(install, name), name).toBeDefined();
      expect(line(install, name), name).toBe(line(update, name));
    }
    const fn = (text: string, name: string) => {
      const start = text.indexOf(`\n${name}() {`);
      return text.slice(start, text.indexOf("\n}\n", start) + 3);
    };
    for (const name of ["healthy", "one_line_json", "json_str"]) {
      expect(fn(install, name).length, name).toBeGreaterThan(20);
      expect(fn(install, name), name).toBe(fn(update, name));
    }
    const manifest = await import("@/scripts/release-manifest");
    const shRe = line(update, "IMAGE_RE")?.replace(/^IMAGE_RE='|'$/g, "");
    expect(manifest.IMAGE_RE.source).toBe(`^${shRe}$`);
    const shKeys = line(update, "IMAGE_KEYS")
      ?.replace(/^IMAGE_KEYS='|'$/g, "")
      .split(" ")
      .map((pair) => pair.split(":")[1]);
    expect([...manifest.IMAGE_KEYS]).toEqual(shKeys);
  });

  it.each(["release.yml", "ci.yml"])(
    "pins every action in %s to a commit SHA (or uses a local one)",
    (file) => {
      const uses = readFileSync(join(REPO, ".github/workflows", file), "utf8")
        .split("\n")
        .filter((l) => l.trim().startsWith("uses:"));
      expect(uses.length).toBeGreaterThan(3);
      for (const l of uses) {
        expect(l).toMatch(
          /uses: (\.\/\.github\/actions\/[\w.-]+|[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+)$/
        );
      }
    }
  );

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

  it("release.yml attests exactly the assets it uploads", () => {
    type Step = { name?: string; with?: Record<string, string> };
    const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as {
      jobs: { release: { steps: Step[] } };
    };
    const steps = workflow.jobs.release.steps;
    const list = (name: string, key: string) => {
      const step = steps.find((s) => s.name === name);
      return (step?.with?.[key] ?? "").split("\n").filter(Boolean).sort();
    };
    const uploaded = list("Publish the GitHub Release", "files");
    expect(uploaded.length).toBeGreaterThan(0);
    expect(list("Attest the release assets", "subject-path")).toEqual(uploaded);
  });
});

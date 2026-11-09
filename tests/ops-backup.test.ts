import { spawnSync } from "node:child_process";
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
import { afterEach, describe, expect, it } from "vitest";

// ops/backup/*.sh run as root on the hosts. Here they run under bash with stub
// `docker`, `rsync` and `ssh` on PATH that log their argv, against temp dirs.

const BACKUP_SCRIPT = join(__dirname, "..", "ops/backup/dss-panel-backup.sh");
const PRUNE_SCRIPT = join(__dirname, "..", "ops/backup/prune-received.sh");

const S3_SECRET = "s3-secret-Zq9!value";
const S3_ACCESS = "GKaccess-key-id";

// pg_dump/pg_dumpall print a few bytes; `docker run` (rclone) writes one object
// into the host side of its /data/garage mount and records whether the S3
// secret reached it through the environment.
const STUB_DOCKER = `#!/bin/bash
printf 'docker %s\\n' "$*" >> "$STUB_LOG"
if [ -n "\${S3_SECRET_KEY:-}" ]; then echo 'S3_SECRET_KEY leaked' >> "$STUB_LOG"; fi
case "$1" in
  exec)
    if [ -n "\${STUB_PG_FAIL:-}" ]; then echo 'pg down' >&2; exit 1; fi
    printf 'dump-of-%s' "\${!#}" ;;
  run)
    for arg in "$@"; do
      case "$arg" in *:/data/garage) host=\${arg%:/data/garage} ;; esac
    done
    if [ "\${RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY:-}" = "$STUB_EXPECT_SECRET" ]; then
      echo 'rclone env ok' >> "$STUB_LOG"
    fi
    echo "rclone endpoint=\${RCLONE_CONFIG_GARAGE_ENDPOINT:-} region=\${RCLONE_CONFIG_GARAGE_REGION:-}" >> "$STUB_LOG"
    mkdir -p "$host/notes" && printf 'object' > "$host/notes/a.md"
    if [ -n "\${STUB_RCLONE_FAIL:-}" ]; then echo 'garage down' >&2; exit 1; fi ;;
esac
`;

const STUB_RSYNC = `#!/bin/bash
printf 'rsync %s\\n' "$*" >> "$STUB_LOG"
if [ -n "\${S3_SECRET_KEY:-}" ]; then echo 'S3_SECRET_KEY leaked' >> "$STUB_LOG"; fi
if [ -n "\${STUB_RSYNC_FAIL:-}" ]; then echo 'unreachable' >&2; exit 255; fi
exit 0
`;

const STUB_SSH = `#!/bin/bash
printf 'ssh %s\\n' "$*" >> "$STUB_LOG"
exit 255
`;

const ENV_FILE = [
  "DATABASE_URL=postgres://u:p@db/x?a=1&b=$(oops)",
  "S3_ENDPOINT=http://garage:3900",
  "S3_REGION=garage",
  'S3_BUCKET="knowledge"',
  `S3_ACCESS_KEY=${S3_ACCESS}`,
  `S3_SECRET_KEY='${S3_SECRET}'`,
  "",
].join("\n");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ops-backup-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries({
    docker: STUB_DOCKER,
    rsync: STUB_RSYNC,
    ssh: STUB_SSH,
  })) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const backupDir = join(root, "backups");
  const envFile = join(root, ".env");
  writeFileSync(envFile, ENV_FILE);
  const log = join(root, "argv.log");
  writeFileSync(log, "");
  return { root, bin, backupDir, envFile, log };
}

function run(
  script: string,
  ctx: ReturnType<typeof setup>,
  env: Record<string, string> = {}
) {
  const r = spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      PATH: `${ctx.bin}:${process.env.PATH}`,
      TZ: "UTC",
      STUB_LOG: ctx.log,
      STUB_EXPECT_SECRET: S3_SECRET,
      BACKUP_DIR: ctx.backupDir,
      ENV_FILE: ctx.envFile,
      ...env,
    },
  });
  return { ...r, log: readFileSync(ctx.log, "utf8") };
}

// The scripts name days in Asia/Jakarta (UTC+7, no DST) whatever TZ says.
function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString(
    "en-CA",
    { timeZone: "Asia/Jakarta" }
  );
}

describe("dss-panel-backup.sh", () => {
  it("refuses a malformed EXTRA_DUMPS entry", () => {
    const ctx = setup();
    const r = run(BACKUP_SCRIPT, ctx, {
      EXTRA_DUMPS: "shared-postgres:bad;db",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("EXTRA_DUMPS entry must be container:database");
    expect(r.log).not.toContain("pg_dump -U postgres -Fc bad");
  });

  it("happy path writes both dumps, globals, garage dir and SHA256SUMS, then rsyncs", () => {
    const ctx = setup();
    const r = run(BACKUP_SCRIPT, ctx);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);

    const day = isoDay(0);
    const dayDir = join(ctx.backupDir, day);
    expect(statSync(dayDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dayDir).sort()).toEqual([
      "SHA256SUMS",
      "dss_panel.dump",
      "garage",
      "globals.sql",
      "sonarqube_db.dump",
    ]);
    expect(readFileSync(join(dayDir, "dss_panel.dump"), "utf8")).toBe(
      "dump-of-dss_panel"
    );
    expect(readFileSync(join(dayDir, "garage/notes/a.md"), "utf8")).toBe(
      "object"
    );
    for (const file of ["dss_panel.dump", "globals.sql", "garage/notes/a.md"]) {
      expect(statSync(join(dayDir, file)).mode & 0o777).toBe(0o600);
    }
    const sums = readFileSync(join(dayDir, "SHA256SUMS"), "utf8");
    for (const file of [
      "dss_panel.dump",
      "sonarqube_db.dump",
      "globals.sql",
      "garage/notes/a.md",
    ]) {
      expect(sums).toMatch(new RegExp(`^[0-9a-f]{64}  \\./${file}$`, "m"));
    }
    expect(sums).not.toContain("SHA256SUMS");

    const lines = r.log.trim().split("\n");
    const pgDump = lines.findIndex((l) =>
      l.startsWith(
        "docker exec opsdeck-postgres pg_dump -U postgres -Fc dss_panel"
      )
    );
    const rclone = lines.findIndex((l) => l.startsWith("docker run "));
    const rsync = lines.findIndex((l) => l.startsWith("rsync "));
    expect(pgDump).toBeGreaterThanOrEqual(0);
    expect(rclone).toBeGreaterThan(pgDump);
    expect(rsync).toBeGreaterThan(rclone);
    expect(r.log).toContain(
      "docker exec shared-postgres pg_dump -U postgres -Fc sonarqube_db\n"
    );
    expect(r.log).not.toContain(
      "docker exec opsdeck-postgres pg_dump -U postgres -Fc sonarqube_db"
    );
    expect(r.log).toContain(
      "docker exec opsdeck-postgres pg_dumpall -U postgres --globals-only\n"
    );
    expect(lines[rclone]).toContain("--network dss-panel_default");
    expect(lines[rclone]).toContain("rclone/rclone:1 sync garage:knowledge");
    expect(r.log).toContain("rclone env ok\n");
    expect(lines[rsync]).toBe(
      `rsync -a --partial -e ssh -i /root/.ssh/dss-panel-backup -o BatchMode=yes -o ConnectTimeout=30 ${dayDir}/ root@192.168.20.111:${day}/`
    );
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.stdout).toMatch(/dss_panel=17 .*remote=ok/);
  });

  it("an .env without S3_ENDPOINT, S3_REGION and S3_BUCKET still mirrors with the compose defaults", () => {
    const ctx = setup();
    writeFileSync(
      ctx.envFile,
      `S3_ACCESS_KEY=${S3_ACCESS}\nS3_SECRET_KEY='${S3_SECRET}'\n`
    );
    const r = run(BACKUP_SCRIPT, ctx);
    expect(r.status).toBe(0);
    expect(r.log).toContain("rclone/rclone:1 sync garage:knowledge");
    expect(r.log).toContain(
      "rclone endpoint=http://garage:3900 region=garage\n"
    );
    expect(
      existsSync(join(ctx.backupDir, isoDay(0), "garage/notes/a.md"))
    ).toBe(true);
  });

  it("postgres failure exits non-zero, leaves no final-named dump and does not rsync", () => {
    const ctx = setup();
    const r = run(BACKUP_SCRIPT, ctx, { STUB_PG_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(r.log).toContain(
      "docker exec opsdeck-postgres pg_dump -U postgres -Fc dss_panel\n"
    );
    const dayDir = join(ctx.backupDir, isoDay(0));
    const files = existsSync(dayDir) ? readdirSync(dayDir) : [];
    expect(files.filter((f) => f.endsWith(".dump"))).toEqual([]);
    expect(files.filter((f) => f.endsWith(".partial"))).toEqual([]);
    expect(files).not.toContain("SHA256SUMS");
    expect(r.log).not.toMatch(/^rsync /m);
    expect(r.log).not.toMatch(/^docker run /m);
  });

  it("sha256sum failure exits non-zero, writes no SHA256SUMS and does not rsync", () => {
    const ctx = setup();
    const stub = join(ctx.bin, "sha256sum");
    writeFileSync(stub, "#!/bin/bash\necho 'read error' >&2\nexit 1\n");
    chmodSync(stub, 0o755);
    const r = run(BACKUP_SCRIPT, ctx);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("checksums failed");
    const files = readdirSync(join(ctx.backupDir, isoDay(0)));
    expect(files).not.toContain("SHA256SUMS");
    expect(files.filter((f) => f.endsWith(".partial"))).toEqual([]);
    expect(r.log).not.toMatch(/^rsync /m);
  });

  it("rsync failure exits non-zero but keeps the local dumps", () => {
    const ctx = setup();
    const r = run(BACKUP_SCRIPT, ctx, { STUB_RSYNC_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(r.log).toMatch(/^rsync /m);
    const dayDir = join(ctx.backupDir, isoDay(0));
    for (const file of [
      "dss_panel.dump",
      "sonarqube_db.dump",
      "globals.sql",
      "SHA256SUMS",
    ]) {
      expect(existsSync(join(dayDir, file))).toBe(true);
    }
    expect(r.stdout).toContain("remote=failed");
  });

  it("garage mirror failure still pushes the dumps, without a garage dir, and exits non-zero", () => {
    const ctx = setup();
    const r = run(BACKUP_SCRIPT, ctx, { STUB_RCLONE_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(r.log).toMatch(/^docker run /m);
    expect(r.log).toMatch(/^rsync /m);
    const dayDir = join(ctx.backupDir, isoDay(0));
    expect(readdirSync(dayDir).sort()).toEqual([
      "SHA256SUMS",
      "dss_panel.dump",
      "globals.sql",
      "sonarqube_db.dump",
    ]);
    expect(readFileSync(join(dayDir, "SHA256SUMS"), "utf8")).not.toContain(
      "garage"
    );
    expect(r.stdout).toMatch(/garage=failed .*remote=ok/);
  });

  it("retention removes only date dirs older than RETENTION_DAYS", () => {
    const ctx = setup();
    const keep = [isoDay(-14), isoDay(-1), "notes"];
    const drop = [isoDay(-15), isoDay(-40)];
    for (const name of [...keep, ...drop]) {
      mkdirSync(join(ctx.backupDir, name), { recursive: true });
    }
    writeFileSync(join(ctx.backupDir, "2000-01-01"), "a file, not a dir");
    const r = run(BACKUP_SCRIPT, ctx);
    expect(r.status).toBe(0);
    const left = readdirSync(ctx.backupDir);
    for (const name of [...keep, isoDay(0), "2000-01-01"]) {
      expect(left).toContain(name);
    }
    for (const name of drop) expect(left).not.toContain(name);
  });

  it("refuses a RETENTION_DAYS that is not a positive integer and deletes nothing", () => {
    const ctx = setup();
    const old = isoDay(-40);
    mkdirSync(join(ctx.backupDir, old), { recursive: true });
    for (const days of ["-1", "0", "7x"]) {
      const r = run(BACKUP_SCRIPT, ctx, { RETENTION_DAYS: days });
      expect(r.status).not.toBe(0);
    }
    expect(readdirSync(ctx.backupDir)).toEqual([old]);
    expect(readFileSync(ctx.log, "utf8")).toBe("");
  });

  it("S3 secret never appears in the stub argv log", () => {
    const ctx = setup();
    // An inherited S3_SECRET_KEY must not reach docker exec/run or rsync.
    const r = run(BACKUP_SCRIPT, ctx, { S3_SECRET_KEY: "inherited" });
    expect(r.status).toBe(0);
    expect(r.log).toContain("rclone env ok\n");
    expect(r.log).not.toContain(S3_SECRET);
    expect(r.log).not.toContain(S3_ACCESS);
    expect(r.stdout + r.stderr).not.toContain(S3_SECRET);
    expect(r.log).not.toContain("S3_SECRET_KEY leaked");
  });
});

describe("prune-received.sh", () => {
  it("removes only date dirs older than 30 days", () => {
    const ctx = setup();
    const keep = [isoDay(-30), isoDay(0), "lost+found"];
    const drop = [isoDay(-31), isoDay(-90)];
    for (const name of [...keep, ...drop]) {
      mkdirSync(join(ctx.backupDir, name), { recursive: true });
    }
    const r = run(PRUNE_SCRIPT, ctx, { RECEIVED_DIR: ctx.backupDir });
    expect(r.status).toBe(0);
    const left = readdirSync(ctx.backupDir).sort();
    expect(left).toEqual([...keep].sort());
  });

  it("refuses a negative RETENTION_DAYS and deletes nothing", () => {
    const ctx = setup();
    const old = isoDay(-90);
    mkdirSync(join(ctx.backupDir, old), { recursive: true });
    const r = run(PRUNE_SCRIPT, ctx, {
      RECEIVED_DIR: ctx.backupDir,
      RETENTION_DAYS: "-1",
    });
    expect(r.status).not.toBe(0);
    expect(readdirSync(ctx.backupDir)).toEqual([old]);
  });
});

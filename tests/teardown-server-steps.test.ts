import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The server-side teardown steps run their real scripts under `sh` here: the
// SSH layer is replaced by a local `sh -c`, with a fake `docker` (and `sudo`)
// on PATH whose state lives in files. Deploy dirs are real directories under
// a temp root, so `cd`, `pwd -P`, `realpath -m` and `rm -rf` act for real.
// The fake `docker compose` prints the Podman provider banner on stderr and a
// secret from the resolved config, as the real ones can.

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789a2";
const OTHER_ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789b9";
const RUN_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const SSH_PASSWORD = "ssh-pw-very-secret-42";
const CONFIG_SECRET = "config-secret-value-77";

// TD_STEPS_CONTAINER runs every script in that container instead (e.g. a
// busybox one), with TD_STEPS_ROOT bind-mounted at the same path:
//   podman run -d --name td-bb -v /tmp/td-bb:/tmp/td-bb docker.io/library/busybox:1.37 sleep 3600
//   TD_STEPS_CONTAINER=td-bb TD_STEPS_ROOT=/tmp/td-bb env -u SECRETS_KEY bun --bun vitest run tests/teardown-server-steps.test.ts
const CONTAINER = process.env.TD_STEPS_CONTAINER;
const ROOT =
  process.env.TD_STEPS_ROOT ?? mkdtempSync(join(tmpdir(), "td-steps-"));
const BIN = join(ROOT, "bin");
const FAKE = join(ROOT, "fake");
const DEPLOY = join(ROOT, "deployments");
const DIR = join(DEPLOY, "app");

const FAKE_DOCKER = `#!/bin/sh
F="$FAKE"
if [ "$1" = compose ]; then
  echo '>>>> Executing external compose provider "/usr/libexec/docker/cli-plugins/docker-compose". Please see podman-compose(1) for how to disable this message. <<<<' >&2
  shift
  if [ "$1" = config ]; then
    if [ -e .config-fail ]; then echo "line 3: PW=${CONFIG_SECRET}" >&2; exit 15; fi
    if [ "$2" = --volumes ]; then cat .volumes 2>/dev/null; exit 0; fi
    if [ -e .name ]; then n=$(cat .name); else n=$(basename "$PWD"); fi
    printf 'name: %s\\nservices:\\n  app:\\n    environment:\\n      PW: ${CONFIG_SECRET}\\n    name: nested\\n' "$n"
    exit 0
  fi
  if [ "$1" = -p ]; then
    p=$2; shift 2
    echo "$p $*" >> "$F/compose.log"
    if [ "$1" = down ]; then
      grep -v "^$p|" "$F/containers" > "$F/c.tmp"; mv "$F/c.tmp" "$F/containers"
      grep -v "^$p|" "$F/volumes" > "$F/v.tmp"; mv "$F/v.tmp" "$F/volumes"
    fi
    exit 0
  fi
  exit 2
fi
if [ "$1" = ps ]; then
  p=\${4#label=com.docker.compose.project=}
  grep "^$p|" "$F/containers" | cut -d'|' -f2-
  exit 0
fi
if [ "$1" = volume ]; then
  p=\${5#label=com.docker.compose.project=}
  grep "^$p|" "$F/volumes" | cut -d'|' -f2
  exit 0
fi
if [ "$1" = exec ]; then
  if [ "$2" = -i ]; then cat > "$F/drop.sql"; echo 'absent|0' > "$F/probe"; exit 0; fi
  cat "$F/probe"; exit 0
fi
echo "unexpected docker $*" >&2
exit 2
`;

const FAKE_SUDO = `#!/bin/sh
echo "sudo $*" >> "$FAKE/sudo.log"
exit 1
`;

type Call = {
  host: string;
  run: string | undefined;
  command: string;
  stdin: string | undefined;
};

const state = vi.hoisted(() => ({
  calls: [] as Call[],
  servers: {} as Record<
    string,
    {
      serverId: string;
      host: string;
      username: string;
      auth: "password" | "key";
      password: string | null;
    }
  >,
  guard: null as null | {
    otherDeployDirs: string[];
    databaseContainers: string[];
  },
  dbService: null as null | {
    environmentId: string;
    role: string;
    dbKind: "shared" | "container" | "external" | null;
    dbName: string | null;
    databaseHostId: string | null;
  },
  dbHost: null as null | {
    containerName: string;
    server: {
      id: string;
      host: string;
      username: string;
      auth: "password" | "key";
      password: string | null;
    };
  },
  env: {} as Record<string, string>,
}));

function runLocally(command: string, stdin: string | undefined) {
  const result = CONTAINER
    ? spawnSync(
        "podman",
        [
          "exec",
          "-i",
          ...Object.entries(state.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
          CONTAINER,
          "sh",
          "-c",
          command,
        ],
        { input: stdin ?? "", encoding: "utf8" }
      )
    : spawnSync("sh", ["-c", command], {
        env: state.env,
        input: stdin ?? "",
        encoding: "utf8",
      });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

vi.mock("@/lib/ssh", () => ({
  runRemoteScript: async (
    target: { host: string; run?: string },
    command: string,
    options: { stdin?: string } = {}
  ) => {
    state.calls.push({
      host: target.host,
      run: target.run,
      command,
      stdin: options.stdin,
    });
    return runLocally(command, options.stdin);
  },
  executeRemoteCommand: async (
    target: { host: string; run?: string },
    command: string,
    options: { stdin?: string } = {}
  ) => {
    state.calls.push({
      host: target.host,
      run: target.run,
      command,
      stdin: options.stdin,
    });
    const result = runLocally(command, options.stdin);
    if (result.code !== 0) {
      throw new Error(`SSH Command Failed (exit ${result.code})`);
    }
    return result.stdout;
  },
  redactSecrets: (m: string, secrets: string[]) =>
    secrets
      .filter(Boolean)
      .reduce((acc, s) => acc.split(s).join("[redacted]"), m),
}));
vi.mock("@/lib/environments", () => ({
  loadServerCredentials: async (serverId: string) =>
    state.servers[serverId] ?? null,
}));
vi.mock("@/lib/secrets", () => ({
  decryptNullable: (v: string | null) => v,
}));
vi.mock("@/lib/teardown/repository", () => ({
  loadStackGuard: async () => state.guard,
  loadTeardownDbService: async () => state.dbService,
}));
vi.mock("@/lib/provisioning/repository", () => ({
  loadDatabaseHost: async () => state.dbHost,
}));

const {
  checkStack,
  dropDatabase,
  removeDeployDir,
  stackDown,
  projectVolumes,
  stopStack,
  volumeArchiveCommand,
} = await import("@/lib/teardown/server-steps");
const { StepFailed } = await import("@/lib/teardown/errors");

type Guard = NonNullable<typeof state.guard>;
type Server = (typeof state.servers)[string];
type DbService = NonNullable<typeof state.dbService>;

function setGuard(over: Partial<Guard>): void {
  state.guard = { ...(state.guard as Guard), ...over };
}

function ctx() {
  return { environmentId: ENV_ID, runId: RUN_ID, secrets: [] as string[] };
}
const params = { serverId: "server-1", deployDir: DIR };

async function failure(promise: Promise<unknown>): Promise<StepFailedLike> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StepFailed) return error;
    throw error;
  }
  throw new Error("expected the step to fail");
}
type StepFailedLike = InstanceType<typeof StepFailed>;
async function code(promise: Promise<unknown>): Promise<string> {
  return (await failure(promise)).code;
}

/** A deploy dir with a compose file, an optional `name:` and volumes. */
function stack(dir: string, opts: { name?: string; volumes?: string[] } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "compose.yaml"), "services: {}\n");
  if (opts.name !== undefined) writeFileSync(join(dir, ".name"), opts.name);
  writeFileSync(join(dir, ".volumes"), (opts.volumes ?? []).join("\n"));
}
function containers(lines: string[]) {
  writeFileSync(join(FAKE, "containers"), lines.map((l) => `${l}\n`).join(""));
}
function volumes(lines: string[]) {
  writeFileSync(join(FAKE, "volumes"), lines.map((l) => `${l}\n`).join(""));
}
function composeLog(): string[] {
  const file = join(FAKE, "compose.log");
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean)
    : [];
}

beforeEach(() => {
  // Emptied, not removed: in container mode ROOT is a bind mount.
  mkdirSync(ROOT, { recursive: true });
  for (const entry of readdirSync(ROOT)) {
    rmSync(join(ROOT, entry), { recursive: true, force: true });
  }
  for (const dir of [BIN, FAKE, DEPLOY]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(BIN, "docker"), FAKE_DOCKER);
  writeFileSync(join(BIN, "sudo"), FAKE_SUDO);
  chmodSync(join(BIN, "docker"), 0o755);
  chmodSync(join(BIN, "sudo"), 0o755);
  state.env = {
    PATH: `${BIN}:/usr/bin:/bin`,
    FAKE,
    HOME: ROOT,
  };
  stack(DIR, { volumes: ["pgdata"] });
  containers([`app|app-web-1|${DIR}`, `app|app-db-1|${DIR}`]);
  volumes(["app|app_pgdata"]);
  writeFileSync(join(FAKE, "probe"), "absent|0\n");
  state.calls = [];
  state.servers = {
    "server-1": {
      serverId: "server-1",
      host: "app-1.lan",
      username: "ops",
      auth: "key",
      password: null,
    },
  };
  state.guard = {
    otherDeployDirs: [join(DEPLOY, "other")],
    databaseContainers: ["shared-pg"],
  };
  state.dbService = {
    environmentId: ENV_ID,
    role: "db",
    dbKind: "shared",
    dbName: "app_db",
    databaseHostId: "host-1",
  };
  state.dbHost = {
    containerName: "shared-pg",
    server: {
      id: "server-db",
      host: "db.lan",
      username: "ops",
      auth: "password",
      password: SSH_PASSWORD,
    },
  };
});

afterAll(() => {
  if (!process.env.TD_STEPS_ROOT)
    rmSync(ROOT, { recursive: true, force: true });
});

const HOSTILE = [
  "/",
  "/deployments",
  "/deployments/",
  "/deployments/../etc",
  "/deployments/a b",
  "/deployments/x';rm -rf /;'",
  "relative/x",
  "/etc/app",
];

describe("checkStack", () => {
  it("passes this environment's own stack and changes nothing", async () => {
    const line = await checkStack(ctx(), params);
    expect(line).toContain(DIR);
    expect(composeLog()).toEqual([]);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.run).toBe(RUN_ID);
    expect(state.calls[0]?.command).toContain(`'${DIR}'`);
  });

  it("no longer refuses named volumes without a registered db service", async () => {
    await expect(checkStack(ctx(), params)).resolves.toContain(DIR);
  });

  it("is ok when the dir or its compose file is missing", async () => {
    rmSync(join(DIR, "compose.yaml"));
    await expect(checkStack(ctx(), params)).resolves.toBeTypeOf("string");
    rmSync(DIR, { recursive: true });
    await expect(checkStack(ctx(), params)).resolves.toBeTypeOf("string");
  });

  it("finds a compose file named only by COMPOSE_FILE in .env", async () => {
    rmSync(join(DIR, "compose.yaml"));
    writeFileSync(join(DIR, ".env"), "COMPOSE_FILE=stack.yml\n");
    await expect(checkStack(ctx(), params)).resolves.toContain("Stack app");
  });

  it("refuses hostile deploy dirs before any SSH", async () => {
    for (const deployDir of HOSTILE) {
      expect(await code(checkStack(ctx(), { ...params, deployDir }))).toBe(
        "unsafeDeployDir"
      );
    }
    expect(state.calls).toEqual([]);
  });

  it("refuses when our name: gives us another environment's dir-derived project", async () => {
    stack(DIR, { name: "billing" });
    containers([]);
    setGuard({ otherDeployDirs: [join(ROOT, "stacks", "billing")] });
    expect(await code(checkStack(ctx(), params))).toBe("deployDirShared");
  });

  it("refuses a foreign project, resolved through its name:, that only has volumes left", async () => {
    // Env B at deployments/app-dev runs as project "app" (a name: key) and
    // was stopped: no containers, only app_pgdata.
    const other = join(DEPLOY, "app-dev");
    stack(other, { name: "app", volumes: ["pgdata"] });
    containers([]);
    volumes(["app|app_pgdata"]);
    setGuard({ otherDeployDirs: [other] });
    expect(await code(checkStack(ctx(), params))).toBe("deployDirShared");
    expect(await code(stackDown(ctx(), params))).toBe("deployDirShared");
    expect(composeLog()).toEqual([]);
  });

  it("refuses when another environment's compose file cannot be read", async () => {
    const other = join(DEPLOY, "app-dev");
    stack(other);
    writeFileSync(join(other, ".config-fail"), "");
    setGuard({ otherDeployDirs: [other] });
    const failed = await failure(checkStack(ctx(), params));
    expect(failed.code).toBe("serverCommandFailed");
    expect(failed.message).not.toContain(CONFIG_SECRET);
  });

  it("accepts a quoted numeric project name", async () => {
    const dir = join(DEPLOY, "123");
    stack(dir, { name: '"123"' });
    containers([`123|123-web-1|${dir}`]);
    volumes([]);
    await expect(
      checkStack(ctx(), { ...params, deployDir: dir })
    ).resolves.toContain("Stack 123");
  });

  it("refuses when containers of the project were started from another dir", async () => {
    containers([`app|app-web-1|${DIR}`, `app|app-cron-1|${ROOT}/elsewhere`]);
    expect(await code(checkStack(ctx(), params))).toBe("deployDirShared");
  });

  it("refuses a container without a working dir label", async () => {
    containers([`app|app-web-1|`]);
    expect(await code(checkStack(ctx(), params))).toBe("deployDirShared");
  });

  it("accepts containers whose working dir is the resolved path under a symlinked parent", async () => {
    const realParent = join(ROOT, "data");
    const real = join(realParent, "app");
    stack(real, { volumes: ["pgdata"] });
    const link = join(DEPLOY, "linked");
    symlinkSync(realParent, link);
    containers([`app|app-web-1|${real}`]);
    await expect(
      checkStack(ctx(), { ...params, deployDir: join(link, "app") })
    ).resolves.toContain("Stack app");
  });

  it("refuses a deploy dir that is itself a symlink", async () => {
    const real = join(ROOT, "data", "app");
    stack(real);
    const link = join(DEPLOY, "linked");
    symlinkSync(real, link);
    containers([`app|app-web-1|${real}`]);
    for (const step of [checkStack, stopStack, stackDown]) {
      expect(await code(step(ctx(), { ...params, deployDir: link }))).toBe(
        "unsafeDeployDir"
      );
    }
    expect(composeLog()).toEqual([]);
  });

  it("refuses an overlap that only shows once paths are resolved", async () => {
    // Ours is deployments/app through a symlinked parent; the other
    // environment registered the real path.
    rmSync(DEPLOY, { recursive: true });
    const realParent = join(ROOT, "data", "deployments");
    mkdirSync(realParent, { recursive: true });
    symlinkSync(realParent, DEPLOY);
    stack(DIR, { volumes: [] });
    containers([]);
    setGuard({ otherDeployDirs: [join(realParent, "app", "worker")] });
    expect(await code(checkStack(ctx(), params))).toBe("deployDirShared");
    expect(await code(removeDeployDir(ctx(), params))).toBe("deployDirShared");
    expect(existsSync(DIR)).toBe(true);
  });

  it("refuses stackHostsSharedDatabase when the project runs a shared database host's container", async () => {
    containers([`app|app-web-1|${DIR}`, `app|shared-pg|${DIR}`]);
    expect(await code(checkStack(ctx(), params))).toBe(
      "stackHostsSharedDatabase"
    );
  });

  it("refuses a dir another environment's target overlaps, including /, before SSH", async () => {
    for (const other of [DIR, `${DIR}/`, `${DIR}/worker`, DEPLOY, "/"]) {
      state.calls = [];
      setGuard({ otherDeployDirs: [other] });
      expect(await code(checkStack(ctx(), params)), other).toBe(
        "deployDirShared"
      );
      expect(state.calls, other).toEqual([]);
    }
  });

  it("never puts compose's stderr into the error", async () => {
    writeFileSync(join(DIR, ".config-fail"), "");
    const failed = await failure(checkStack(ctx(), params));
    expect(failed.code).toBe("serverCommandFailed");
    expect(failed.message).not.toContain(CONFIG_SECRET);
    expect(failed.message).not.toContain("line 3");
  });
});

describe("stopStack", () => {
  it("stops the project after the checks, in one script", async () => {
    await expect(stopStack(ctx(), params)).resolves.toContain("stopped");
    expect(composeLog()).toEqual(["app stop"]);
    expect(state.calls).toHaveLength(1);
  });

  it("stops nothing when a check refuses", async () => {
    containers([`app|shared-pg|${DIR}`]);
    expect(await code(stopStack(ctx(), params))).toBe(
      "stackHostsSharedDatabase"
    );
    expect(composeLog()).toEqual([]);
  });

  it("is ok when the dir is gone", async () => {
    rmSync(DIR, { recursive: true });
    await expect(stopStack(ctx(), params)).resolves.toContain(
      "nothing to stop"
    );
    expect(composeLog()).toEqual([]);
  });
});

describe("projectVolumes and volumeArchiveCommand", () => {
  it("lists the project's real volumes after the checks and stops nothing", async () => {
    const result = await projectVolumes(ctx(), params);
    expect(result).toEqual({
      dir: DIR,
      project: "app",
      volumes: ["app_pgdata"],
    });
    expect(composeLog()).toEqual([]);
    expect(state.calls).toHaveLength(1);
  });

  it("is ok with no volumes when the dir is gone", async () => {
    rmSync(DIR, { recursive: true });
    await expect(projectVolumes(ctx(), params)).resolves.toMatchObject({
      project: null,
      volumes: [],
    });
  });

  it("refuses a volume name outside the strict pattern", async () => {
    volumes(["app|app_pgdata", "app|bad:name"]);
    expect(await code(projectVolumes(ctx(), params))).toBe(
      "serverCommandFailed"
    );
  });

  it("streams a volume read-only from a throwaway container", () => {
    expect(volumeArchiveCommand("app_pgdata")).toBe(
      "docker run --rm --network none --log-driver none -v 'app_pgdata:/v:ro' docker.io/library/busybox:1.37 tar -C /v -czf - ."
    );
    for (const bad of ["", "a:b", "-x", "a b", "a'b", "../x", "a/b"]) {
      expect(() => volumeArchiveCommand(bad), bad).toThrow(StepFailed);
    }
  });
});

describe("stackDown", () => {
  it("brings the checked project down in its dir, in the same script", async () => {
    await stackDown(ctx(), params);
    expect(composeLog()).toEqual(["app down --remove-orphans --volumes"]);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.command).toContain(`'${DIR}'`);
    expect(readFileSync(join(FAKE, "containers"), "utf8")).toBe("");
  });

  it("is idempotent: a second call runs no further compose down", async () => {
    await stackDown(ctx(), params);
    await expect(stackDown(ctx(), params)).resolves.toContain("already down");
    expect(composeLog()).toHaveLength(1);
  });

  it("is ok when the dir or its compose file is missing", async () => {
    rmSync(join(DIR, "compose.yaml"));
    await expect(stackDown(ctx(), params)).resolves.toBeTypeOf("string");
    rmSync(DIR, { recursive: true });
    await expect(stackDown(ctx(), params)).resolves.toBeTypeOf("string");
    expect(composeLog()).toEqual([]);
  });

  it("refuses when another environment's target appeared after planning", async () => {
    setGuard({ otherDeployDirs: [join(DEPLOY, "other"), DIR] });
    expect(await code(stackDown(ctx(), params))).toBe("deployDirShared");
    expect(composeLog()).toEqual([]);
  });

  it("refuses when the project runs another environment's db container", async () => {
    setGuard({ databaseContainers: ["app-db-1"] });
    expect(await code(stackDown(ctx(), params))).toBe(
      "stackHostsSharedDatabase"
    );
    expect(composeLog()).toEqual([]);
  });

  it("refuses hostile deploy dirs before any SSH", async () => {
    for (const deployDir of HOSTILE) {
      expect(await code(stackDown(ctx(), { ...params, deployDir }))).toBe(
        "unsafeDeployDir"
      );
    }
    expect(state.calls).toEqual([]);
  });
});

describe("removeDeployDir", () => {
  it("removes the canonical dir with rm -rf -- in one script", async () => {
    await removeDeployDir(ctx(), { ...params, deployDir: `${DIR}/` });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.command).toContain(`rm -rf -- `);
    expect(state.calls[0]?.command).not.toContain(`'${DIR}/'`);
    expect(existsSync(DIR)).toBe(false);
    expect(existsSync(DEPLOY)).toBe(true);
  });

  it("is idempotent", async () => {
    await removeDeployDir(ctx(), params);
    await expect(removeDeployDir(ctx(), params)).resolves.toContain(
      "already removed"
    );
  });

  it("refuses when another environment's target appeared after planning", async () => {
    for (const other of [DIR, `${DIR}/data`, DEPLOY, "/"]) {
      state.calls = [];
      setGuard({ otherDeployDirs: [other] });
      expect(await code(removeDeployDir(ctx(), params)), other).toBe(
        "deployDirShared"
      );
      expect(state.calls, other).toEqual([]);
    }
    expect(existsSync(DIR)).toBe(true);
  });

  it("refuses hostile deploy dirs before any SSH", async () => {
    for (const deployDir of HOSTILE) {
      expect(await code(removeDeployDir(ctx(), { ...params, deployDir }))).toBe(
        "unsafeDeployDir"
      );
    }
    expect(state.calls).toEqual([]);
  });

  it("feeds a sudo password on stdin, never in the command", async () => {
    state.servers["server-1"] = {
      ...(state.servers["server-1"] as Server),
      auth: "password",
      password: SSH_PASSWORD,
    };
    const c = ctx();
    await removeDeployDir(c, params);
    const call = state.calls[0];
    expect(call?.command).toContain("sudo -S -p");
    expect(call?.stdin).toBe(`${SSH_PASSWORD}\n`);
    expect(c.secrets).toContain(SSH_PASSWORD);
    expect(call?.command).not.toContain(SSH_PASSWORD);
  });
});

describe("removeDeployDir on the resolved real dir", () => {
  it("refuses a dir that is itself a symlink and deletes neither it nor its target", async () => {
    // As /deployments/x -> /var/lib/postgresql: a target isSafeDeployDir accepts.
    rmSync(DIR, { recursive: true });
    const data = join(ROOT, "var", "lib", "postgresql");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "PG_VERSION"), "18\n");
    for (const target of [data, "/var/lib/postgresql"]) {
      rmSync(DIR, { force: true });
      symlinkSync(target, DIR);
      expect(await code(removeDeployDir(ctx(), params)), target).toBe(
        "unsafeDeployDir"
      );
      expect(lstatSync(DIR).isSymbolicLink()).toBe(true);
    }
    expect(existsSync(join(data, "PG_VERSION"))).toBe(true);
  });

  it("removes the resolved real dir under a symlinked parent", async () => {
    rmSync(DEPLOY, { recursive: true });
    const realParent = join(ROOT, "data", "deployments");
    mkdirSync(join(realParent, "app"), { recursive: true });
    symlinkSync(realParent, DEPLOY);
    await expect(removeDeployDir(ctx(), params)).resolves.toContain("removed");
    expect(existsSync(join(realParent, "app"))).toBe(false);
    expect(existsSync(realParent)).toBe(true);
  });

  it("refuses when the real dir is a system tree or a top-level dir", async () => {
    // A parent symlinked to / (case G): /deployments/root -> /.
    symlinkSync("/", join(DEPLOY, "root"));
    for (const deployDir of [
      // /proc/sys: two segments, in a system tree; /proc: top-level too.
      // Both exist (a missing dir is simply "already removed") and cannot
      // be deleted even if a check were missing.
      join(DEPLOY, "root", "proc", "sys"),
      join(DEPLOY, "root", "proc"),
    ]) {
      expect(
        await code(removeDeployDir(ctx(), { ...params, deployDir })),
        deployDir
      ).toBe("unsafeDeployDir");
    }
  });
});

// busybox 1.37 (and Alpine) `realpath` takes `-m` and `--` for file names:
// it complains about them on stderr, still prints the resolved path of each
// existing argument on stdout, and exits 1. The fake does the same through
// the real one, so the fallbacks run for real. (Under TD_STEPS_CONTAINER
// with a busybox image the real busybox is used instead.)
const BUSYBOX_REALPATH = `#!/bin/sh
rc=0
for a; do
  case "$a" in
    -m|--) echo "realpath: $a: No such file or directory" >&2; rc=1;;
    *) /usr/bin/realpath -e -- "$a" 2>/dev/null || { echo "realpath: $a: No such file or directory" >&2; rc=1; };;
  esac
done
exit $rc
`;
const FAILING = `#!/bin/sh
echo "$0: not available" >&2
exit 1
`;

describe("without realpath -m (busybox)", () => {
  beforeEach(() => {
    if (CONTAINER) return;
    writeFileSync(join(BIN, "realpath"), BUSYBOX_REALPATH);
    chmodSync(join(BIN, "realpath"), 0o755);
  });

  it.skipIf(CONTAINER !== undefined)(
    "the fake prints the path and exits 1 on -m, as busybox does",
    () => {
      const result = runLocally(`realpath -m -- ${DIR}`, undefined);
      expect(result.code).toBe(1);
      expect(result.stdout.trim()).toBe(DIR);
    }
  );

  /** Ours reached through a symlinked parent; the real parent returned. */
  function symlinkedParent(): string {
    rmSync(DEPLOY, { recursive: true });
    const realParent = join(ROOT, "data", "deployments");
    mkdirSync(realParent, { recursive: true });
    symlinkSync(realParent, DEPLOY);
    stack(DIR, { volumes: [] });
    containers([]);
    return realParent;
  }

  it("refuses a neighbour registered by its real path (review case)", async () => {
    const realParent = symlinkedParent();
    const worker = join(realParent, "app", "worker");
    stack(worker);
    setGuard({ otherDeployDirs: [worker] });
    expect(await code(checkStack(ctx(), params))).toBe("deployDirShared");
    expect(await code(removeDeployDir(ctx(), params))).toBe("deployDirShared");
    expect(existsSync(join(worker, "compose.yaml"))).toBe(true);
  });

  it("refuses a neighbour's real path that does not exist yet", async () => {
    const realParent = symlinkedParent();
    setGuard({ otherDeployDirs: [join(realParent, "app", "later", "x")] });
    expect(await code(checkStack(ctx(), params))).toBe("deployDirShared");
    expect(await code(removeDeployDir(ctx(), params))).toBe("deployDirShared");
    expect(existsSync(DIR)).toBe(true);
  });

  it("refuses a neighbour that is our real parent (review case F)", async () => {
    const realParent = symlinkedParent();
    setGuard({ otherDeployDirs: [realParent] });
    expect(await code(checkStack(ctx(), params))).toBe("deployDirShared");
    expect(await code(removeDeployDir(ctx(), params))).toBe("deployDirShared");
    expect(existsSync(DIR)).toBe(true);
  });

  it("refuses a real dir under a parent symlinked to / (review case G)", async () => {
    symlinkedParent();
    symlinkSync("/", join(ROOT, "data", "deployments", "root"));
    const deployDir = join(DEPLOY, "root", "proc", "sys");
    expect(await code(removeDeployDir(ctx(), { ...params, deployDir }))).toBe(
      "unsafeDeployDir"
    );
  });

  it("still removes our dir when nothing overlaps", async () => {
    const realParent = symlinkedParent();
    const other = join(realParent, "other");
    stack(other);
    setGuard({ otherDeployDirs: [other, join(ROOT, "missing", "dir")] });
    await expect(checkStack(ctx(), params)).resolves.toContain("checked");
    await expect(removeDeployDir(ctx(), params)).resolves.toContain("removed");
    expect(existsSync(join(realParent, "app"))).toBe(false);
    expect(existsSync(join(other, "compose.yaml"))).toBe(true);
  });

  it("refuses when no tool can resolve a path, and removes nothing", async () => {
    for (const tool of ["realpath", "readlink"]) {
      writeFileSync(join(BIN, tool), FAILING);
      chmodSync(join(BIN, tool), 0o755);
    }
    for (const step of [checkStack, removeDeployDir]) {
      const failed = await failure(step(ctx(), params));
      expect(failed.code).toBe("serverCommandFailed");
      expect(failed.message).toContain("could not resolve");
    }
    expect(existsSync(DIR)).toBe(true);
  });
});

describe("dropDatabase", () => {
  const dbParams = { serviceId: "svc-db" };

  it("drops a database the Panel provisioned for this environment, and its roles", async () => {
    writeFileSync(join(FAKE, "probe"), "marked|1\n");
    const line = await dropDatabase(ctx(), dbParams);
    expect(line).toContain("app_db dropped");
    const drop = state.calls.find((c) => c.stdin !== undefined);
    expect(drop?.command).toBe(
      "docker exec -i 'shared-pg' psql -U postgres -X -q -At -v ON_ERROR_STOP=1"
    );
    expect(drop?.stdin).toContain("DROP DATABASE");
    expect(drop?.stdin).toContain(`'opsdeck:${ENV_ID}'`);
    expect(state.calls.every((c) => c.host === "db.lan")).toBe(true);
    expect(state.calls.every((c) => c.run === RUN_ID)).toBe(true);
    expect(state.calls.map((c) => c.command).join("\n")).not.toContain(
      SSH_PASSWORD
    );
  });

  it("is idempotent: a second call sends no drop", async () => {
    writeFileSync(join(FAKE, "probe"), "marked|1\n");
    await dropDatabase(ctx(), dbParams);
    state.calls = [];
    await expect(dropDatabase(ctx(), dbParams)).resolves.toContain(
      "already absent"
    );
    expect(state.calls.filter((c) => c.stdin !== undefined)).toEqual([]);
  });

  it("leaves a database the Panel did not provision for this environment", async () => {
    writeFileSync(join(FAKE, "probe"), "unmarked|0\n");
    const line = await dropDatabase(ctx(), dbParams);
    expect(line).toContain("left in place");
    expect(state.calls.filter((c) => c.stdin !== undefined)).toEqual([]);
  });

  it("refuses databaseNotRegistered for a service that is gone, foreign or not shared", async () => {
    const shared = state.dbService;
    const services: (DbService | null)[] = [
      null,
      { ...(shared as DbService), environmentId: OTHER_ENV_ID },
      { ...(shared as DbService), role: "backend" },
      { ...(shared as DbService), dbKind: "container" },
      { ...(shared as DbService), databaseHostId: null },
      { ...(shared as DbService), dbName: null },
    ];
    for (const service of services) {
      state.dbService = service;
      expect(await code(dropDatabase(ctx(), dbParams))).toBe(
        "databaseNotRegistered"
      );
    }
    state.dbService = shared;
    state.dbHost = null;
    expect(await code(dropDatabase(ctx(), dbParams))).toBe(
      "databaseNotRegistered"
    );
    expect(state.calls).toEqual([]);
  });
});

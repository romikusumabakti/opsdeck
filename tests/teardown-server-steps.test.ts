import { beforeEach, describe, expect, it, vi } from "vitest";

// The server-side teardown steps against a fake SSH host: executeRemoteCommand
// is replaced by a small model of one machine (deploy dirs, compose projects,
// containers, volumes, databases on a shared host), so a step's commands
// change that model as the real ones would change the server.

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789a2";
const OTHER_ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789b9";
const RUN_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const SSH_PASSWORD = "ssh-pw-very-secret-42";
const DIR = "/deployments/app";

type Stack = {
  composeFile: boolean;
  // The project `docker compose config` resolves (a `name:` key wins).
  name: string;
  volumes: string[];
  // What `pwd -P` prints (a symlinked dir resolves elsewhere).
  real?: string;
};
type Container = { name: string; project: string; workingDir: string };
type Call = {
  host: string;
  run: string | undefined;
  command: string;
  stdin: string | undefined;
  secrets: string[];
};

const state = vi.hoisted(() => ({
  calls: [] as Call[],
  dirs: new Map<string, Stack | null>(),
  containers: [] as Container[],
  projectVolumes: [] as { name: string; project: string }[],
  // Databases on the shared host's Postgres: name → owner's marker.
  databases: new Map<string, string | null>(),
  markedRoles: 0,
  sshFailure: null as string | null,
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
    hasDbService: boolean;
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
}));

/** The single-quoted words of a command, unquoted. */
function quoted(command: string): string[] {
  return [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) =>
    (m[1] as string).replace(/'\\''/g, "'")
  );
}

function fakeRemote(command: string, stdin: string | undefined): string {
  if (state.sshFailure) {
    throw new Error(`SSH Command Failed (exit 1): ${state.sshFailure}`);
  }
  const dir = quoted(command).find((w) => w.startsWith("/"));
  if (command.includes("docker compose config")) {
    const stack = dir === undefined ? undefined : state.dirs.get(dir);
    if (stack === undefined) return "absent\n";
    if (stack === null || !stack.composeFile) return "nofile\n";
    const lines = [
      `pwd ${dir}`,
      `real ${stack.real ?? dir}`,
      `name ${stack.name}`,
      ...stack.volumes.map((v) => `volume ${v}`),
      ...state.containers
        .filter((c) => c.project === stack.name)
        .map((c) => `container ${c.name}|${c.workingDir}`),
      ...state.projectVolumes
        .filter((v) => v.project === stack.name)
        .map((v) => `projectvolume ${v.name}`),
    ];
    return `${lines.join("\n")}\n`;
  }
  if (command.includes("down --remove-orphans --volumes")) {
    const project = quoted(command).find((w) => !w.startsWith("/"));
    state.containers = state.containers.filter((c) => c.project !== project);
    state.projectVolumes = state.projectVolumes.filter(
      (v) => v.project !== project
    );
    return "";
  }
  if (command.includes("echo present")) {
    return dir !== undefined && state.dirs.has(dir) ? "present\n" : "absent\n";
  }
  if (command.includes("rm -rf --")) {
    if (dir !== undefined) state.dirs.delete(dir);
    return "";
  }
  if (command.includes("psql") && stdin === undefined) {
    const [db] = [...state.databases.keys()];
    const marker = db === undefined ? undefined : state.databases.get(db);
    const status =
      db === undefined
        ? "absent"
        : marker === `opsdeck:${ENV_ID}`
          ? "marked"
          : "unmarked";
    return `${status}|${state.markedRoles}\n`;
  }
  if (command.includes("psql") && stdin !== undefined) {
    for (const [db, marker] of state.databases) {
      if (marker === `opsdeck:${ENV_ID}` && stdin.includes("DROP DATABASE")) {
        state.databases.delete(db);
      }
    }
    if (stdin.includes("DROP ROLE")) state.markedRoles = 0;
    return "";
  }
  throw new Error(`unexpected command: ${command}`);
}

vi.mock("@/lib/ssh", () => ({
  executeRemoteCommand: async (
    target: { host: string; run?: string },
    command: string,
    options: { stdin?: string; secrets?: string[] } = {}
  ) => {
    state.calls.push({
      host: target.host,
      run: target.run,
      command,
      stdin: options.stdin,
      secrets: options.secrets ?? [],
    });
    return fakeRemote(command, options.stdin);
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

const { checkStack, dropDatabase, removeDeployDir, stackDown } = await import(
  "@/lib/teardown/server-steps"
);
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

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StepFailed) return error.code;
    throw error;
  }
  throw new Error("expected the step to fail");
}

function commands(): string[] {
  return state.calls.map((c) => c.command);
}
function destructive(): string[] {
  return commands().filter(
    (c) => c.includes(" down ") || c.includes("rm -rf") || c.includes("DROP") // never in argv
  );
}

beforeEach(() => {
  state.calls = [];
  state.dirs = new Map([
    [DIR, { composeFile: true, name: "app", volumes: ["pgdata"] }],
  ]);
  state.containers = [
    { name: "app-web-1", project: "app", workingDir: DIR },
    { name: "app-db-1", project: "app", workingDir: DIR },
  ];
  state.projectVolumes = [{ name: "app_pgdata", project: "app" }];
  state.databases = new Map();
  state.markedRoles = 0;
  state.sshFailure = null;
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
    otherDeployDirs: ["/deployments/other"],
    databaseContainers: ["shared-pg"],
    hasDbService: true,
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
  it("passes a stack whose volumes belong to a registered db service", async () => {
    const line = await checkStack(ctx(), params);
    expect(line).toContain(DIR);
    expect(destructive()).toEqual([]);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.run).toBe(RUN_ID);
    expect(state.calls[0]?.command).toContain(`'${DIR}'`);
  });

  it("refuses databaseNotRegistered when named volumes exist and no db service is registered", async () => {
    setGuard({ hasDbService: false });
    expect(await failure(checkStack(ctx(), params))).toBe(
      "databaseNotRegistered"
    );
  });

  it("passes a stack without named volumes and no db service", async () => {
    setGuard({ hasDbService: false });
    state.dirs.set(DIR, { composeFile: true, name: "app", volumes: [] });
    await expect(checkStack(ctx(), params)).resolves.toContain(DIR);
  });

  it("is ok when the dir or its compose file is missing", async () => {
    state.dirs.set(DIR, { composeFile: false, name: "app", volumes: [] });
    await expect(checkStack(ctx(), params)).resolves.toBeTypeOf("string");
    state.dirs.clear();
    await expect(checkStack(ctx(), params)).resolves.toBeTypeOf("string");
  });

  it("refuses hostile deploy dirs before any SSH", async () => {
    for (const deployDir of HOSTILE) {
      expect(await failure(checkStack(ctx(), { ...params, deployDir }))).toBe(
        "unsafeDeployDir"
      );
    }
    expect(state.calls).toEqual([]);
  });

  it("refuses when the compose project is another environment's on the same machine", async () => {
    // A `name:` key in our compose file gives our stack the project of the
    // other environment's /opt/stacks/billing.
    state.dirs.set(DIR, { composeFile: true, name: "billing", volumes: [] });
    state.containers = [];
    setGuard({ otherDeployDirs: ["/opt/stacks/billing"] });
    expect(await failure(checkStack(ctx(), params))).toBe("deployDirShared");
  });

  it("refuses when containers of the project were started from another dir", async () => {
    state.containers.push({
      name: "app-cron-1",
      project: "app",
      workingDir: "/home/ops/app",
    });
    expect(await failure(checkStack(ctx(), params))).toBe("deployDirShared");
  });

  it("accepts containers whose working dir is the resolved symlink target", async () => {
    state.dirs.set(DIR, {
      composeFile: true,
      name: "app",
      volumes: ["pgdata"],
      real: "/srv/deployments/app",
    });
    state.containers = [
      { name: "app-web-1", project: "app", workingDir: "/srv/deployments/app" },
    ];
    await expect(checkStack(ctx(), params)).resolves.toContain(DIR);
  });

  it("refuses stackHostsSharedDatabase when the project runs a shared database host's container", async () => {
    state.containers.push({
      name: "shared-pg",
      project: "app",
      workingDir: DIR,
    });
    expect(await failure(checkStack(ctx(), params))).toBe(
      "stackHostsSharedDatabase"
    );
  });

  it("refuses a dir another environment's target overlaps, including /", async () => {
    for (const other of [
      DIR,
      `${DIR}/`,
      `${DIR}/worker`,
      "/deployments",
      "/",
    ]) {
      state.calls = [];
      setGuard({ otherDeployDirs: [other] });
      expect(await failure(checkStack(ctx(), params)), other).toBe(
        "deployDirShared"
      );
      expect(state.calls, other).toEqual([]);
    }
  });

  it("refuses a project name it cannot read", async () => {
    state.dirs.set(DIR, { composeFile: true, name: "", volumes: [] });
    expect(await failure(checkStack(ctx(), params))).toBe(
      "serverCommandFailed"
    );
  });

  it("turns an SSH failure into serverCommandFailed with the secret redacted", async () => {
    state.servers["server-1"] = {
      ...(state.servers["server-1"] as Server),
      auth: "password",
      password: SSH_PASSWORD,
    };
    state.sshFailure = `sudo: wrong password ${SSH_PASSWORD}`;
    const c = ctx();
    try {
      await removeDeployDir(c, params);
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(StepFailed);
      expect((error as InstanceType<typeof StepFailed>).code).toBe(
        "serverCommandFailed"
      );
      expect(String((error as Error).message)).not.toContain(SSH_PASSWORD);
    }
  });
});

describe("stackDown", () => {
  it("brings the project down in its dir with single-quoted words", async () => {
    await stackDown(ctx(), params);
    const down = commands().filter((c) => c.includes(" down "));
    expect(down).toEqual([
      `cd '${DIR}' && docker compose -p 'app' down --remove-orphans --volumes`,
    ]);
    expect(state.containers).toEqual([]);
    expect(state.calls.every((c) => c.run === RUN_ID)).toBe(true);
  });

  it("is idempotent: a second call runs no further compose down", async () => {
    await stackDown(ctx(), params);
    state.calls = [];
    await expect(stackDown(ctx(), params)).resolves.toBeTypeOf("string");
    expect(destructive()).toEqual([]);
  });

  it("is ok when the dir or its compose file is missing", async () => {
    state.dirs.set(DIR, { composeFile: false, name: "app", volumes: [] });
    await expect(stackDown(ctx(), params)).resolves.toBeTypeOf("string");
    state.dirs.clear();
    await expect(stackDown(ctx(), params)).resolves.toBeTypeOf("string");
    expect(destructive()).toEqual([]);
  });

  it("refuses when another environment's target appeared after planning", async () => {
    setGuard({ otherDeployDirs: ["/deployments/other", DIR] });
    expect(await failure(stackDown(ctx(), params))).toBe("deployDirShared");
    expect(destructive()).toEqual([]);
  });

  it("refuses when the project runs another environment's db container", async () => {
    setGuard({ databaseContainers: ["app-db-1"] });
    expect(await failure(stackDown(ctx(), params))).toBe(
      "stackHostsSharedDatabase"
    );
    expect(destructive()).toEqual([]);
  });

  it("refuses hostile deploy dirs before any SSH", async () => {
    for (const deployDir of HOSTILE) {
      expect(await failure(stackDown(ctx(), { ...params, deployDir }))).toBe(
        "unsafeDeployDir"
      );
    }
    expect(state.calls).toEqual([]);
  });
});

describe("removeDeployDir", () => {
  it("removes the dir with rm -rf -- on the single-quoted canonical path", async () => {
    await removeDeployDir(ctx(), { ...params, deployDir: `${DIR}/` });
    const rm = commands().filter((c) => c.includes("rm -rf"));
    expect(rm).toHaveLength(1);
    expect(rm[0]).toContain(`rm -rf -- '${DIR}'`);
    expect(rm[0]).not.toContain(`'${DIR}/'`);
    expect(state.dirs.has(DIR)).toBe(false);
  });

  it("is idempotent: a second call runs no further rm", async () => {
    await removeDeployDir(ctx(), params);
    state.calls = [];
    await expect(removeDeployDir(ctx(), params)).resolves.toBeTypeOf("string");
    expect(destructive()).toEqual([]);
  });

  it("refuses when another environment's target appeared after planning", async () => {
    for (const other of [DIR, `${DIR}/data`, "/deployments", "/"]) {
      state.calls = [];
      setGuard({ otherDeployDirs: [other] });
      expect(await failure(removeDeployDir(ctx(), params)), other).toBe(
        "deployDirShared"
      );
      expect(state.calls, other).toEqual([]);
    }
    expect(state.dirs.has(DIR)).toBe(true);
  });

  it("refuses hostile deploy dirs before any SSH", async () => {
    for (const deployDir of HOSTILE) {
      expect(
        await failure(removeDeployDir(ctx(), { ...params, deployDir }))
      ).toBe("unsafeDeployDir");
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
    const rm = state.calls.find((call) => call.command.includes("rm -rf"));
    expect(rm?.command).toContain("sudo -S");
    expect(rm?.stdin).toBe(`${SSH_PASSWORD}\n`);
    expect(rm?.secrets).toContain(SSH_PASSWORD);
    expect(c.secrets).toContain(SSH_PASSWORD);
    expect(commands().join("\n")).not.toContain(SSH_PASSWORD);
  });
});

describe("dropDatabase", () => {
  const dbParams = { serviceId: "svc-db" };

  it("drops a database the Panel provisioned for this environment, and its roles", async () => {
    state.databases.set("app_db", `opsdeck:${ENV_ID}`);
    state.markedRoles = 1;
    const line = await dropDatabase(ctx(), dbParams);
    expect(line).toContain("app_db");
    expect(state.databases.size).toBe(0);
    const drop = state.calls.find((c) => c.stdin !== undefined);
    expect(drop?.command).toBe(
      "docker exec -i 'shared-pg' psql -U postgres -X -q -At -v ON_ERROR_STOP=1"
    );
    expect(drop?.stdin).toContain("DROP DATABASE");
    expect(drop?.stdin).toContain(`'opsdeck:${ENV_ID}'`);
    expect(state.calls.every((c) => c.host === "db.lan")).toBe(true);
    expect(state.calls.every((c) => c.run === RUN_ID)).toBe(true);
    // The SSH password is never needed: docker exec runs as the SSH user.
    expect(state.calls.map((c) => c.command).join("\n")).not.toContain(
      SSH_PASSWORD
    );
    expect(destructive()).toEqual([]);
  });

  it("is idempotent: a second call sends no drop", async () => {
    state.databases.set("app_db", `opsdeck:${ENV_ID}`);
    state.markedRoles = 1;
    await dropDatabase(ctx(), dbParams);
    state.calls = [];
    await expect(dropDatabase(ctx(), dbParams)).resolves.toContain("app_db");
    expect(state.calls.filter((c) => c.stdin !== undefined)).toEqual([]);
  });

  it("leaves a database the Panel did not provision for this environment", async () => {
    state.databases.set("app_db", `opsdeck:${OTHER_ENV_ID}`);
    const line = await dropDatabase(ctx(), dbParams);
    expect(line).toContain("left in place");
    expect(state.databases.has("app_db")).toBe(true);
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
      expect(await failure(dropDatabase(ctx(), dbParams))).toBe(
        "databaseNotRegistered"
      );
    }
    state.dbService = shared;
    state.dbHost = null;
    expect(await failure(dropDatabase(ctx(), dbParams))).toBe(
      "databaseNotRegistered"
    );
    expect(state.calls).toEqual([]);
  });
});

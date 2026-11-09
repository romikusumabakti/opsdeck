import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The archive steps of a teardown: what they stream from the server, where
// the file lands (S3 destination or the local fallback), how the archive row
// is found again on a retry, and that a failed archive stops the teardown
// before anything destructive. The SSH stream is replaced by a fake that
// writes the command's "output" into the file it was given.

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789a2";
const RUN_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a3";
const SSH_PASSWORD = "ssh-pw-very-secret-42";
const S3_SECRET = "s3-secret-key-very-secret";
const ROOT = mkdtempSync(join(tmpdir(), "td-archive-"));

type Archive = {
  id: string;
  environmentId: string | null;
  projectName: string;
  environmentName: string;
  environmentSlug: string;
  deletedById: string | null;
  expiresAt: Date;
  location: "local" | "s3";
  s3ConnectionId: string | null;
  keyPrefix: string;
  files: { name: string; size: number }[];
  completedAt: Date | null;
};

type Step = {
  id: string;
  position: number;
  kind: string;
  params: Record<string, unknown>;
  status: "pending" | "running" | "done" | "failed";
  lastError: string | null;
};

type StreamCall = {
  host: string;
  command: string;
  stdin?: string;
  path: string;
  timeoutMs: number;
};

const state = vi.hoisted(() => ({
  root: "",
  archives: [] as Archive[],
  steps: [] as Step[],
  run: { status: "started" } as { status: string; error?: string },
  log: [] as string[],
  destination: true,
  connectionGone: false,
  uploads: [] as { key: string; body: string }[],
  uploadError: null as null | string,
  streams: [] as StreamCall[],
  // What the fake server does for a command: exit code, stdout, stderr.
  respond: (_command: string): { code: number; out: string; err?: string } => ({
    code: 0,
    out: "data",
  }),
  dbService: null as null | Record<string, unknown>,
  stopped: [] as string[],
  stopVolumes: [] as string[],
  stopError: null as null | Error,
  serverSteps: [] as string[],
}));

vi.mock("@/lib/instance-backup/archive", () => ({
  get LOCAL_BACKUP_ROOT() {
    return state.root;
  },
  instanceName: () => "opsdeck-test",
}));

// The fake connection "conn-1": today's backup destination while
// `destination` is set, and loadable while `connectionGone` is not.
const fakeStore = () => ({
  upload: async (key: string, filePath: string) => {
    if (state.uploadError) {
      throw new Error(`${state.uploadError} (key ${S3_SECRET})`);
    }
    state.uploads.push({ key, body: readFileSync(filePath, "utf8") });
  },
  list: async () => [],
  read: async () => {
    throw new Error("not read here");
  },
  download: async () => 0,
  delete: async () => {},
});
vi.mock("@/lib/instance-backup/destination", () => ({
  loadBackupDestination: async () =>
    state.destination
      ? {
          connectionId: "conn-1",
          keepDaily: 7,
          keepWeekly: 4,
          store: fakeStore(),
        }
      : null,
  loadS3ConnectionStore: async (id: string) =>
    id === "conn-1" && !state.connectionGone ? fakeStore() : null,
}));

vi.mock("@/lib/ssh", () => ({
  streamRemoteCommandToFile: async (
    target: { host: string },
    command: string,
    filePath: string,
    options: { stdin?: string; timeoutMs: number }
  ) => {
    state.streams.push({
      host: target.host,
      command,
      stdin: options.stdin,
      path: filePath,
      timeoutMs: options.timeoutMs,
    });
    const result = state.respond(command);
    writeFileSync(filePath, result.out, { mode: 0o600 });
    return {
      code: result.code,
      bytes: Buffer.byteLength(result.out),
      stderr: result.err ?? "",
    };
  },
  redactSecrets: (m: string, secrets: string[]) =>
    secrets
      .filter(Boolean)
      .reduce((acc, s) => acc.split(s).join("[redacted]"), m),
}));

vi.mock("@/lib/environments", () => ({
  loadServerCredentials: async (serverId: string) => ({
    serverId,
    host: serverId === "srv-db" ? "10.0.0.9" : "10.0.0.5",
    username: "ops",
    password: SSH_PASSWORD,
    auth: "password",
  }),
}));

vi.mock("@/lib/secrets", () => ({
  decryptNullable: (v: string | null) => v,
}));

vi.mock("@/lib/provisioning/repository", () => ({
  loadDatabaseHost: async () => ({
    containerName: "shared-pg",
    server: {
      id: "srv-db",
      host: "10.0.0.9",
      username: "ops",
      password: SSH_PASSWORD,
      auth: "password",
    },
  }),
  withAdvisoryXactLock: async <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

vi.mock("@/lib/teardown/server-steps", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/teardown/server-steps")>();
  const record = (kind: string) => async () => {
    state.serverSteps.push(kind);
    return `${kind} ok`;
  };
  return {
    volumeArchiveCommand: real.volumeArchiveCommand,
    stopProjectForArchive: async (
      _ctx: unknown,
      params: { deployDir: string }
    ) => {
      if (state.stopError) throw state.stopError;
      state.stopped.push(params.deployDir);
      return {
        message: `Stack app in ${params.deployDir} stopped`,
        project: "app",
        volumes: state.stopVolumes,
      };
    },
    checkStack: record("check_stack"),
    stackDown: record("stack_down"),
    removeDeployDir: record("remove_deploy_dir"),
    dropDatabase: record("drop_database"),
  };
});

vi.mock("@/lib/teardown/repository", () => ({
  loadTeardownDbService: async () => state.dbService,
  loadArchiveSnapshot: async () => ({
    projectName: "HRIS",
    environmentName: "Staging",
    environmentSlug: "staging",
  }),
  findOpenArchive: async (environmentId: string) =>
    state.archives.find(
      (a) => a.environmentId === environmentId && a.completedAt === null
    ) ?? null,
  createArchive: async (values: Omit<Archive, "files" | "completedAt">) => {
    const row: Archive = { ...values, files: [], completedAt: null };
    state.archives.push(row);
    return { ...row };
  },
  addArchiveFile: async (id: string, file: { name: string; size: number }) => {
    const row = state.archives.find((a) => a.id === id);
    if (row && !row.files.some((f) => f.name === file.name)) {
      row.files.push(file);
    }
  },
  getTeardownRun: async () => ({
    environmentId: ENV_ID,
    userId: USER_ID,
    status: state.run.status,
  }),
  listTeardownSteps: async () =>
    [...state.steps]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ ...s })),
  markTeardownStep: async (
    id: string,
    status: Step["status"],
    opts: { error?: string }
  ) => {
    const step = state.steps.find((s) => s.id === id);
    if (step) {
      step.status = status;
      step.lastError = status === "failed" ? (opts.error ?? null) : null;
    }
  },
  failRunningTeardownSteps: async () => {},
  deleteTeardownEnvironment: async () => {
    state.serverSteps.push("delete_environment");
    return { environmentName: "Staging", archiveId: null };
  },
}));

vi.mock("@/lib/run-progress", () => ({
  appendRunOutput: async (_id: string, line: string) => {
    state.log.push(line);
  },
  completeRun: async () => {
    state.run = { status: "success" };
    return true;
  },
  failRun: async (_id: string, error: string) => {
    state.run = { status: "failed", error };
    return true;
  },
}));

vi.mock("@/lib/activity", () => ({ recordActivity: async () => {} }));
vi.mock("@/server/services/cloudflare-account", () => ({
  loadCloudflareAccount: async () => null,
}));

const {
  ARCHIVE_COMMAND_TIMEOUT_MS,
  archiveDatabase,
  archiveDeployDir,
  archiveVolumes,
} = await import("@/lib/teardown/archive");
const { runTeardown } = await import("@/lib/jobs/teardown");
const { StepFailed } = await import("@/lib/teardown/errors");

const ctx = () => ({
  environmentId: ENV_ID,
  runId: RUN_ID,
  userId: USER_ID,
  secrets: [] as string[],
});

const DOCKER_DB = {
  environmentId: ENV_ID,
  dbRole: null as string | null,
  role: "db",
  dbType: "postgres",
  dbKind: "container",
  dbName: "hris_staging",
  databaseHostId: null,
  serviceType: "docker",
  serviceName: "hris-db",
  serverId: "srv-app",
};

const DIR = { serverId: "srv-app", deployDir: "/deployments/hris-staging" };

// The names: a readable slug plus 10 hex of sha256 of the exact source.
const h = (identity: string) =>
  createHash("sha256").update(identity).digest("hex").slice(0, 10);
const DB_FILE = `db-hris_staging-${h("svc")}.dump`;
const deployFile = (dir: string, slug: string) =>
  `deploy-10-0-0-5-${slug}-${h(`10.0.0.5\n${dir}`)}.tar.gz`;
const DEPLOY_FILE = deployFile(DIR.deployDir, "deployments-hris-staging");
const volumeFile = (volume: string) =>
  `volume-10-0-0-5-${volume}-${h(`10.0.0.5\n${volume}`)}.tar.gz`;

/** Every file left anywhere under the local root (temp files included). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  state.root = join(ROOT, "backups");
  state.archives = [];
  state.steps = [];
  state.run = { status: "started" };
  state.log = [];
  state.destination = true;
  state.connectionGone = false;
  state.uploads = [];
  state.uploadError = null;
  state.streams = [];
  state.respond = (command) => ({ code: 0, out: `out of ${command}` });
  state.dbService = { ...DOCKER_DB };
  state.stopped = [];
  state.stopVolumes = [];
  state.stopError = null;
  state.serverSteps = [];
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("archiveDatabase", () => {
  it("dumps a docker db container over SSH and uploads it to S3", async () => {
    const message = await archiveDatabase(ctx(), { serviceId: "svc" });

    expect(state.streams).toHaveLength(1);
    expect(state.streams[0]?.host).toBe("10.0.0.5");
    expect(state.streams[0]?.command).toBe(
      "docker exec 'hris-db' pg_dump -Fc -U postgres 'hris_staging'"
    );
    const [archive] = state.archives;
    expect(archive?.location).toBe("s3");
    expect(archive?.keyPrefix).toBe(
      `opsdeck-env-archives/opsdeck-test/${archive?.id}/`
    );
    expect(archive?.environmentId).toBe(ENV_ID);
    expect(archive?.deletedById).toBe(USER_ID);
    expect(archive?.projectName).toBe("HRIS");
    expect(archive?.environmentSlug).toBe("staging");
    const days =
      ((archive?.expiresAt.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(state.uploads).toEqual([
      {
        key: `opsdeck-env-archives/opsdeck-test/${archive?.id}/${DB_FILE}`,
        body: state.respond(state.streams[0]?.command ?? "").out,
      },
    ]);
    expect(archive?.files).toEqual([
      {
        name: DB_FILE,
        size: Buffer.byteLength(state.uploads[0]?.body ?? ""),
      },
    ]);
    expect(message).toContain(DB_FILE);
    // The temp file is gone once uploaded.
    expect(filesUnder(ROOT)).toEqual([]);
  });

  it("dumps a shared database on its host's container as the binding's role", async () => {
    state.dbService = {
      ...DOCKER_DB,
      dbKind: "shared",
      databaseHostId: "host-1",
      dbRole: "hris_staging_app",
      serverId: "srv-app",
    };
    await archiveDatabase(ctx(), { serviceId: "svc" });
    expect(state.streams[0]?.host).toBe("10.0.0.9");
    // Never as postgres: the role's own objects must not run as superuser.
    expect(state.streams[0]?.command).toBe(
      "docker exec 'shared-pg' pg_dump -Fc -U 'hris_staging_app' 'hris_staging'"
    );
    expect(state.streams[0]?.command).not.toContain("-U postgres");
  });

  it("refuses a shared database without a role, before any SSH", async () => {
    state.dbService = {
      ...DOCKER_DB,
      dbKind: "shared",
      databaseHostId: "host-1",
      dbRole: null,
    };
    await expect(archiveDatabase(ctx(), { serviceId: "svc" })).rejects.toThrow(
      expect.objectContaining({ code: "databaseNotRegistered" })
    );
    expect(state.streams).toEqual([]);
  });

  it("keeps two databases of the same name apart", async () => {
    await archiveDatabase(ctx(), { serviceId: "svc" });
    state.dbService = {
      ...DOCKER_DB,
      dbKind: "shared",
      databaseHostId: "host-1",
      dbRole: "hris_staging",
    };
    await archiveDatabase(ctx(), { serviceId: "svc-2" });
    expect(state.archives[0]?.files.map((f) => f.name)).toEqual([
      DB_FILE,
      `db-hris_staging-${h("svc-2")}.dump`,
    ]);
    expect(state.uploads).toHaveLength(2);
  });

  it("treats exit 44 of pg_dump as a failure, not as nothing to archive", async () => {
    state.respond = () => ({ code: 44, out: "" });
    await expect(archiveDatabase(ctx(), { serviceId: "svc" })).rejects.toThrow(
      expect.objectContaining({ code: "archiveFailed" })
    );
  });

  it("refuses a database it cannot dump, before any SSH", async () => {
    state.dbService = { ...DOCKER_DB, dbType: "mysql" };
    await expect(archiveDatabase(ctx(), { serviceId: "svc" })).rejects.toThrow(
      expect.objectContaining({ code: "databaseBackupUnsupported" })
    );
    state.dbService = { ...DOCKER_DB, environmentId: "someone-else" };
    await expect(archiveDatabase(ctx(), { serviceId: "svc" })).rejects.toThrow(
      expect.objectContaining({ code: "databaseNotRegistered" })
    );
    expect(state.streams).toEqual([]);
    expect(state.archives).toEqual([]);
  });

  it("fails with archiveFailed when pg_dump fails, keeping nothing", async () => {
    state.respond = () => ({
      code: 1,
      out: "partial",
      err: `pg_dump: error: connection failed for ${SSH_PASSWORD}\nmore`,
    });
    const c = ctx();
    c.secrets.push(SSH_PASSWORD);
    const error = await archiveDatabase(c, { serviceId: "svc" }).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(StepFailed);
    expect(error).toMatchObject({ code: "archiveFailed" });
    expect(String((error as Error).message)).toContain("pg_dump: error");
    expect(String((error as Error).message)).not.toContain(SSH_PASSWORD);
    expect(state.uploads).toEqual([]);
    expect(state.archives[0]?.files ?? []).toEqual([]);
    expect(filesUnder(ROOT)).toEqual([]);
  });

  it("treats an empty dump as a failure", async () => {
    state.respond = () => ({ code: 0, out: "" });
    await expect(archiveDatabase(ctx(), { serviceId: "svc" })).rejects.toThrow(
      expect.objectContaining({ code: "archiveFailed" })
    );
    expect(state.uploads).toEqual([]);
  });

  it("fails with archiveFailed on an S3 upload failure, without the secret", async () => {
    state.uploadError = "S3 is down";
    const c = ctx();
    c.secrets.push(S3_SECRET);
    const error = await archiveDatabase(c, { serviceId: "svc" }).catch(
      (e: unknown) => e
    );
    expect(error).toMatchObject({ code: "archiveFailed" });
    expect(String((error as Error).message)).toContain("S3 is down");
    expect(String((error as Error).message)).not.toContain(S3_SECRET);
    expect(state.archives[0]?.files).toEqual([]);
    expect(filesUnder(ROOT)).toEqual([]);
  });

  it("re-uses the archive row on a retry and does not upload again", async () => {
    await archiveDatabase(ctx(), { serviceId: "svc" });
    const message = await archiveDatabase(ctx(), { serviceId: "svc" });
    await archiveDeployDir(ctx(), DIR);

    expect(state.archives).toHaveLength(1);
    expect(state.uploads.map((u) => u.key.split("/").pop())).toEqual([
      DB_FILE,
      DEPLOY_FILE,
    ]);
    // The second dump is not even taken.
    expect(
      state.streams.filter((s) => s.command.includes("pg_dump"))
    ).toHaveLength(1);
    expect(message).toContain("already archived");
  });

  it("starts a new archive once the previous one is completed", async () => {
    await archiveDatabase(ctx(), { serviceId: "svc" });
    const first = state.archives[0] as Archive;
    first.completedAt = new Date();
    await archiveDatabase(ctx(), { serviceId: "svc" });
    expect(state.archives).toHaveLength(2);
    expect(state.archives[1]?.id).not.toBe(first.id);
  });

  it("writes under the local backup root without an S3 destination", async () => {
    state.destination = false;
    await archiveDatabase(ctx(), { serviceId: "svc" });

    const archive = state.archives[0] as Archive;
    const dir = join(state.root, "opsdeck-test", "env-archives", archive.id);
    expect(archive.location).toBe("local");
    expect(archive.keyPrefix).toBe(`${dir}/`);
    const file = join(dir, DB_FILE);
    expect(readFileSync(file, "utf8")).toBe(
      state.respond(state.streams[0]?.command ?? "").out
    );
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(
      statSync(join(state.root, "opsdeck-test", "env-archives")).mode & 0o777
    ).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Only the finished file: no temp file left beside it.
    expect(filesUnder(ROOT)).toEqual([file]);
    expect(archive.files).toEqual([
      { name: DB_FILE, size: statSync(file).size },
    ]);
    expect(state.uploads).toEqual([]);
  });

  it("keeps an S3 archive on its own connection, whatever the destination setting says", async () => {
    await archiveDatabase(ctx(), { serviceId: "svc" });
    expect(state.archives[0]?.s3ConnectionId).toBe("conn-1");
    // The setting changed to local since: the archive still goes to conn-1.
    state.destination = false;
    await archiveDeployDir(ctx(), DIR);
    expect(state.uploads.map((u) => u.key)).toEqual([
      expect.stringMatching(/db-/),
      expect.stringMatching(/deploy-/),
    ]);
    expect(state.archives).toHaveLength(1);
  });

  it("fails the step once the archive's S3 connection is gone", async () => {
    await archiveDatabase(ctx(), { serviceId: "svc" });
    state.connectionGone = true;
    await expect(archiveDeployDir(ctx(), DIR)).rejects.toThrow(
      expect.objectContaining({ code: "archiveFailed" })
    );
    expect(state.archives).toHaveLength(1);
  });
});

describe("archiveDeployDir", () => {
  it("streams a tar of the dir from its parent", async () => {
    await archiveDeployDir(ctx(), DIR);
    const command = state.streams[0]?.command ?? "";
    expect(command).toContain("tar -C '/deployments' -czf - -- 'hris-staging'");
    expect(command).not.toContain(SSH_PASSWORD);
    expect(state.archives[0]?.files.map((f) => f.name)).toEqual([DEPLOY_FILE]);
  });

  it("retries elevated when tar fails as the SSH user, the password on stdin", async () => {
    state.respond = (command) =>
      command.includes("sudo")
        ? { code: 0, out: "tarball" }
        : { code: 2, out: "", err: "tar: ./data: Permission denied" };
    await archiveDeployDir(ctx(), DIR);
    expect(state.streams).toHaveLength(2);
    expect(state.streams[1]?.command).toContain("sudo -S -p '' tar -C");
    expect(state.streams[1]?.stdin).toBe(`${SSH_PASSWORD}\n`);
    expect(state.streams.map((s) => s.command).join("\n")).not.toContain(
      SSH_PASSWORD
    );
    expect(state.uploads[0]?.body).toBe("tarball");
  });

  it("keeps dirs whose slugs collide apart", async () => {
    for (const deployDir of [
      "/srv/app-x",
      "/srv/app/x",
      "/srv/App",
      "/srv/app",
    ]) {
      await archiveDeployDir(ctx(), { serverId: "srv-app", deployDir });
    }
    expect(state.archives[0]?.files.map((f) => f.name)).toEqual([
      deployFile("/srv/app-x", "srv-app-x"),
      deployFile("/srv/app/x", "srv-app-x"),
      deployFile("/srv/App", "srv-app"),
      deployFile("/srv/app", "srv-app"),
    ]);
    expect(new Set(state.uploads.map((u) => u.key)).size).toBe(4);
  });

  it("shares one time budget between the plain and the elevated tar", async () => {
    const budget = ARCHIVE_COMMAND_TIMEOUT_MS;
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      state.respond = (command) => {
        if (command.includes("sudo")) return { code: 0, out: "tarball" };
        now += budget / 2;
        return { code: 2, out: "", err: "tar: Permission denied" };
      };
      await archiveDeployDir(ctx(), DIR);
      expect(state.streams.map((s) => s.timeoutMs)).toEqual([
        budget,
        budget / 2,
      ]);

      // The plain attempt used it all (a timeout): no elevated retry.
      state.streams = [];
      state.archives = [];
      state.respond = () => {
        now += budget;
        return { code: null as unknown as number, out: "", err: "" };
      };
      await expect(archiveDeployDir(ctx(), DIR)).rejects.toThrow(
        expect.objectContaining({ code: "archiveFailed" })
      );
      expect(state.streams).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("archives nothing when the dir is absent", async () => {
    state.respond = () => ({ code: 44, out: "" });
    const message = await archiveDeployDir(ctx(), DIR);
    expect(message).toContain("nothing to archive");
    expect(state.uploads).toEqual([]);
    expect(state.archives[0]?.files ?? []).toEqual([]);
    expect(filesUnder(ROOT)).toEqual([]);
  });

  it("refuses an unsafe dir before any SSH", async () => {
    await expect(
      archiveDeployDir(ctx(), {
        serverId: "srv-app",
        deployDir: "/deployments",
      })
    ).rejects.toThrow(expect.objectContaining({ code: "unsafeDeployDir" }));
    expect(state.streams).toEqual([]);
  });
});

describe("archiveVolumes", () => {
  it("stops the stack, then archives each volume that still exists", async () => {
    state.stopVolumes = ["app_data", "app_cache"];
    await archiveVolumes(ctx(), DIR);

    expect(state.stopped).toEqual([DIR.deployDir]);
    expect(state.streams).toHaveLength(2);
    const command = state.streams[0]?.command ?? "";
    // Checked right before it is read: docker run would create an empty one.
    expect(
      command.indexOf("docker volume inspect 'app_data'")
    ).toBeGreaterThanOrEqual(0);
    expect(command.indexOf("docker volume inspect")).toBeLessThan(
      command.indexOf("docker run")
    );
    expect(command).toContain("-v 'app_data:/v:ro'");
    expect(state.archives[0]?.files.map((f) => f.name)).toEqual([
      volumeFile("app_data"),
      volumeFile("app_cache"),
    ]);
  });

  it("skips volumes already archived on a retry", async () => {
    state.stopVolumes = ["app_data", "app_cache"];
    state.respond = (command) =>
      command.includes("app_cache")
        ? { code: 1, out: "", err: "tar: read error" }
        : { code: 0, out: "volume" };
    await expect(archiveVolumes(ctx(), DIR)).rejects.toThrow(
      expect.objectContaining({ code: "archiveFailed" })
    );
    state.respond = () => ({ code: 0, out: "volume" });
    state.streams = [];
    await archiveVolumes(ctx(), DIR);
    expect(state.streams.map((s) => s.command)).toEqual([
      expect.stringContaining("app_cache"),
    ]);
    expect(state.archives[0]?.files.map((f) => f.name)).toEqual([
      volumeFile("app_data"),
      volumeFile("app_cache"),
    ]);
  });

  it("says the stack is left stopped when a volume fails after the stop", async () => {
    state.stopVolumes = ["app_data"];
    state.respond = () => ({ code: 44, out: "" });
    const error = await archiveVolumes(ctx(), DIR).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "archiveFailed" });
    expect(String((error as Error).message)).toContain("app_data");
    expect(String((error as Error).message)).toContain("left stopped");
    expect(state.uploads).toEqual([]);
    expect(filesUnder(ROOT)).toEqual([]);
  });

  it("maps only docker's no-such-volume to a missing volume", async () => {
    state.stopVolumes = ["app_data"];
    state.respond = () => ({
      code: 45,
      out: "",
      err: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    });
    const error = await archiveVolumes(ctx(), DIR).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "archiveFailed" });
    expect(String((error as Error).message)).toContain(
      "Cannot connect to the Docker daemon"
    );
    expect(String((error as Error).message)).not.toContain("no longer exists");

    // The script itself: no such volume (Docker or Podman wording) is 44.
    const command = state.streams[0]?.command ?? "";
    expect(command).toContain('*[Nn]"o such volume"*) exit 44');
    expect(command).toContain("exit 45");
  });

  it("passes on a refusal before the stop as it is", async () => {
    state.stopError = new StepFailed("deployDirShared");
    await expect(archiveVolumes(ctx(), DIR)).rejects.toThrow(
      expect.objectContaining({ code: "deployDirShared" })
    );
    expect(state.streams).toEqual([]);
  });

  it("archives nothing when the stack has no volumes", async () => {
    const message = await archiveVolumes(ctx(), DIR);
    expect(message).toContain("stopped");
    expect(state.streams).toEqual([]);
  });
});

describe("a failed archive in the runner", () => {
  function seed(kinds: [string, Record<string, unknown>][]) {
    state.steps = kinds.map(([kind, params], position) => ({
      id: `s${position}`,
      position,
      kind,
      params,
      status: "pending",
      lastError: null,
    }));
  }

  it("stops at archive_database with archiveFailed; no later step runs", async () => {
    seed([
      ["check_stack", DIR],
      ["archive_database", { serviceId: "svc" }],
      ["archive_deploy_dir", DIR],
      ["archive_volumes", DIR],
      ["stack_down", DIR],
      ["remove_deploy_dir", DIR],
      ["delete_environment", {}],
    ]);
    state.uploadError = "S3 is down";

    const result = await runTeardown({ environmentId: ENV_ID, runId: RUN_ID });

    expect(result).toEqual({ status: "failed" });
    expect(state.steps.map((s) => s.status)).toEqual([
      "done",
      "failed",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(state.steps[1]?.lastError).toBe("archiveFailed");
    expect(state.serverSteps).toEqual(["check_stack"]);
    expect(state.stopped).toEqual([]);
    expect(state.run.status).toBe("failed");

    // Retry once S3 is back: resumes at the archive and runs to the end.
    state.uploadError = null;
    state.run = { status: "started" };
    expect(await runTeardown({ environmentId: ENV_ID, runId: RUN_ID })).toEqual(
      { status: "success" }
    );
    expect(state.serverSteps).toEqual([
      "check_stack",
      "stack_down",
      "remove_deploy_dir",
      "delete_environment",
    ]);
    expect(state.archives).toHaveLength(1);
  });
});

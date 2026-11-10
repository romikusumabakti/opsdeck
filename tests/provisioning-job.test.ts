import { beforeEach, describe, expect, it, vi } from "vitest";

const PASSWORD = "pw-very-secret-0123456789";
const RUN_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789a2";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a3";

type Step = {
  id: string;
  position: number;
  kind: string;
  params: Record<string, unknown>;
  status: "pending" | "running" | "done" | "failed";
  lastError: string | null;
};

const state = vi.hoisted(() => ({
  steps: [] as Step[],
  log: [] as string[],
  flagged: [] as string[],
  failures: [] as string[],
  run: null as null | { status: string; error?: string },
  variable: undefined as undefined | { kind: string; value: string },
  build: null as null | { id: string; tag: string },
  // deploy_target.deploy_next_build of t1, and the order the deploy step
  // touched it in.
  flag: false,
  calls: [] as string[],
  // Simulates the build hook placing the build between the flag and the lookup.
  hookTakesBuild: false,
  deployError: null as unknown,
  sshCommands: [] as string[],
  sshRuns: [] as unknown[],
  listError: false,
  runMissing: false,
  // The target already has a successful deployment.
  targetDeployed: false,
}));

vi.mock("@/lib/provisioning/repository", () => ({
  getProvisionRun: async () =>
    state.runMissing
      ? null
      : {
          environmentId: ENV_ID,
          userId: USER_ID,
          status: state.run?.status ?? "started",
        },
  failRunningSteps: async (_env: string, message: string) => {
    for (const step of state.steps) {
      if (step.status === "running") {
        step.status = "failed";
        step.lastError = message;
      }
    }
  },
  listSteps: async () => {
    if (state.listError) throw new Error("db down");
    return [...state.steps]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ ...s }));
  },
  markStep: async (
    id: string,
    status: Step["status"],
    opts: { error?: string }
  ) => {
    const step = state.steps.find((s) => s.id === id);
    if (step) {
      step.status = status;
      step.lastError = opts.error ?? null;
    }
  },
  loadDatabaseHost: async () => ({
    containerName: "pg",
    server: { host: "db.test", username: "ops", password: "ssh-pw" },
  }),
  targetHasSuccessfulDeployment: async () => state.targetDeployed,
  findNewestBuild: async () => {
    state.calls.push("findNewestBuild");
    if (state.hookTakesBuild) state.flag = false;
    return state.build;
  },
}));

vi.mock("@/lib/run-progress", () => ({
  appendRunOutput: async (_id: string, line: string) => {
    state.log.push(line);
  },
  // Mirrors the real guard: with onlyIfStarted a closed run stays as it is.
  completeRun: async (_id: string, opts?: { onlyIfStarted?: boolean }) => {
    if (opts?.onlyIfStarted && state.run && state.run.status !== "started") {
      return false;
    }
    state.run = { status: "success" };
    return true;
  },
  failRun: async (
    _id: string,
    error: string,
    opts?: { onlyIfStarted?: boolean }
  ) => {
    if (opts?.onlyIfStarted && state.run && state.run.status !== "started") {
      return false;
    }
    state.run = { status: "failed", error };
    return true;
  },
}));

vi.mock("@/lib/secrets", () => ({
  decryptSecret: (v: string) => v,
  decryptNullable: (v: string | null) => v,
}));
vi.mock("@/lib/environments", () => ({
  loadServerCredentials: async () => ({
    host: "app.test",
    username: "ops",
    password: "ssh-pw",
  }),
}));
vi.mock("@/lib/ssh", () => ({
  executeRemoteCommand: async (c: { run?: string }, command: string) => {
    state.sshCommands.push(command);
    state.sshRuns.push(c.run);
    return "";
  },
  redactSecrets: (m: string, secrets: string[]) =>
    secrets.reduce((acc, s) => acc.split(s).join("[redacted]"), m),
}));
vi.mock("@/lib/variables/repository", () => ({
  getVariable: async () => state.variable,
}));
vi.mock("@/lib/deploy/repository", () => ({
  getTarget: async () => ({
    id: "t1",
    environmentId: ENV_ID,
    componentKey: "hris",
    sourceBranch: "main",
  }),
  flagDeployNextBuild: async (targetId: string) => {
    state.calls.push("flagDeployNextBuild");
    state.flagged.push(targetId);
    state.flag = true;
  },
}));
vi.mock("@/lib/provisioning/database", () => ({
  redactSecrets: (m: string, secrets: string[]) =>
    secrets.reduce((acc, s) => acc.split(s).join("[redacted]"), m),
  provisionSharedDatabase: vi.fn(
    async (_host: unknown, input: { password: string }) => {
      if (state.failures.includes("create_database")) {
        throw new Error(`psql failed for password ${input.password}`);
      }
    }
  ),
}));
// The gated placement: places (and clears the flag) only while it is set.
const requestFlaggedDeployment = vi.hoisted(() => vi.fn());
vi.mock("@/server/services/deployments", () => ({ requestFlaggedDeployment }));

const { runProvisioning } = await import("@/lib/jobs/provision");
const { HTTPException } = await import("hono/http-exception");

function seed(
  kinds: string[] = ["prepare_deploy_dir", "create_database", "deploy"]
) {
  const params: Record<string, Record<string, unknown>> = {
    prepare_deploy_dir: { serverId: "srv", deployDir: "/opt/hris app" },
    create_database: {
      databaseHostId: "host",
      database: "hris_staging",
      role: "hris_staging",
      passwordVariable: "DB_PASSWORD",
    },
    deploy: { targetId: "t1", branch: "main" },
  };
  state.steps = kinds.map((kind, position) => ({
    id: `s${position}`,
    position,
    kind,
    params: params[kind] as Record<string, unknown>,
    status: "pending",
    lastError: null,
  }));
}

const run = () => runProvisioning({ environmentId: ENV_ID, runId: RUN_ID });
const statuses = () => state.steps.map((s) => s.status);

beforeEach(() => {
  state.log = [];
  state.flagged = [];
  state.failures = [];
  state.run = null;
  state.sshCommands = [];
  state.sshRuns = [];
  state.listError = false;
  state.runMissing = false;
  state.variable = { kind: "generated", value: PASSWORD };
  state.build = { id: "b1", tag: "main-abc" };
  state.flag = false;
  state.calls = [];
  state.hookTakesBuild = false;
  state.targetDeployed = false;
  requestFlaggedDeployment.mockReset();
  requestFlaggedDeployment.mockImplementation(async () => {
    if (!state.flag) return null;
    state.flag = false;
    return { deploymentId: "dep-1", runId: "r1", status: "queued" };
  });
  seed();
});

describe("runProvisioning", () => {
  it("runs every step and completes the run", async () => {
    await expect(run()).resolves.toEqual({ status: "success" });
    expect(statuses()).toEqual(["done", "done", "done"]);
    expect(state.run?.status).toBe("success");
    expect(state.sshCommands[0]).toBe(
      "[ -d '/opt/hris app' ] || install -d -m 0750 '/opt/hris app'"
    );
    expect(new Set(state.sshRuns)).toEqual(new Set([RUN_ID]));
    expect(requestFlaggedDeployment).toHaveBeenCalledWith({
      targetId: "t1",
      tag: "main-abc",
      trigger: "manual",
      userId: USER_ID,
      buildId: "b1",
    });
  });

  it("a failing create_database keeps the directory done and fails the run, then resumes", async () => {
    state.failures = ["create_database"];
    await expect(run()).resolves.toEqual({ status: "failed" });
    expect(statuses()).toEqual(["done", "failed", "pending"]);
    expect(state.run?.status).toBe("failed");

    // A retry is a new run.
    state.failures = [];
    state.sshCommands = [];
    state.run = null;
    await expect(run()).resolves.toEqual({ status: "success" });
    expect(statuses()).toEqual(["done", "done", "done"]);
    // The finished directory step did not run again.
    expect(state.sshCommands).toEqual([]);
  });

  it("never writes the password to the log or the stored error", async () => {
    state.failures = ["create_database"];
    await run();
    const everything = JSON.stringify([
      state.log,
      state.steps.map((s) => s.lastError),
      state.run,
    ]);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).toContain("[redacted]");
  });

  it("fails create_database when the variable is missing or plain", async () => {
    state.variable = undefined;
    await run();
    expect(state.steps[1]?.lastError).toBe("variable DB_PASSWORD missing");
    seed();
    state.run = null;
    state.variable = { kind: "plain", value: "x" };
    await run();
    expect(state.steps[1]?.status).toBe("failed");
  });

  it("flags the target and ends done when there is no build yet", async () => {
    seed(["deploy"]);
    state.build = null;
    await run();
    expect(state.steps[0]?.status).toBe("done");
    expect(state.flagged).toEqual(["t1"]);
    expect(state.log.join("\n")).toContain(
      "Waiting for the first build of main; it deploys when it lands"
    );
    expect(requestFlaggedDeployment).not.toHaveBeenCalled();
  });

  it("deploys nothing for a target that already deployed (no flag, no placement)", async () => {
    seed(["deploy"]);
    state.targetDeployed = true;
    await run();
    expect(state.steps[0]?.status).toBe("done");
    expect(state.flagged).toEqual([]);
    expect(requestFlaggedDeployment).not.toHaveBeenCalled();
    expect(state.log.join("\n")).toContain("already deployed");
  });

  it("sets the flag before looking for a build", async () => {
    seed(["deploy"]);
    await run();
    expect(state.calls).toEqual(["flagDeployNextBuild", "findNewestBuild"]);
  });

  it("a build exists: places it exactly once and the flag ends cleared", async () => {
    seed(["deploy"]);
    await run();
    expect(state.steps[0]?.status).toBe("done");
    expect(requestFlaggedDeployment).toHaveBeenCalledTimes(1);
    expect(state.flag).toBe(false);
    expect(state.log.join("\n")).toContain(
      "Deployment dep-1 of main-abc queued"
    );
  });

  it("no build: the flag stays set for the build hook", async () => {
    seed(["deploy"]);
    state.build = null;
    await run();
    expect(state.flag).toBe(true);
    expect(requestFlaggedDeployment).not.toHaveBeenCalled();
  });

  it("the build hook got there first: no second placement, step done", async () => {
    seed(["deploy"]);
    state.hookTakesBuild = true;
    await run();
    expect(requestFlaggedDeployment).toHaveBeenCalledTimes(1);
    expect(state.steps[0]?.status).toBe("done");
    expect(state.log.join("\n")).toContain(
      "The build hook already deployed main-abc"
    );
    expect(state.run?.status).toBe("success");
  });

  it("fails deploy with the lock message when the environment is locked", async () => {
    seed(["deploy"]);
    requestFlaggedDeployment.mockRejectedValue(
      new HTTPException(409, { message: "Locked by Romi until 10:00: freeze" })
    );
    await run();
    expect(state.steps[0]?.lastError).toBe(
      "Locked by Romi until 10:00: freeze"
    );
    expect(state.run?.status).toBe("failed");
  });

  it("retries a step left running by a crashed worker", async () => {
    seed(["prepare_deploy_dir"]);
    (state.steps[0] as Step).status = "running";
    await expect(run()).resolves.toEqual({ status: "success" });
    expect(statuses()).toEqual(["done"]);
    expect(state.sshCommands).toHaveLength(1);
  });

  it("passes the environment id so the role gets its marker", async () => {
    seed(["create_database"]);
    const { provisionSharedDatabase } = await import(
      "@/lib/provisioning/database"
    );
    await run();
    expect(provisionSharedDatabase).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        database: "hris_staging",
        role: "hris_staging",
        environmentId: ENV_ID,
      })
    );
  });

  it("accepts a secret-kind password variable", async () => {
    seed(["create_database"]);
    state.variable = { kind: "secret", value: PASSWORD };
    await expect(run()).resolves.toEqual({ status: "success" });
    expect(statuses()).toEqual(["done"]);
  });

  it("fails the run and rethrows when the steps cannot be listed", async () => {
    state.listError = true;
    await expect(run()).rejects.toThrow("db down");
    expect(state.run).toEqual({ status: "failed", error: "db down" });
  });

  it("fails a leftover running step when the job dies outside a step", async () => {
    (state.steps[0] as Step).status = "running";
    state.listError = true;
    await expect(run()).rejects.toThrow();
    // listSteps is what failed, so the sweep of running steps is what closes it.
    expect(statuses()[0]).toBe("failed");
  });

  it("throws without running steps when the run does not exist", async () => {
    state.runMissing = true;
    await expect(run()).rejects.toThrow("not found");
    expect(statuses()).toEqual(["pending", "pending", "pending"]);
    expect(state.sshCommands).toEqual([]);
  });

  it("a redelivered job for a failed run executes no step", async () => {
    state.run = { status: "failed", error: "Worker restarted" };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(run()).resolves.toEqual({ status: "failed" });
    expect(statuses()).toEqual(["pending", "pending", "pending"]);
    expect(state.sshCommands).toEqual([]);
    expect(requestFlaggedDeployment).not.toHaveBeenCalled();
    expect(state.log).toEqual([]);
    expect(state.run).toEqual({ status: "failed", error: "Worker restarted" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skipping"));
    log.mockRestore();
  });

  it("asks for guarded completion and failure only", async () => {
    const progress = await import("@/lib/run-progress");
    const complete = vi.spyOn(progress, "completeRun");
    const fail = vi.spyOn(progress, "failRun");
    await run();
    expect(complete).toHaveBeenCalledWith(RUN_ID, { onlyIfStarted: true });
    seed();
    state.run = null;
    state.failures = ["create_database"];
    await run();
    expect(fail).toHaveBeenCalledWith(RUN_ID, expect.any(String), {
      onlyIfStarted: true,
    });
    complete.mockRestore();
    fail.mockRestore();
  });

  it("a run closed while its steps ran stays failed", async () => {
    seed(["prepare_deploy_dir"]);
    // The stale check fails the run while the step is running.
    const progress = await import("@/lib/run-progress");
    const append = vi
      .spyOn(progress, "appendRunOutput")
      .mockImplementation(async (_id, line) => {
        state.log.push(line);
        if (line.startsWith("✔"))
          state.run = { status: "failed", error: "stale" };
      });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(run()).resolves.toEqual({ status: "failed" });
    expect(state.run).toEqual({ status: "failed", error: "stale" });
    append.mockRestore();
    log.mockRestore();
  });
});

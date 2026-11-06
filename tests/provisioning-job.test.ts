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
  failures: [] as string[],
  run: null as null | { status: string; error?: string },
  variable: undefined as undefined | { kind: string; value: string },
  build: null as null | { id: string; tag: string },
  deployError: null as unknown,
  sshCommands: [] as string[],
}));

vi.mock("@/lib/provisioning/repository", () => ({
  getProvisionRun: async () => ({ environmentId: ENV_ID, userId: USER_ID }),
  listSteps: async () =>
    [...state.steps]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ ...s })),
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
  findNewestBuild: async () => state.build,
}));

vi.mock("@/lib/run-progress", () => ({
  appendRunOutput: async (_id: string, line: string) => {
    state.log.push(line);
  },
  completeRun: async () => {
    state.run = { status: "success" };
  },
  failRun: async (_id: string, error: string) => {
    state.run = { status: "failed", error };
  },
}));

vi.mock("@/lib/secrets", () => ({ decryptSecret: (v: string) => v }));
vi.mock("@/lib/environments", () => ({
  loadServerCredentials: async () => ({
    host: "app.test",
    username: "ops",
    password: "ssh-pw",
  }),
}));
vi.mock("@/lib/ssh", () => ({
  executeRemoteCommand: async (_c: unknown, command: string) => {
    state.sshCommands.push(command);
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
const requestDeployment = vi.hoisted(() => vi.fn());
vi.mock("@/server/services/deployments", () => ({ requestDeployment }));

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
  state.failures = [];
  state.run = null;
  state.sshCommands = [];
  state.variable = { kind: "generated", value: PASSWORD };
  state.build = { id: "b1", tag: "main-abc" };
  requestDeployment.mockReset();
  requestDeployment.mockResolvedValue({
    deploymentId: "dep-1",
    runId: "r1",
    status: "queued",
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
    expect(requestDeployment).toHaveBeenCalledWith({
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

    state.failures = [];
    state.sshCommands = [];
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
    state.variable = { kind: "plain", value: "x" };
    await run();
    expect(state.steps[1]?.status).toBe("failed");
  });

  it("fails deploy naming the branch when there is no build", async () => {
    seed(["deploy"]);
    state.build = null;
    await run();
    expect(state.steps[0]?.status).toBe("failed");
    expect(state.steps[0]?.lastError).toBe(
      "No build of main yet; retry after the first build"
    );
    expect(requestDeployment).not.toHaveBeenCalled();
  });

  it("fails deploy with the lock message when the environment is locked", async () => {
    seed(["deploy"]);
    requestDeployment.mockRejectedValue(
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
});

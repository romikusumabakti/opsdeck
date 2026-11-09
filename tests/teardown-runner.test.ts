import { beforeEach, describe, expect, it, vi } from "vitest";

// The teardown runner: the steps in order, skipping done ones, resuming from
// a failed or crashed step, a stable code per failure, the redelivery guard,
// and the Cloudflare removals (idempotent on "absent"). The archive and
// server steps are faked; they have their own tests.

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789a2";
const RUN_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a3";
const CF_TOKEN = "cf-token-very-secret-0123";

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
  run: null as null | { status: string; error?: string },
  runMissing: false,
  envGone: false,
  listError: false,
  executed: [] as string[],
  // kind -> what the fake step does instead of succeeding.
  behaviour: {} as Record<string, () => Promise<string>>,
  activity: [] as Record<string, unknown>[],
  deleted: false,
  cf: {
    dns: "deleted" as "deleted" | "absent",
    app: "deleted" as "deleted" | "absent",
    config: { ingress: [] as { hostname?: string; service: string }[] },
    puts: [] as unknown[],
    error: null as null | Error,
    calls: [] as string[],
  },
  zoneMissing: false,
  tunnelMissing: false,
}));

const fakeStep =
  (kind: string) =>
  async (..._args: unknown[]): Promise<string> => {
    state.executed.push(kind);
    const custom = state.behaviour[kind];
    return custom ? custom() : `${kind} ok`;
  };

vi.mock("@/lib/teardown/archive", () => ({
  archiveDatabase: fakeStep("archive_database"),
  archiveDeployDir: fakeStep("archive_deploy_dir"),
  archiveVolumes: fakeStep("archive_volumes"),
}));
vi.mock("@/lib/teardown/server-steps", () => ({
  checkStack: fakeStep("check_stack"),
  stackDown: fakeStep("stack_down"),
  dropDatabase: fakeStep("drop_database"),
  removeDeployDir: fakeStep("remove_deploy_dir"),
}));

vi.mock("@/lib/teardown/repository", () => ({
  getTeardownRun: async () =>
    state.runMissing || state.deleted
      ? null
      : {
          environmentId: ENV_ID,
          userId: USER_ID,
          status: state.run?.status ?? "started",
        },
  listTeardownSteps: async () => {
    if (state.listError) throw new Error("db down");
    return [...state.steps]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ ...s }));
  },
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
  failRunningTeardownSteps: async (_env: string, code: string) => {
    for (const step of state.steps) {
      if (step.status === "running") {
        step.status = "failed";
        step.lastError = code;
      }
    }
  },
  // The repository records the activity in the delete's transaction.
  deleteTeardownEnvironment: async (environmentId: string, actorId: string) => {
    state.executed.push("delete_environment");
    // The cascade takes the steps and the run with the environment.
    state.steps = [];
    state.deleted = true;
    state.activity.push({ environmentId, actorId });
    return { environmentName: "Staging", archiveId: "arch-1" };
  },
  environmentExists: async () => !state.deleted && !state.envGone,
}));

vi.mock("@/lib/run-progress", () => ({
  appendRunOutput: async (_id: string, line: string) => {
    if (!state.deleted) state.log.push(line);
  },
  completeRun: async (_id: string, opts?: { onlyIfStarted?: boolean }) => {
    if (state.deleted) return false;
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
    if (state.deleted) return false;
    if (opts?.onlyIfStarted && state.run && state.run.status !== "started") {
      return false;
    }
    state.run = { status: "failed", error };
    return true;
  },
}));

vi.mock("@/lib/activity", () => ({
  recordActivity: async (input: Record<string, unknown>) => {
    state.activity.push(input);
  },
}));

vi.mock("@/server/services/cloudflare-account", () => ({
  loadCloudflareAccount: async () => ({
    creds: { accountId: "acc-1", apiToken: CF_TOKEN },
    accessIdpId: null,
  }),
}));
vi.mock("@/lib/domains/repository", () => ({
  getZoneCloudflareId: async () => (state.zoneMissing ? undefined : "cf-zone"),
  getRemoteTunnel: async () =>
    state.tunnelMissing ? undefined : { tunnelId: "cf-tunnel", name: "dev" },
}));
vi.mock("@/lib/provisioning/repository", () => ({
  withAdvisoryXactLock: async <T>(key: string, fn: () => Promise<T>) => {
    state.cf.calls.push(`lock ${key}`);
    return fn();
  },
}));
vi.mock("@/lib/cloudflare/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/cloudflare/api")>();
  const fail = () => {
    if (state.cf.error) throw state.cf.error;
  };
  return {
    withoutIngressRoute: real.withoutIngressRoute,
    deleteDnsRecord: async (
      creds: { apiToken: string },
      zoneId: string,
      recordId: string
    ) => {
      fail();
      state.cf.calls.push(
        `dns ${zoneId} ${recordId} ${creds.apiToken === CF_TOKEN}`
      );
      return state.cf.dns;
    },
    deleteAccessApp: async (
      _creds: unknown,
      accountId: string,
      appId: string
    ) => {
      fail();
      state.cf.calls.push(`app ${accountId} ${appId}`);
      return state.cf.app;
    },
    getTunnelConfig: async () => {
      fail();
      return structuredClone(state.cf.config);
    },
    putTunnelConfig: async (_c: unknown, _t: string, config: unknown) => {
      state.cf.puts.push(config);
    },
  };
});

const { runTeardown } = await import("@/lib/jobs/teardown");
const { StepFailed } = await import("@/lib/teardown/errors");

const DIR = { serverId: "srv", deployDir: "/deployments/hris-staging" };
const PARAMS: Record<string, Record<string, unknown>> = {
  check_stack: DIR,
  archive_database: { serviceId: "svc" },
  archive_deploy_dir: DIR,
  archive_volumes: DIR,
  stack_down: DIR,
  drop_database: { serviceId: "svc" },
  remove_dns_record: { zoneId: "zone-row", recordId: "rec-1" },
  remove_tunnel_route: {
    remoteTunnelId: "tunnel-row",
    hostname: "hris-staging.example.com",
  },
  remove_access_app: { zoneId: "zone-row", appId: "app-1" },
  remove_deploy_dir: DIR,
  delete_environment: {},
};
const ALL = Object.keys(PARAMS);

function seed(kinds: string[] = ALL, statuses: Step["status"][] = []) {
  state.steps = kinds.map((kind, position) => ({
    id: `s${position}`,
    position,
    kind,
    params: PARAMS[kind] as Record<string, unknown>,
    status: statuses[position] ?? "pending",
    lastError: null,
  }));
}

const run = () => runTeardown({ environmentId: ENV_ID, runId: RUN_ID });
const statuses = () => state.steps.map((s) => s.status);

beforeEach(() => {
  state.steps = [];
  state.log = [];
  state.run = null;
  state.runMissing = false;
  state.envGone = false;
  state.listError = false;
  state.executed = [];
  state.behaviour = {};
  state.activity = [];
  state.deleted = false;
  state.cf = {
    dns: "deleted",
    app: "deleted",
    config: {
      ingress: [
        { hostname: "hris-staging.example.com", service: "http://app:80" },
        { hostname: "other.example.com", service: "http://other:80" },
        { service: "http_status:404" },
      ],
    },
    puts: [],
    error: null,
    calls: [],
  };
  state.zoneMissing = false;
  state.tunnelMissing = false;
});

describe("runTeardown", () => {
  it("runs every step in order and ends with the environment deleted", async () => {
    seed();
    expect(await run()).toEqual({ status: "success" });
    expect(state.executed).toEqual([
      "check_stack",
      "archive_database",
      "archive_deploy_dir",
      "archive_volumes",
      "stack_down",
      "drop_database",
      "remove_deploy_dir",
      "delete_environment",
    ]);
    // Recorded by deleteTeardownEnvironment, for the run's user.
    expect(state.activity).toEqual([
      { environmentId: ENV_ID, actorId: USER_ID },
    ]);
  });

  it("resumes from the failed step and never redoes a done one", async () => {
    seed(ALL, ["done", "done", "failed"]);
    state.steps[2] = {
      ...(state.steps[2] as Step),
      lastError: "archiveFailed",
    };
    expect(await run()).toEqual({ status: "success" });
    expect(state.executed[0]).toBe("archive_deploy_dir");
    expect(state.executed).not.toContain("check_stack");
    expect(state.executed).not.toContain("archive_database");
  });

  it("stops at a failed step with its code; later steps stay pending", async () => {
    seed(["check_stack", "archive_database", "stack_down"]);
    state.behaviour.archive_database = async () => {
      throw new StepFailed("archiveFailed", `S3 is down ${CF_TOKEN}`);
    };
    expect(await run()).toEqual({ status: "failed" });
    expect(statuses()).toEqual(["done", "failed", "pending"]);
    expect(state.steps[1]?.lastError).toBe("archiveFailed");
    expect(state.executed).not.toContain("stack_down");
    expect(state.run?.status).toBe("failed");
    expect(state.log.some((l) => l.includes("S3 is down"))).toBe(true);
  });

  it("stores a generic code for an unexpected error", async () => {
    seed(["check_stack", "remove_dns_record"]);
    state.behaviour.check_stack = async () => {
      throw new Error("boom");
    };
    expect(await run()).toEqual({ status: "failed" });
    expect(state.steps[0]?.lastError).toBe("stepFailed");
  });

  it("does nothing for a redelivered job whose run is closed", async () => {
    seed(ALL, ["done", "failed"]);
    state.run = { status: "failed", error: "earlier" };
    expect(await run()).toEqual({ status: "failed" });
    expect(state.executed).toEqual([]);
    expect(statuses()[1]).toBe("failed");
    expect(state.log).toEqual([]);

    state.run = { status: "success" };
    expect(await run()).toEqual({ status: "success" });
    expect(state.executed).toEqual([]);
  });

  it("leaves a step running after a crash mid-step; the next run retries it", async () => {
    seed(["check_stack", "archive_database", "stack_down"]);
    // The worker dies inside the step: its promise never settles.
    state.behaviour.archive_database = () => new Promise<string>(() => {});
    void run();
    await vi.waitFor(() => {
      expect(state.executed).toContain("archive_database");
    });
    expect(statuses()).toEqual(["done", "running", "pending"]);

    // A new run (the old one was failed by the boot sweep or a retry).
    state.executed = [];
    state.behaviour = {};
    state.run = { status: "started" };
    state.steps.push({
      id: "s3",
      position: 3,
      kind: "delete_environment",
      params: {},
      status: "pending",
      lastError: null,
    });
    expect(await run()).toEqual({ status: "success" });
    expect(state.executed).toEqual([
      "archive_database",
      "stack_down",
      "delete_environment",
    ]);
  });

  it("closes the run when something escapes the steps", async () => {
    seed(["check_stack"]);
    state.listError = true;
    await expect(run()).rejects.toThrow("db down");
    expect(state.run).toEqual({ status: "failed", error: "db down" });
  });

  it("throws when the run is missing but the environment is not", async () => {
    state.runMissing = true;
    await expect(run()).rejects.toThrow(/not found/);
  });

  it("succeeds quietly when a redelivered job finds its environment deleted", async () => {
    seed();
    expect(await run()).toEqual({ status: "success" });
    state.executed = [];
    // The worker died after the delete committed; the job comes back.
    expect(await run()).toEqual({ status: "success" });
    expect(state.executed).toEqual([]);
    expect(state.activity).toHaveLength(1);
  });

  it("refuses an invalid stored step", async () => {
    seed(["remove_deploy_dir"]);
    state.steps[0] = {
      ...(state.steps[0] as Step),
      params: { serverId: "srv", deployDir: "/" },
    };
    expect(await run()).toEqual({ status: "failed" });
    expect(state.steps[0]?.lastError).toBe("stepFailed");
    expect(state.executed).toEqual([]);
  });

  it("completes a teardown without delete_environment as a normal run", async () => {
    seed(["check_stack"]);
    expect(await run()).toEqual({ status: "success" });
    expect(state.run?.status).toBe("success");
  });
});

describe("Cloudflare removals", () => {
  it("deletes the DNS record in the zone; absent is ok", async () => {
    seed(["remove_dns_record"]);
    expect(await run()).toEqual({ status: "success" });
    expect(state.cf.calls).toContain("dns cf-zone rec-1 true");

    state.cf.dns = "absent";
    state.run = { status: "started" };
    seed(["remove_dns_record"]);
    expect(await run()).toEqual({ status: "success" });
    expect(state.log.some((l) => l.includes("already"))).toBe(true);
  });

  it("deletes the Access app in the account; absent is ok", async () => {
    seed(["remove_access_app"]);
    state.cf.app = "absent";
    expect(await run()).toEqual({ status: "success" });
    expect(state.cf.calls).toContain("app acc-1 app-1");
  });

  it("removes the tunnel route under the tunnel lock, keeping the rest", async () => {
    seed(["remove_tunnel_route"]);
    expect(await run()).toEqual({ status: "success" });
    expect(state.cf.calls).toContain("lock cf-tunnel:cf-tunnel");
    expect(state.cf.puts).toEqual([
      {
        ingress: [
          { hostname: "other.example.com", service: "http://other:80" },
          { service: "http_status:404" },
        ],
      },
    ]);
  });

  it("does not write the tunnel config when the route is already gone", async () => {
    state.cf.config = { ingress: [{ service: "http_status:404" }] };
    seed(["remove_tunnel_route"]);
    expect(await run()).toEqual({ status: "success" });
    expect(state.cf.puts).toEqual([]);
  });

  it("fails with cloudflareFailed on an API error, the token redacted", async () => {
    state.cf.error = new Error(`Cloudflare said no to ${CF_TOKEN}`);
    seed(["remove_dns_record", "delete_environment"]);
    expect(await run()).toEqual({ status: "failed" });
    expect(state.steps[0]?.lastError).toBe("cloudflareFailed");
    expect(state.run?.error).toContain("Cloudflare said no");
    expect(state.run?.error).not.toContain(CF_TOKEN);
    expect(state.log.join("\n")).not.toContain(CF_TOKEN);
    expect(state.executed).not.toContain("delete_environment");
  });

  it("fails with cloudflareFailed when the zone or tunnel row is gone", async () => {
    state.zoneMissing = true;
    seed(["remove_dns_record"]);
    expect(await run()).toEqual({ status: "failed" });
    expect(state.steps[0]?.lastError).toBe("cloudflareFailed");

    state.tunnelMissing = true;
    state.run = { status: "started" };
    seed(["remove_tunnel_route"]);
    expect(await run()).toEqual({ status: "failed" });
    expect(state.steps[0]?.lastError).toBe("cloudflareFailed");
  });
});

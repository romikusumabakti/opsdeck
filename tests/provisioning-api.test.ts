import { beforeEach, describe, expect, it, vi } from "vitest";

// The provisioning API through the Hono app, against an in-memory repository
// whose startProvisioningRun mirrors the SQL (conflict while a run is started).

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";

const state = vi.hoisted(() => ({
  role: "engineer" as string | null,
  activeRunId: null as string | null,
  config: null as unknown,
  seq: 0,
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: USER_ID, role: "member" },
  })),
}));

vi.mock("@/lib/authz", async () => {
  const { canProject } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    requireProjectPermission: vi.fn(
      async (_scope: unknown, perms: Parameters<typeof canProject>[1]) => {
        if (!state.role) throw new HTTPException(404, { message: "Not Found" });
        if (!canProject(state.role as "viewer", perms)) {
          throw new HTTPException(403, { message: "Forbidden" });
        }
        return {
          session: { user: { id: USER_ID, role: "member" } },
          role: state.role,
          projectId: "project-1",
        };
      }
    ),
  };
});

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

const queue = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@/lib/queue", () => queue);

vi.mock("@/lib/run-progress", () => ({ failRun: vi.fn() }));

const repo = vi.hoisted(() => ({
  loadProvisioningConfig: vi.fn(),
  listSteps: vi.fn(async () => []),
  savePlan: vi.fn(async () => {}),
  getActiveProvisionRunId: vi.fn(),
  startProvisioningRun: vi.fn(),
  hasSuccessfulDeployment: vi.fn(async () => false),
}));
vi.mock("@/lib/provisioning/repository", () => repo);

const cloudflare = vi.hoisted(() => ({
  listAccessPolicies: vi.fn(),
}));
vi.mock("@/lib/cloudflare/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cloudflare/api")>()),
  listAccessPolicies: cloudflare.listAccessPolicies,
}));
vi.mock("@/server/services/cloudflare-account", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/services/cloudflare-account")
  >()),
  callCloudflare: async (call: (creds: unknown) => unknown) =>
    call({ accountId: "a", apiToken: "t" }),
}));

const { app } = await import("@/server/app");

const goodConfig = {
  name: "HRIS Staging",
  targets: [
    { id: "t1", serverId: "s1", deployDir: "/opt/hris", sourceBranch: "main" },
  ],
  db: null,
};

const post = () =>
  app.request(`/api/environments/${ENV_ID}/provisioning`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

const tunnelDomain = {
  kind: "tunnel",
  hostname: "hris-staging.example.net",
  zoneId: "zone-row-1",
  remoteTunnelId: "rt-1",
  originHost: "localhost",
  tunnelName: "dss-srv-113",
  accessPolicyId: "pol-1",
  accessAppId: null,
  dnsRecordId: null,
  entryPort: 8091,
};

beforeEach(() => {
  vi.clearAllMocks();
  cloudflare.listAccessPolicies.mockResolvedValue([
    { id: "pol-1", name: "DSS staff", decision: "allow", everyone: false },
  ]);
  state.role = "engineer";
  state.activeRunId = null;
  state.seq = 0;
  repo.loadProvisioningConfig.mockResolvedValue(goodConfig);
  repo.hasSuccessfulDeployment.mockResolvedValue(false);
  repo.getActiveProvisionRunId.mockImplementation(
    async () => state.activeRunId
  );
  repo.startProvisioningRun.mockImplementation(async () => {
    if (state.activeRunId) return { conflict: true };
    state.activeRunId = `run-${++state.seq}`;
    return { runId: state.activeRunId };
  });
});

describe("provisioning API", () => {
  it("refuses a contributor", async () => {
    state.role = "qa";
    expect((await post()).status).toBe(403);
    const get = await app.request(`/api/environments/${ENV_ID}/provisioning`);
    expect(get.status).toBe(403);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("lets a maintainer start a run and queues the job", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: "run-1" });
    expect(repo.savePlan).toHaveBeenCalledOnce();
    expect(queue.enqueue).toHaveBeenCalledWith("provision/run.requested", {
      environmentId: ENV_ID,
      runId: "run-1",
    });
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "environment.provision",
        data: { environment: "HRIS Staging" },
      })
    );
  });

  it("still answers 200 when recording the activity fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    activity.recordActivity.mockRejectedValueOnce(new Error("db down"));
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: "run-1" });
    errors.mockRestore();
  });

  it("answers 409 to a second start while a run is active, with one job", async () => {
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(409);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("answers 409 teardownRunning while the environment is being deleted", async () => {
    repo.startProvisioningRun.mockResolvedValueOnce({ tearingDown: true });
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "teardownRunning" });
    expect(repo.savePlan).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("answers 422 with the plan error code", async () => {
    repo.loadProvisioningConfig.mockResolvedValue({
      ...goodConfig,
      db: {
        dbKind: "shared",
        databaseHostId: "h1",
        dbName: "hris_staging",
        dbRole: null,
        dbPasswordVariable: null,
      },
    });
    const res = await post();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "missing_db_fields" });
    expect(repo.startProvisioningRun).not.toHaveBeenCalled();
  });

  it("GET returns steps, the plan preview and the active run", async () => {
    state.activeRunId = "run-9";
    const res = await app.request(`/api/environments/${ENV_ID}/provisioning`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeRunId).toBe("run-9");
    expect(body.steps).toEqual([]);
    expect(body.plan.map((s: { kind: string }) => s.kind)).toEqual([
      "prepare_deploy_dir",
      "deploy",
    ]);
    // Never deployed: the panel shows.
    expect(body.showPanel).toBe(true);
  });

  it("GET hides the panel and plans nothing for jar and static targets only", async () => {
    repo.loadProvisioningConfig.mockResolvedValue({
      ...goodConfig,
      targets: [
        { ...goodConfig.targets[0], kind: "static" },
        { ...goodConfig.targets[0], id: "t-jar", kind: "jar" },
      ],
    });
    const body = await (
      await app.request(`/api/environments/${ENV_ID}/provisioning`)
    ).json();
    expect(body.showPanel).toBe(false);
    expect(body.plan).toEqual([]);
  });

  it("POST refuses and starts nothing for jar and static targets only", async () => {
    repo.loadProvisioningConfig.mockResolvedValue({
      ...goodConfig,
      db: {
        dbKind: "shared",
        databaseHostId: "h1",
        dbName: "d",
        dbRole: "r",
        dbPasswordVariable: "DB_PASSWORD",
      },
      targets: [{ ...goodConfig.targets[0], kind: "jar" }],
    });
    expect((await post()).status).toBe(422);
    expect(repo.startProvisioningRun).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("GET hides the panel for a legacy environment that already deployed", async () => {
    const get = async () =>
      (await app.request(`/api/environments/${ENV_ID}/provisioning`)).json();
    repo.hasSuccessfulDeployment.mockResolvedValue(true);
    expect((await get()).showPanel).toBe(false);
    // Unless it has provisioning steps…
    repo.listSteps.mockResolvedValueOnce([{ id: "s" }] as never);
    expect((await get()).showPanel).toBe(true);
    // …or a shared database binding.
    repo.loadProvisioningConfig.mockResolvedValue({
      ...goodConfig,
      db: {
        dbKind: "shared",
        databaseHostId: "h1",
        dbName: "hris_staging",
        dbRole: "hris_staging",
        dbPasswordVariable: "DB_PASSWORD",
      },
    });
    expect((await get()).showPanel).toBe(true);
    // A container binding is legacy-like.
    repo.loadProvisioningConfig.mockResolvedValue({
      ...goodConfig,
      db: {
        dbKind: "container",
        databaseHostId: null,
        dbName: "hris",
        dbRole: null,
        dbPasswordVariable: null,
      },
    });
    expect((await get()).showPanel).toBe(false);
  });

  it("GET hides the panel once every step is done and the environment deployed", async () => {
    const get = async () =>
      (await app.request(`/api/environments/${ENV_ID}/provisioning`)).json();
    repo.hasSuccessfulDeployment.mockResolvedValue(true);
    const done = [
      { id: "s1", status: "done" },
      { id: "s2", status: "done" },
    ];
    repo.listSteps.mockResolvedValue(done as never);
    expect((await get()).showPanel).toBe(false);
    // Also with a shared database that the finished run provisioned.
    repo.loadProvisioningConfig.mockResolvedValue({
      ...goodConfig,
      db: {
        dbKind: "shared",
        databaseHostId: "h1",
        dbName: "app",
        dbRole: "app",
        dbPasswordVariable: "DB_PASSWORD",
      },
    });
    expect((await get()).showPanel).toBe(false);
    // A failed or unfinished step keeps it.
    repo.listSteps.mockResolvedValue([
      { id: "s1", status: "done" },
      { id: "s2", status: "failed" },
    ] as never);
    expect((await get()).showPanel).toBe(true);
    repo.listSteps.mockResolvedValue([
      { id: "s1", status: "pending" },
    ] as never);
    expect((await get()).showPanel).toBe(true);
    // Done steps but never deployed successfully: still shown.
    repo.listSteps.mockResolvedValue(done as never);
    repo.hasSuccessfulDeployment.mockResolvedValue(false);
    expect((await get()).showPanel).toBe(true);
  });

  describe("with a tunnel domain", () => {
    const get = async () =>
      (await app.request(`/api/environments/${ENV_ID}/provisioning`)).json();

    it("GET plans the Cloudflare steps and names the tunnel and policy", async () => {
      repo.loadProvisioningConfig.mockResolvedValue({
        ...goodConfig,
        domain: tunnelDomain,
      });
      const body = await get();
      expect(body.plan.map((s: { kind: string }) => s.kind)).toEqual([
        "prepare_deploy_dir",
        "access_app",
        "tunnel_route",
        "dns_record",
        "deploy",
      ]);
      expect(body.domain).toEqual({
        hostname: "hris-staging.example.net",
        remoteTunnelId: "rt-1",
        tunnelName: "dss-srv-113",
        accessPolicyId: "pol-1",
        policyName: "DSS staff",
      });
    });

    it("GET falls back to the policy id when Cloudflare fails", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      cloudflare.listAccessPolicies.mockRejectedValue(new Error("outage"));
      repo.loadProvisioningConfig.mockResolvedValue({
        ...goodConfig,
        domain: tunnelDomain,
      });
      const res = await app.request(`/api/environments/${ENV_ID}/provisioning`);
      expect(res.status).toBe(200);
      expect((await res.json()).domain.policyName).toBeNull();
      errors.mockRestore();
    });

    it("GET has no domain block for an external binding", async () => {
      repo.loadProvisioningConfig.mockResolvedValue({
        ...goodConfig,
        domain: {
          ...tunnelDomain,
          kind: "external",
          zoneId: null,
          remoteTunnelId: null,
        },
      });
      const body = await get();
      expect(body.domain).toBeNull();
      expect(cloudflare.listAccessPolicies).not.toHaveBeenCalled();
    });

    it("GET shows the panel of a deployed environment until the domain is provisioned", async () => {
      repo.hasSuccessfulDeployment.mockResolvedValue(true);
      const withDomain = (domain: Record<string, unknown>) =>
        repo.loadProvisioningConfig.mockResolvedValue({
          ...goodConfig,
          domain: { ...tunnelDomain, ...domain },
        });
      withDomain({});
      expect((await get()).showPanel).toBe(true);
      withDomain({ accessAppId: "app-1" });
      expect((await get()).showPanel).toBe(true);
      withDomain({ accessAppId: "app-1", dnsRecordId: "rec-1" });
      expect((await get()).showPanel).toBe(false);
      // A public binding needs only the DNS record.
      withDomain({ accessPolicyId: null, dnsRecordId: "rec-1" });
      expect((await get()).showPanel).toBe(false);
      withDomain({
        kind: "external",
        zoneId: null,
        remoteTunnelId: null,
      });
      expect((await get()).showPanel).toBe(false);
    });

    it("POST answers 422 missing_entry_port without an entry port", async () => {
      repo.loadProvisioningConfig.mockResolvedValue({
        ...goodConfig,
        domain: { ...tunnelDomain, entryPort: null },
      });
      const res = await post();
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "missing_entry_port" });
      expect(repo.startProvisioningRun).not.toHaveBeenCalled();
    });
  });
});

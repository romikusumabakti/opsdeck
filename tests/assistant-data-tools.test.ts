import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { REDACTED_LINE } from "@/lib/assistant/secret-filter";
import { executeTool, type ToolContext } from "@/lib/assistant/tool-defs";
import {
  createDataTurn,
  type DataCores,
  DEPLOY_LOG_LINES,
  STATUS_PROBES_PER_TURN,
} from "@/lib/assistant/tools/data";
import type { AssistantViewer, ProjectEntry } from "@/lib/assistant/viewer";
import type { EnvironmentListItem } from "@/lib/db/schema";

const ACME_ID = "01900000-0000-7000-8000-000000000001";
const BETA_ID = "01900000-0000-7000-8000-000000000002";

const viewerAs = (orgRole: AssistantViewer["orgRole"]): AssistantViewer => ({
  userId: "u1",
  orgRole,
  projectIds: [ACME_ID, BETA_ID],
  canManageKnowledge: false,
  scope: {
    userId: "u1",
    orgRole,
    projectRoles: { [ACME_ID]: "engineer", [BETA_ID]: "qa" },
    seesAllProjects: false,
  },
});
const engineer = viewerAs("engineer");
const admin = viewerAs("admin");

// The viewer's visible projects (an invisible one is simply absent).
const PROJECTS: ProjectEntry[] = [
  {
    id: ACME_ID,
    key: "ACME",
    name: "Acme Membership",
    group: null,
    description: null,
  },
  { id: BETA_ID, key: "BETA", name: "Beta", group: null, description: null },
];

const envId = (n: number) =>
  `01900000-0000-7000-8000-${String(1000 + n).padStart(12, "0")}`;

function env(
  n: number,
  over: Partial<EnvironmentListItem> = {}
): EnvironmentListItem {
  return {
    id: envId(n),
    projectId: ACME_ID,
    name: `Env ${n}`,
    slug: `env-${n}`,
    kind: "qa",
    ownerId: null,
    url: null,
    appId: null,
    envFileManaged: false,
    entryPort: null,
    dbType: null,
    dbName: null,
    key: "ACME",
    hasMailpit: false,
    serviceRoles: ["backend", "db"],
    projectReleasable: false,
    lastAccessedAt: null,
    ...over,
  } as EnvironmentListItem;
}

type Fakes = { [K in keyof DataCores]: ReturnType<typeof vi.fn> };

function fakeCores(envs: EnvironmentListItem[]): Fakes {
  return {
    listEnvironments: vi.fn(async () => envs),
    getEnvironmentRunning: vi.fn(async () => ({ items: [] })),
    getServiceStatuses: vi.fn(async () => [
      { role: "backend", state: "running", raw: "Up 3 days" },
    ]),
    getDeployLockState: vi.fn(async () => ({ lock: null, heldCount: 0 })),
    getServiceLogs: vi.fn(async () => ({ found: true, output: "" })),
    getEnvironmentKpis: vi.fn(async () => ({
      lastBackup: null,
      lastRestore: null,
      lastMock: null,
      totalRuns7d: 0,
      successRate7d: null,
      prevTotalRuns7d: 0,
      dailyRuns: [0, 0, 0, 0, 0, 0, 0],
    })),
    listDeployTargets: vi.fn(async () => []),
    getDeployment: vi.fn(),
    getRunSnapshot: vi.fn(async () => null),
    listProjectBuilds: vi.fn(async () => []),
    listIssues: vi.fn(async () => ({ rows: [], total: 0 })),
    getIssueDetail: vi.fn(async () => null),
    listPeople: vi.fn(async () => []),
    getServers: vi.fn(async () => []),
    getServer: vi.fn(async () => undefined),
    listActivity: vi.fn(async () => []),
    countIssuesByProject: vi.fn(async () => []),
    countActivitySince: vi.fn(async () => 0),
    resolveEnvironmentSlug: vi.fn(async () => null),
    ownerNames: vi.fn(async () => new Map()),
    listLabels: vi.fn(async () => []),
    listMilestones: vi.fn(async () => []),
  };
}

function contextFor(
  viewer: AssistantViewer,
  cores: Fakes,
  mode: "auto" | "pinned" = "auto",
  probeTimeoutMs?: number
): ToolContext {
  const data = createDataTurn(viewer, {
    projects: async () => PROJECTS,
    cores: cores as unknown as DataCores,
    probeTimeoutMs,
  });
  const base = {
    viewer,
    attachments: [],
    uploads: [],
    nativeFiles: true,
    data,
  };
  return mode === "auto"
    ? {
        ...base,
        mode,
        snapshotsFor: async () => ({ error: "unknown_project" }) as const,
        listProjects: async () => [],
      }
    : { ...base, mode, snaps: [] };
}

describe("list_environments", () => {
  it("lists what the environments core returns for the viewer's scope, compactly", async () => {
    const cores = fakeCores([
      env(2, {
        name: "UAT",
        slug: "uat",
        kind: "release",
        url: "https://uat.example.invalid",
        ownerId: "owner-1",
      }),
      env(1, { name: "Dev", slug: "dev", kind: null }),
      env(3, { projectId: BETA_ID, key: "BETA", name: "QA", slug: "qa" }),
    ]);
    cores.ownerNames.mockResolvedValue(new Map([["owner-1", "Budi"]]));
    const result = await executeTool(
      "list_environments",
      { project: null },
      contextFor(engineer, cores)
    );
    expect(cores.listEnvironments).toHaveBeenCalledWith(engineer.scope);
    expect(result).toEqual({
      ok: true,
      data: {
        projects: [
          { key: "ACME", name: "Acme Membership" },
          { key: "BETA", name: "Beta" },
        ],
        environments: [
          { ref: "ACME/dev", name: "Dev" },
          {
            ref: "ACME/uat",
            name: "UAT",
            kind: "release",
            url: "https://uat.example.invalid",
            owner: "Budi",
          },
          { ref: "BETA/qa", name: "QA", kind: "qa" },
        ],
      },
      meta: {},
    });
  });

  it("filters by a loosely written project key", async () => {
    const cores = fakeCores([
      env(1),
      env(2, { projectId: BETA_ID, key: "BETA" }),
    ]);
    const result = await executeTool(
      "list_environments",
      { project: " beta " },
      contextFor(engineer, cores)
    );
    expect(result).toMatchObject({
      ok: true,
      data: { environments: [{ ref: "BETA/env-2" }] },
      meta: { project: "BETA" },
    });
  });

  it("refuses an invisible project with the code tools' unknown message", async () => {
    const cores = fakeCores([env(1)]);
    const auto = await executeTool(
      "list_environments",
      { project: "secret" },
      contextFor(engineer, cores)
    );
    expect(auto).toEqual({
      ok: false,
      error: "Unknown project SECRET. Call list_projects.",
      meta: { project: "SECRET" },
    });
    // The same text the automatic code tools give an invisible project.
    const code = await executeTool(
      "list_files",
      { project: "secret", glob: "**" },
      contextFor(engineer, cores)
    );
    expect(code.ok === false && code.error).toBe(
      auto.ok === false && auto.error
    );
    // A pinned context has no list_projects to point at.
    const pinned = await executeTool(
      "list_environments",
      { project: "SECRET" },
      contextFor(engineer, cores, "pinned")
    );
    expect(pinned).toMatchObject({
      ok: false,
      error: "Unknown project SECRET. Call list_environments.",
    });
  });

  it("keeps 30 environments under 8 KB, 12 KB with one project's deploy state", async () => {
    const envs = Array.from({ length: 30 }, (_, i) =>
      env(i, {
        name: `Customer acceptance ${i}`,
        slug: `customer-acceptance-${i}`,
        kind: "release",
        url: `https://customer-acceptance-${i}.example.invalid`,
        ownerId: `owner-${i}`,
      })
    );
    const cores = fakeCores(envs);
    cores.ownerNames.mockResolvedValue(
      new Map(envs.map((_, i) => [`owner-${i}`, `Owner Number ${i}`]))
    );
    cores.listDeployTargets.mockResolvedValue([
      {
        componentKey: "acme-backend",
        recentDeployments: [
          deployEntry("d1", "2026-11-17T00:00:00Z", { tag: "v1.20.3-abc1234" }),
        ],
      },
    ]);
    cores.getDeployLockState.mockResolvedValue({
      lock: {
        lockedBy: { id: "u2", name: "Sari" },
        reason: "Customer UAT until Friday",
        expiresAt: new Date("2026-11-20T10:00:00Z"),
      },
      heldCount: 0,
    });
    for (const [project, budget] of [
      [null, 8 * 1024],
      ["ACME", 12 * 1024],
    ] as const) {
      const result = await executeTool(
        "list_environments",
        { project },
        contextFor(engineer, cores)
      );
      expect(result.ok).toBe(true);
      const size = JSON.stringify(result.ok && result.data).length;
      expect(size, String(project)).toBeLessThan(budget);
    }
  });

  it("adds each environment's last deploy and lock only for one project", async () => {
    const cores = fakeCores([
      env(1, { slug: "dev", name: "Dev" }),
      env(2, { slug: "uat", name: "UAT" }),
      env(3, { projectId: BETA_ID, key: "BETA", slug: "qa", name: "QA" }),
    ]);
    cores.listDeployTargets.mockImplementation(
      async (_scope: unknown, id: string) =>
        id === envId(1)
          ? [
              {
                componentKey: "backend",
                recentDeployments: [
                  deployEntry("d1", "2026-11-10T00:00:00Z", { tag: "v1" }),
                ],
              },
              {
                componentKey: "frontend",
                recentDeployments: [
                  deployEntry("d2", "2026-11-12T00:00:00Z", {
                    tag: "v2",
                    status: "failed",
                  }),
                ],
              },
            ]
          : []
    );
    cores.getDeployLockState.mockImplementation(
      async (_scope: unknown, id: string) => ({
        lock:
          id === envId(2)
            ? {
                lockedBy: null,
                reason: "UAT in progress",
                expiresAt: new Date("2026-11-20T00:00:00Z"),
              }
            : null,
        heldCount: 0,
      })
    );
    const ctx = contextFor(engineer, cores);
    const result = await executeTool(
      "list_environments",
      { project: "acme" },
      ctx
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        environments: [
          {
            ref: "ACME/dev",
            lastDeploy: {
              status: "failed",
              at: "2026-11-12T00:00:00Z",
              tag: "v2",
            },
            lock: { locked: false },
          },
          {
            ref: "ACME/uat",
            lock: { locked: true, reason: "UAT in progress" },
          },
        ],
      },
    });
    const envs = (result as { data: { environments: object[] } }).data
      .environments;
    expect(envs[1]).not.toHaveProperty("lastDeploy");
    // Only that project's environments, with the viewer's scope.
    expect(cores.listDeployTargets).toHaveBeenCalledTimes(2);
    expect(cores.getDeployLockState).toHaveBeenCalledWith(
      engineer.scope,
      envId(2)
    );
    expect(cores.listDeployTargets).not.toHaveBeenCalledWith(
      engineer.scope,
      envId(3)
    );

    cores.listDeployTargets.mockClear();
    cores.getDeployLockState.mockClear();
    const all = await executeTool("list_environments", { project: null }, ctx);
    expect(cores.listDeployTargets).not.toHaveBeenCalled();
    expect(cores.getDeployLockState).not.toHaveBeenCalled();
    for (const e of (all as { data: { environments: object[] } }).data
      .environments) {
      expect(e).not.toHaveProperty("lastDeploy");
      expect(e).not.toHaveProperty("lock");
    }
  });
});

describe("get_environment_status", () => {
  it("probes at most 10 distinct environments per turn and memoises them", async () => {
    const envs = Array.from({ length: 15 }, (_, i) => env(i));
    const cores = fakeCores(envs);
    const ctx = contextFor(engineer, cores);
    const results = [];
    for (const e of envs) {
      results.push(
        await executeTool(
          "get_environment_status",
          { environment: `ACME/${e.slug}` },
          ctx
        )
      );
    }
    // Asking again for a checked one costs no new probe.
    const again = await executeTool(
      "get_environment_status",
      { environment: "acme/ENV-0" },
      ctx
    );
    expect(cores.getServiceStatuses).toHaveBeenCalledTimes(
      STATUS_PROBES_PER_TURN
    );
    expect(cores.getServiceStatuses).toHaveBeenCalledWith(
      engineer.scope,
      envId(0)
    );
    const checked = results.filter(
      (r) => r.ok && (r.data as { checked: boolean }).checked
    );
    const notChecked = results.filter(
      (r) => r.ok && !(r.data as { checked: boolean }).checked
    );
    expect(checked).toHaveLength(10);
    expect(notChecked).toHaveLength(5);
    expect(notChecked[0]).toMatchObject({
      ok: true,
      data: { environment: "ACME/env-10", checked: false, reason: "limit" },
      meta: { project: "ACME", environment: "ACME/env-10", checked: false },
    });
    expect(again).toMatchObject({
      ok: true,
      data: {
        checked: true,
        services: [{ role: "backend", state: "running" }],
      },
    });
  });

  it("keeps an empty services list when the environment has no services to check", async () => {
    const cores = fakeCores([env(1)]);
    cores.getServiceStatuses.mockResolvedValue([]);
    const result = await executeTool(
      "get_environment_status",
      { environment: "ACME/env-1" },
      contextFor(engineer, cores)
    );
    expect(result).toMatchObject({
      ok: true,
      data: { checked: true, services: [] },
    });
  });

  it("reports every service unknown when a probe times out or fails", async () => {
    const cores = fakeCores([env(1), env(2)]);
    cores.getServiceStatuses.mockImplementation(
      async (_scope: unknown, id: string) =>
        id === envId(1)
          ? new Promise(() => {}) // never answers
          : Promise.reject(new Error("SSH command timed out after 10000ms"))
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = contextFor(engineer, cores, "auto", 20);
    for (const environment of ["ACME/env-1", envId(2)]) {
      expect(
        await executeTool("get_environment_status", { environment }, ctx),
        environment
      ).toMatchObject({
        ok: true,
        data: {
          checked: true,
          services: [
            { role: "backend", state: "unknown" },
            { role: "db", state: "unknown" },
          ],
        },
      });
    }
    spy.mockRestore();
  });

  it("adds the last backup, restore and mock-time runs from the dashboard KPIs", async () => {
    const cores = fakeCores([env(1)]);
    cores.getEnvironmentKpis.mockResolvedValue({
      lastBackup: {
        runAt: new Date("2026-11-17T01:00:00Z"),
        status: "success",
      },
      lastRestore: null,
      lastMock: { runAt: new Date("2026-11-16T02:00:00Z"), status: "failed" },
      totalRuns7d: 3,
      successRate7d: 66,
      prevTotalRuns7d: 1,
      dailyRuns: [0, 0, 0, 1, 1, 1, 0],
    });
    const result = await executeTool(
      "get_environment_status",
      { environment: "ACME/env-1" },
      contextFor(engineer, cores)
    );
    expect(cores.getEnvironmentKpis).toHaveBeenCalledWith(
      engineer.scope,
      envId(1)
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        lastBackup: { at: "2026-11-17T01:00:00Z", status: "success" },
        lastMockTime: { at: "2026-11-16T02:00:00Z", status: "failed" },
      },
    });
    expect(result.ok && result.data).not.toHaveProperty("lastRestore");
  });

  it("passes a probe's error text through the secret filter, capped", async () => {
    const cores = fakeCores([env(1)]);
    cores.getServiceStatuses.mockResolvedValue([
      {
        role: "backend",
        state: "unknown",
        raw: "",
        error: `password=hunter2 ${"x".repeat(1000)}`,
      },
      { role: "db", state: "unknown", raw: "", error: "y".repeat(1000) },
    ]);
    const result = await executeTool(
      "get_environment_status",
      { environment: "ACME/env-1" },
      contextFor(engineer, cores)
    );
    const services = (
      result as { data: { services: Array<{ error: string }> } }
    ).data.services;
    expect(services[0]?.error).toBe(REDACTED_LINE);
    expect(services[1]?.error.length).toBeLessThan(250);
  });

  it("adds running versions and an active lock from their cores", async () => {
    const cores = fakeCores([env(1)]);
    cores.getEnvironmentRunning.mockResolvedValue({
      items: [
        {
          componentKey: "acme-backend",
          repoFullName: "acme/backend",
          commitSha: "0123456789abcdef",
          tag: "v1.2.3",
          ref: "0123456789abcdef",
          deployed: true,
          deployedAt: "2026-11-17T10:00:00.000Z",
        },
      ],
    });
    cores.getDeployLockState.mockResolvedValue({
      lock: {
        lockedBy: { id: "u2", name: "Sari" },
        reason: "UAT in progress",
        expiresAt: new Date("2026-11-18T10:00:00Z"),
      },
      heldCount: 2,
    });
    const result = await executeTool(
      "get_environment_status",
      { environment: "ACME/env-1" },
      contextFor(engineer, cores)
    );
    expect(cores.getEnvironmentRunning).toHaveBeenCalledWith(
      engineer.scope,
      envId(1)
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        running: [
          {
            component: "acme-backend",
            tag: "v1.2.3",
            commit: "0123456789",
            deployed: true,
            deployedAt: "2026-11-17T10:00:00Z",
          },
        ],
        lock: {
          by: "Sari",
          reason: "UAT in progress",
          expiresAt: "2026-11-18T10:00:00Z",
        },
        heldDeploys: 2,
      },
    });
  });

  it("answers an unknown or invisible environment the same way, without probing", async () => {
    const cores = fakeCores([env(1)]);
    const ctx = contextFor(engineer, cores);
    for (const environment of ["ACME/nope", "SECRET/env-1", envId(99), "x"]) {
      expect(
        await executeTool("get_environment_status", { environment }, ctx)
      ).toEqual({
        ok: false,
        error: `Unknown environment ${environment}. Call list_environments.`,
        meta: {},
      });
    }
    // A refusal from the core reads the same.
    cores.getEnvironmentRunning.mockRejectedValue(new HTTPException(404));
    expect(
      await executeTool(
        "get_environment_status",
        { environment: "ACME/env-1" },
        ctx
      )
    ).toMatchObject({
      ok: false,
      error: "Unknown environment ACME/env-1. Call list_environments.",
    });
    expect(cores.getServiceStatuses).toHaveBeenCalledTimes(1);
  });

  it("follows an old slug of a renamed environment, only to a visible one", async () => {
    const cores = fakeCores([env(1)]);
    const ctx = contextFor(engineer, cores);
    cores.resolveEnvironmentSlug.mockImplementation(
      async (_projectId: string, slug: string) =>
        slug === "old-qa"
          ? { environment: { id: envId(1) }, canonicalSlug: "env-1" }
          : slug === "gone"
            ? { environment: { id: envId(99) }, canonicalSlug: "x" }
            : null
    );
    const result = await executeTool(
      "get_environment_status",
      { environment: "acme/OLD-QA" },
      ctx
    );
    expect(cores.resolveEnvironmentSlug).toHaveBeenCalledWith(
      ACME_ID,
      "old-qa"
    );
    expect(result).toMatchObject({
      ok: true,
      meta: { environment: "ACME/env-1" },
    });
    // An alias of an environment the viewer can't see reads as unknown.
    expect(
      await executeTool(
        "get_environment_status",
        { environment: "ACME/gone" },
        ctx
      )
    ).toMatchObject({ ok: false });
  });
});

const deployEntry = (id: string, createdAt: string, over = {}) => ({
  id,
  targetId: "t1",
  environmentId: envId(1),
  runId: "01900000-0000-7000-8000-00000000aaaa",
  tag: "v1",
  trigger: "manual",
  status: "success",
  buildId: null,
  createdAt: new Date(createdAt),
  startedAt: new Date(createdAt),
  heartbeatAt: null,
  scriptStartedAt: null,
  finishedAt: new Date(new Date(createdAt).getTime() + 90_000),
  userName: "Budi",
  triggeredBy: null,
  autoUser: null,
  build: { branch: "main", commitSha: "abcdef0123456789" },
  ...over,
});

describe("list_deploys and get_deploy", () => {
  it("flattens the Deploys page's history newest first, at most 20", async () => {
    const cores = fakeCores([env(1)]);
    cores.listDeployTargets.mockResolvedValue([
      {
        componentKey: "backend",
        sourceBranch: "main",
        autoDeploy: true,
        currentTag: "v2",
        currentStatus: "success",
        previousTag: "v1",
        recentDeployments: Array.from({ length: 15 }, (_, i) =>
          deployEntry(
            `b${i}`,
            `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z`
          )
        ),
      },
      {
        componentKey: "frontend",
        sourceBranch: "main",
        autoDeploy: false,
        currentTag: null,
        currentStatus: null,
        previousTag: null,
        recentDeployments: Array.from({ length: 15 }, (_, i) =>
          deployEntry(
            `f${i}`,
            `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`
          )
        ),
      },
    ]);
    const result = await executeTool(
      "list_deploys",
      { environment: "ACME/env-1", limit: 500 },
      contextFor(engineer, cores)
    );
    expect(cores.listDeployTargets).toHaveBeenCalledWith(
      engineer.scope,
      envId(1)
    );
    if (!result.ok) throw new Error(result.error);
    const data = result.data as {
      components: unknown[];
      deploys: Array<Record<string, unknown>>;
    };
    expect(data.deploys).toHaveLength(20);
    expect(data.deploys[0]).toEqual({
      id: "b14",
      component: "backend",
      tag: "v1",
      status: "success",
      trigger: "manual",
      by: "Budi",
      at: "2026-11-15T00:00:00Z",
      durationSeconds: 90,
      branch: "main",
      commit: "abcdef0123",
    });
    expect(data.deploys.at(-1)?.id).toBe("f10");
    expect(data.components).toEqual([
      {
        component: "backend",
        branch: "main",
        currentTag: "v2",
        currentStatus: "success",
        previousTag: "v1",
        autoDeploy: true,
      },
      { component: "frontend", branch: "main" },
    ]);
    expect(result.meta).toEqual({
      project: "ACME",
      environment: "ACME/env-1",
    });
  });

  it("reads any deploy the core lets the viewer see, with a redacted log tail", async () => {
    const cores = fakeCores([env(1)]);
    cores.getDeployment.mockResolvedValue({
      ...deployEntry(
        "01900000-0000-7000-8000-00000000d001",
        "2026-01-01T00:00:00Z",
        {
          status: "failed",
        }
      ),
      componentKey: "backend",
    });
    const lines = Array.from({ length: 300 }, (_, i) => `step ${i}`);
    lines[290] = "DB_PASSWORD=hunter2-very-secret";
    lines[50] = "early line that falls off the tail";
    cores.getRunSnapshot.mockResolvedValue({
      id: "r",
      environmentId: envId(1),
      description: "deploy",
      status: "failed",
      output: `${lines.join("\n")}\n`,
      errorMessage: "health check failed",
      runAt: new Date(),
      completedAt: new Date(),
    });
    const result = await executeTool(
      "get_deploy",
      { id: " 01900000-0000-7000-8000-00000000d001 " },
      contextFor(engineer, cores)
    );
    expect(cores.getDeployment).toHaveBeenCalledWith(
      engineer.scope,
      "01900000-0000-7000-8000-00000000d001"
    );
    if (!result.ok) throw new Error(result.error);
    const data = result.data as Record<string, unknown>;
    const log = String(data.log).split("\n");
    expect(log).toHaveLength(DEPLOY_LOG_LINES);
    expect(log[0]).toBe("step 100");
    expect(log).toContain(REDACTED_LINE);
    expect(String(data.log)).not.toContain("hunter2");
    expect(data).toMatchObject({
      status: "failed",
      component: "backend",
      environment: "ACME/env-1",
      error: "health check failed",
      logTruncated: true,
    });
    expect(data).not.toHaveProperty("logWithheld");
    expect(result.meta).toEqual({
      project: "ACME",
      environment: "ACME/env-1",
      withheld: 1,
    });
  });

  it("withholds the log when the run is not readable, and hides unknown deploys", async () => {
    const cores = fakeCores([env(1)]);
    cores.getDeployment.mockResolvedValue({
      ...deployEntry(
        "01900000-0000-7000-8000-00000000d002",
        "2026-01-01T00:00:00Z"
      ),
      componentKey: "backend",
    });
    const ctx = contextFor(engineer, cores);
    const result = await executeTool(
      "get_deploy",
      { id: "01900000-0000-7000-8000-00000000d002" },
      ctx
    );
    expect(result).toMatchObject({ ok: true, data: { logWithheld: true } });
    expect(result.ok && result.data).not.toHaveProperty("log");

    cores.getDeployment.mockRejectedValue(new HTTPException(404));
    expect(await executeTool("get_deploy", { id: "nope" }, ctx)).toEqual({
      ok: false,
      error: "Unknown deploy nope.",
      meta: {},
    });
  });
});

describe("builds, issues and people", () => {
  it("lists a visible project's builds with a clamped limit", async () => {
    const cores = fakeCores([]);
    cores.listProjectBuilds.mockResolvedValue([
      {
        id: "b1",
        componentKey: "backend",
        branch: "main",
        tag: "v9",
        commitSha: "fedcba9876543210",
        pipelineUrl: "https://ci.example.invalid/1",
        pushedBy: "budi",
        commitAuthorEmail: null,
        commitMessage: "fix: iuran rounding",
        receivedAt: new Date("2026-11-17T01:02:03Z"),
      },
    ]);
    const ctx = contextFor(engineer, cores);
    const result = await executeTool(
      "list_builds",
      { project: "acme", limit: 99 },
      ctx
    );
    expect(cores.listProjectBuilds).toHaveBeenCalledWith(
      engineer.scope,
      ACME_ID,
      20
    );
    expect(result).toEqual({
      ok: true,
      data: {
        project: "ACME",
        builds: [
          {
            component: "backend",
            branch: "main",
            tag: "v9",
            commit: "fedcba9876",
            at: "2026-11-17T01:02:03Z",
            by: "budi",
            message: "fix: iuran rounding",
          },
        ],
      },
      meta: { project: "ACME" },
    });
    await executeTool("list_builds", { project: "ACME", limit: null }, ctx);
    expect(cores.listProjectBuilds).toHaveBeenLastCalledWith(
      engineer.scope,
      ACME_ID,
      10
    );
    expect(
      await executeTool("list_builds", { project: "SECRET", limit: null }, ctx)
    ).toMatchObject({
      ok: false,
      error: "Unknown project SECRET. Call list_projects.",
    });
    expect(cores.listProjectBuilds).toHaveBeenCalledTimes(2);
  });

  it("lists people as the People page shows them, with what they like to be called", async () => {
    const cores = fakeCores([]);
    cores.listPeople.mockResolvedValue([
      {
        id: "p1",
        name: "Budi Santoso",
        preferredName: "Budi",
        email: "budi@example.invalid",
        image: null,
        title: "QA",
        role: "qa",
        timeZone: "Asia/Jakarta",
        workingHours: null,
        status: null,
        lastActiveAt: null,
        projectIds: [ACME_ID, "invisible-project"],
        deactivated: false,
      },
      {
        id: "p2",
        name: "Sari",
        preferredName: null,
        email: "sari@example.invalid",
        image: null,
        title: null,
        role: "engineer",
        timeZone: "Asia/Jakarta",
        workingHours: null,
        status: null,
        lastActiveAt: null,
        projectIds: [],
        deactivated: true,
      },
    ]);
    const ctx = contextFor(engineer, cores);
    const result = await executeTool("list_people", { project: "acme" }, ctx);
    expect(cores.listPeople).toHaveBeenCalledWith(engineer.scope, ACME_ID);
    expect(result).toEqual({
      ok: true,
      data: {
        people: [
          {
            name: "Budi Santoso",
            callName: "Budi",
            email: "budi@example.invalid",
            title: "QA",
            role: "qa",
            projects: ["ACME"],
          },
          {
            name: "Sari",
            email: "sari@example.invalid",
            role: "engineer",
            deactivated: true,
          },
        ],
      },
      meta: { project: "ACME" },
    });
    await executeTool("list_people", { project: null }, ctx);
    expect(cores.listPeople).toHaveBeenLastCalledWith(
      engineer.scope,
      undefined
    );
  });
});

describe("list_people query", () => {
  const person = (
    id: string,
    name: string,
    over: Record<string, unknown> = {}
  ) => ({
    id,
    name,
    preferredName: null,
    email: `${id}@x.id`,
    image: null,
    title: null,
    role: "qa",
    timeZone: "Asia/Jakarta",
    workingHours: null,
    status: null,
    lastActiveAt: null,
    projectIds: [],
    deactivated: false,
    ...over,
  });

  it("list_people matches name, email and title, case- and accent-insensitively", async () => {
    const cores = fakeCores([]);
    cores.listPeople.mockResolvedValue([
      person("wulan", "Wulan Anggraeni", { title: "QA Lead" }),
      person("jose", "José Ramos", { email: "jose@x" }),
      person("andi", "Andi", { title: "Business Analyst" }),
    ]);
    const ctx = contextFor(engineer, cores);
    const names = async (query: string) => {
      const result = await executeTool(
        "list_people",
        { project: null, query },
        ctx
      );
      if (!result.ok) throw new Error(result.error);
      return (result.data as { people: { name: string }[] }).people.map(
        (p) => p.name
      );
    };
    expect(await names("wulan")).toEqual(["Wulan Anggraeni"]);
    expect(await names("jose")).toEqual(["José Ramos"]);
    expect(await names("ANALYST")).toEqual(["Andi"]);
    // An accented query folds to its base letter, so it finds the plain "e"
    // in every title and name too.
    expect(await names("é")).toEqual(["Wulan Anggraeni", "José Ramos", "Andi"]);
    // And an unaccented query finds the accented name.
    expect(await names("jos")).toEqual(["José Ramos"]);
  });
});

describe("get_overview", () => {
  const NOW = new Date("2026-11-20T05:00:00Z");
  const group = (
    projectId: string,
    status: "open" | "in_progress",
    count: number,
    updatedSince: number,
    lastUpdatedAt: Date
  ) => ({ projectId, status, count, updatedSince, lastUpdatedAt });

  const overview = async (
    viewer: AssistantViewer,
    cores: Fakes,
    projects: ProjectEntry[] = PROJECTS
  ) => {
    const data = createDataTurn(viewer, {
      projects: async () => projects,
      cores: cores as unknown as DataCores,
    });
    const result = await executeTool(
      "get_overview",
      {},
      {
        ...contextFor(viewer, cores),
        data,
      }
    );
    if (!result.ok) throw new Error(result.error);
    return result.data as Record<string, unknown> & {
      projects: Array<Record<string, unknown>>;
    };
  };

  it("get_overview reads only the viewer's projects and never probes", async () => {
    const cores = fakeCores([
      env(1),
      env(2, { projectId: BETA_ID, key: "BETA", slug: "qa" }),
    ]);
    const result = await overview(engineer, cores);
    expect(cores.getServiceStatuses).not.toHaveBeenCalled();
    expect(cores.countIssuesByProject).toHaveBeenCalledTimes(1);
    expect(cores.countIssuesByProject.mock.calls[0]?.[0]).toBe(engineer.scope);
    expect(cores.listDeployTargets).toHaveBeenCalledTimes(2);
    expect(result.projects.map((p) => p.key)).toEqual(["ACME", "BETA"]);
    // An environment of a project outside the viewer's list is never shown.
    const stray = fakeCores([
      env(1, {
        projectId: "01900000-0000-7000-8000-0000000000ff",
        key: "HIDE",
      }),
    ]);
    const hidden = await overview(engineer, stray);
    expect(JSON.stringify(hidden)).not.toContain("HIDE");
    expect(stray.listDeployTargets).not.toHaveBeenCalled();
  });

  it("get_overview caps projects at 10 with more", async () => {
    const many: ProjectEntry[] = Array.from({ length: 12 }, (_, n) => ({
      id: `01900000-0000-7000-8000-${String(5000 + n).padStart(12, "0")}`,
      key: `P${String(n).padStart(2, "0")}`,
      name: `Project ${n}`,
      group: null,
      description: null,
    }));
    const result = await overview(admin, fakeCores([]), many);
    expect(result.projects).toHaveLength(10);
    expect(result.more).toBe(2);
    expect(result.projects[0]?.key).toBe("P00");
  });

  it("get_overview reports open and in_progress counts and updatedToday", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const cores = fakeCores([env(1)]);
      cores.countIssuesByProject.mockResolvedValue([
        group(ACME_ID, "open", 4, 1, new Date("2026-11-20T01:00:00Z")),
        group(ACME_ID, "in_progress", 2, 2, new Date("2026-11-19T01:00:00Z")),
        group(BETA_ID, "open", 1, 0, new Date("2026-11-21T01:00:00Z")),
      ]);
      cores.listDeployTargets.mockResolvedValue([
        {
          recentDeployments: [
            {
              id: "d1",
              status: "failed",
              tag: "v1",
              createdAt: new Date("2026-11-20T02:00:00Z"),
            },
          ],
        },
      ]);
      const result = await overview(engineer, cores);
      // Asia/Jakarta midnight of 2026-11-20 is 2026-11-19T17:00Z.
      expect(cores.countIssuesByProject.mock.calls[0]?.[1]).toEqual(
        new Date("2026-11-19T17:00:00Z")
      );
      // BETA was updated last, so it ranks first.
      expect(result.projects.map((p) => p.key)).toEqual(["BETA", "ACME"]);
      expect(result.projects[1]).toEqual({
        key: "ACME",
        name: "Acme Membership",
        environments: [
          {
            ref: "ACME/env-1",
            name: "Env 1",
            lastDeploy: {
              status: "failed",
              tag: "v1",
              at: "2026-11-20T02:00:00Z",
            },
            deploying: false,
            failed: true,
          },
        ],
        issues: { open: 4, in_progress: 2, updatedToday: 3 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("get_overview adds activityToday only for audit:read", async () => {
    const cores = fakeCores([]);
    cores.countActivitySince.mockResolvedValue(7);
    expect((await overview(admin, cores)).activityToday).toBe(7);
    expect(cores.countActivitySince.mock.calls[0]?.[0]).toBe(admin.scope);
    const qaCores = fakeCores([]);
    const qa = viewerAs("qa");
    expect(await overview(qa, qaCores)).not.toHaveProperty("activityToday");
    expect(qaCores.countActivitySince).not.toHaveBeenCalled();
  });
});

describe("servers and activity", () => {
  it("lists and reads servers through the Servers cores, without credentials", async () => {
    const cores = fakeCores([]);
    const server = {
      id: "s1",
      name: "web-1",
      host: "192.0.2.10",
      username: "deploy",
      auth: "key",
      sftpRoot: "/",
      placement: "restricted",
      infraOnly: false,
      preflight: {
        runtime: { docker: "27.1", compose: "2.29", podman: null },
        registry: null,
        disk: [
          { mount: "/", freeBytes: 10 * 1024 ** 3, totalBytes: 40 * 1024 ** 3 },
        ],
        cloudflared: { systemd: false, containers: [] },
        listeningPorts: [22, 443],
        publishedPorts: [],
        postgresCandidates: [],
      },
      preflightAt: new Date("2026-11-01T00:00:00Z"),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    cores.getServers.mockResolvedValue([server]);
    cores.getServer.mockResolvedValue(server);
    const ctx = contextFor(admin, cores);
    expect(await executeTool("list_servers", {}, ctx)).toEqual({
      ok: true,
      data: {
        servers: [
          { name: "web-1", host: "192.0.2.10", placement: "restricted" },
        ],
      },
      meta: {},
    });
    expect(cores.getServers).toHaveBeenCalledWith(admin.scope);
    expect(await executeTool("get_server", { server: "WEB-1" }, ctx)).toEqual({
      ok: true,
      data: {
        name: "web-1",
        host: "192.0.2.10",
        username: "deploy",
        auth: "key",
        placement: "restricted",
        scannedAt: "2026-11-01T00:00:00Z",
        runtime: { docker: "27.1", compose: "2.29" },
        disk: [{ mount: "/", freeGiB: 10, totalGiB: 40 }],
      },
      meta: {},
    });
    expect(cores.getServer).toHaveBeenCalledWith(admin.scope, "WEB-1");
    cores.getServer.mockResolvedValue(undefined);
    expect(await executeTool("get_server", { server: "db-9" }, ctx)).toEqual({
      ok: false,
      error: "Unknown server db-9. Call list_servers.",
      meta: {},
    });
  });

  it("reads the activity log with the limit capped at 50", async () => {
    const cores = fakeCores([]);
    cores.listActivity.mockResolvedValue([
      {
        id: "a1",
        action: "deploy.requested",
        data: {
          tag: "v1",
          note: "token=abcdefghijklmnopqrstuvwxyz0123456789",
          nested: { password: "hunter2", list: "z".repeat(1000) },
        },
        actorId: "u1",
        actorName: "Budi",
        actorImage: null,
        createdAt: new Date("2026-11-18T01:00:00Z"),
      },
    ]);
    const ctx = contextFor(admin, cores);
    const result = await executeTool("recent_activity", { limit: 1000 }, ctx);
    expect(cores.listActivity).toHaveBeenCalledWith(admin.scope, 50);
    expect(result).toMatchObject({
      ok: true,
      data: {
        entries: [
          {
            action: "deploy.requested",
            by: "Budi",
            at: "2026-11-18T01:00:00Z",
            details: { tag: "v1" },
          },
        ],
      },
    });
    const details = (
      result as {
        data: { entries: Array<{ details: Record<string, unknown> }> };
      }
    ).data.entries[0]?.details;
    expect(String(details?.note)).not.toContain("abcdefghijklmnop");
    // Nested values: JSON text, filtered and capped like the rest.
    expect(typeof details?.nested).toBe("string");
    expect(String(details?.nested).length).toBeLessThan(250);
    expect(String(details?.nested)).not.toContain("hunter2");
    await executeTool("recent_activity", { limit: null }, ctx);
    expect(cores.listActivity).toHaveBeenLastCalledWith(admin.scope, 20);
  });

  it("does not run gated tools for a viewer without the page", async () => {
    const cores = fakeCores([]);
    const ctx = contextFor(viewerAs("qa"), cores);
    expect(await executeTool("list_servers", {}, ctx)).toMatchObject({
      ok: false,
      error: "unknown tool: list_servers",
    });
    expect(
      await executeTool(
        "recent_activity",
        { limit: null },
        contextFor(engineer, cores)
      )
    ).toMatchObject({ ok: false, error: "unknown tool: recent_activity" });
    expect(cores.getServers).not.toHaveBeenCalled();
    expect(cores.listActivity).not.toHaveBeenCalled();
  });
});

import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessScope } from "@/lib/access-scope";
import { REDACTED_LINE } from "@/lib/assistant/secret-filter";
import { executeTool, type ToolContext } from "@/lib/assistant/tool-defs";
import {
  createPanelTurn,
  MAX_SERVICE_LOG_BYTES,
  type PanelCores,
  parseLogSince,
  SERVICE_LOG_LINES,
} from "@/lib/assistant/tools/panel";
import type { AssistantViewer, ProjectEntry } from "@/lib/assistant/viewer";
import type { EnvironmentListItem } from "@/lib/db/schema";

const PROJECT_ID = "01900000-0000-7000-8000-000000000001";
const ENV_ID = "01900000-0000-7000-8000-000000001001";

const dbRows = vi.hoisted(() => ({ projectId: null as string | null }));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            dbRows.projectId ? [{ projectId: dbRows.projectId }] : [],
        }),
      }),
    }),
  },
}));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

const state = vi.hoisted(() => ({ dbKind: "dedicated" as string | null }));
const server = { id: "s1", host: "10.0.0.5", username: "ops", password: "pw" };
vi.mock("@/lib/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/environments")>()),
  loadEnvironmentWithServers: async (id: string) => ({
    id,
    projectId: PROJECT_ID,
    services: [
      {
        role: "db",
        server,
        serviceType: "docker",
        serviceName: "acme-postgres",
        dbKind: state.dbKind,
      },
      {
        role: "backend",
        server,
        serviceType: "docker",
        serviceName: "acme-api",
      },
    ],
  }),
}));

const ssh = vi.hoisted(() => ({
  executeRemoteCommand: vi.fn(),
  streamRemoteCommand: vi.fn(),
}));
vi.mock("@/lib/ssh", () => ssh);

const { getServiceLogsFor } = await import("@/server/services/services");

const scopeOf = (
  orgRole: AccessScope["orgRole"],
  projectRoles: AccessScope["projectRoles"]
): AccessScope => ({
  userId: "u1",
  orgRole,
  projectRoles,
  seesAllProjects: orgRole === "admin",
});

beforeEach(() => {
  vi.clearAllMocks();
  dbRows.projectId = PROJECT_ID;
  state.dbKind = "dedicated";
  ssh.executeRemoteCommand.mockResolvedValue("line one\nline two\n");
});

describe("getServiceLogsFor", () => {
  it("lets QA with service:logs read a non-follow tail", async () => {
    const scope = scopeOf("qa", { [PROJECT_ID]: "qa" });
    const result = await getServiceLogsFor(scope, ENV_ID, "backend", {
      lines: 50,
      sinceSeconds: 1800,
    });
    expect(result).toEqual({ found: true, output: "line one\nline two\n" });
    const command = ssh.executeRemoteCommand.mock.calls[0]?.[1] as string;
    expect(command).toContain("docker logs --tail 50 --timestamps --since");
    expect(command).toContain("1800s");
    expect(command).not.toContain("--follow");
  });

  it("refuses staff, who see no project", async () => {
    const scope = scopeOf("staff", {});
    await expect(
      getServiceLogsFor(scope, ENV_ID, "backend", { lines: 10 })
    ).rejects.toMatchObject({ status: 404 });
    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
  });

  it("refuses a shared database container, even to an admin (never the strong-only override)", async () => {
    state.dbKind = "shared";
    const scope = scopeOf("engineer", { [PROJECT_ID]: "engineer" });
    await expect(
      getServiceLogsFor(scope, ENV_ID, "db", { lines: 10 })
    ).rejects.toMatchObject({ status: 403 });
    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    // The environment's own backend is fine; an admin is refused on the
    // shared db too (a scope never carries the strong-only override).
    await expect(
      getServiceLogsFor(scope, ENV_ID, "backend", { lines: 10 })
    ).resolves.toMatchObject({ found: true });
    await expect(
      getServiceLogsFor(
        scopeOf("admin", { [PROJECT_ID]: "engineer" }),
        ENV_ID,
        "db",
        {
          lines: 10,
        }
      )
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("parseLogSince", () => {
  it("takes whole durations up to seven days and nothing else", () => {
    expect(parseLogSince("30m")).toBe(1800);
    expect(parseLogSince(" 2H ")).toBe(7200);
    expect(parseLogSince("7d")).toBe(604_800);
    for (const bad of [
      "8d",
      "0m",
      "yesterday",
      "10 minutes ago",
      "5m; rm -rf /",
      "$(id)h",
      "-5m",
      "",
    ]) {
      expect(parseLogSince(bad), bad).toBeNull();
    }
  });
});

// --- the tool -------------------------------------------------------------------

const viewer: AssistantViewer = {
  userId: "u1",
  orgRole: "qa",
  projectIds: [PROJECT_ID],
  canManageKnowledge: false,
  scope: scopeOf("qa", { [PROJECT_ID]: "qa" }),
};
const PROJECTS: ProjectEntry[] = [
  {
    id: PROJECT_ID,
    key: "ACME",
    name: "Acme",
    group: null,
    description: null,
  },
];
const environment = {
  id: ENV_ID,
  projectId: PROJECT_ID,
  name: "UAT",
  slug: "uat",
  key: "ACME",
  serviceRoles: ["backend", "db"],
} as unknown as EnvironmentListItem;

function toolContext(getServiceLogs: ReturnType<typeof vi.fn>): ToolContext {
  const cores = {
    listEnvironments: async () => [environment],
    resolveEnvironmentSlug: async () => null,
    getServiceLogs,
  } as unknown as PanelCores;
  return {
    viewer,
    attachments: [],
    uploads: [],
    nativeFiles: true,
    panel: createPanelTurn(viewer, { projects: async () => PROJECTS, cores }),
    mode: "auto",
    snapshotsFor: async () => ({ error: "unknown_project" }) as const,
    listProjects: async () => [],
  };
}

const call = (
  getServiceLogs: ReturnType<typeof vi.fn>,
  input: Record<string, unknown>
) =>
  executeTool(
    "get_service_logs",
    {
      environment: "ACME/uat",
      role: "backend",
      lines: null,
      since: null,
      ...input,
    },
    toolContext(getServiceLogs)
  );

describe("get_service_logs", () => {
  it("reads the tail through the core with the viewer's scope", async () => {
    const core = vi.fn(async () => ({
      found: true,
      output: "2026-11-20T01:00:00Z started\n2026-11-20T01:00:01Z ready\n",
    }));
    const result = await call(core, { lines: 20, since: "30m" });
    expect(core).toHaveBeenCalledWith(viewer.scope, ENV_ID, "backend", {
      lines: 20,
      sinceSeconds: 1800,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        environment: "ACME/uat",
        role: "backend",
        lines: 2,
        since: "30m",
        log: "2026-11-20T01:00:00Z started\n2026-11-20T01:00:01Z ready",
      },
    });
  });

  it("caps the lines at 200 and keeps the newest", async () => {
    const output = Array.from({ length: 500 }, (_, i) => `row ${i}`).join("\n");
    const core = vi.fn(async (..._args: unknown[]) => ({
      found: true,
      output,
    }));
    const result = await call(core, { lines: 1000 });
    expect(core.mock.calls[0]?.[3]).toEqual({
      lines: SERVICE_LOG_LINES,
      sinceSeconds: undefined,
    });
    if (!result.ok) throw new Error(result.error);
    const data = result.data as { log: string; truncated: boolean };
    const rows = data.log.split("\n");
    expect(rows).toHaveLength(SERVICE_LOG_LINES);
    expect(rows.at(-1)).toBe("row 499");
    expect(data.truncated).toBe(true);
  });

  it("caps the bytes from the start and strips ANSI escapes", async () => {
    const long = `${"x".repeat(1000)}\n`.repeat(100);
    const core = vi.fn(async () => ({
      found: true,
      output: `\u001b[31mred\u001b[0m\n${long}`,
    }));
    const result = await call(core, { lines: 200 });
    if (!result.ok) throw new Error(result.error);
    const data = result.data as { log: string; truncated: boolean };
    expect(Buffer.byteLength(data.log)).toBeLessThanOrEqual(
      MAX_SERVICE_LOG_BYTES
    );
    expect(data.truncated).toBe(true);
    const small = await call(
      vi.fn(async () => ({ found: true, output: "\u001b[31mred\u001b[0m\n" })),
      {}
    );
    expect(small).toMatchObject({ ok: true, data: { log: "red" } });
  });

  it("redacts lines holding credentials", async () => {
    const core = vi.fn(async () => ({
      found: true,
      output: "ok\nDB_PASSWORD=hunter2hunter2\nstill ok\n",
    }));
    const result = await call(core, {});
    if (!result.ok) throw new Error(result.error);
    const data = result.data as { log: string };
    expect(data.log).not.toContain("hunter2");
    expect(data.log).toContain(REDACTED_LINE);
    expect(data.log).toContain("still ok");
    expect(result.meta).toMatchObject({ withheld: 1 });
  });

  it("says plainly when the Logs page is closed to the user", async () => {
    for (const status of [403, 404] as const) {
      const core = vi.fn(async () => {
        throw new HTTPException(status);
      });
      const result = await call(core, { role: "db" });
      expect(result).toMatchObject({ ok: false });
      if (result.ok) throw new Error("expected a refusal");
      expect(result.error).toContain("can't read the db logs of ACME/uat");
    }
  });

  it("does not hand an SSH error to the model", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const core = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:22 password=pw");
    });
    const result = await call(core, {});
    spy.mockRestore();
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain("could not be read");
    expect(result.error).not.toContain("10.0.0.5");
  });

  it("rejects a bad since, an unknown role and a role the environment lacks before any SSH", async () => {
    const core = vi.fn();
    expect(await call(core, { since: "10 minutes ago; id" })).toMatchObject({
      ok: false,
    });
    expect(await call(core, { role: "worker" })).toMatchObject({ ok: false });
    expect(
      await call(core, { role: "frontend" }) // not in serviceRoles
    ).toMatchObject({ ok: false });
    expect(core).not.toHaveBeenCalled();
  });
});

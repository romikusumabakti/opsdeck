import { describe, expect, it, vi } from "vitest";

// Global job roles through the real lib/authz and server/app: one role per
// user decides the rights, memberships decide which projects an engineer or
// QA sees. The database is a fake that answers by table.

const P1 = "0197f3a0-1b2c-7def-8000-0000000000a1";
const P2 = "0197f3a0-1b2c-7def-8000-0000000000a2";
const ENV1 = "0197f3a0-1b2c-7def-8000-0000000000e1";
const TARGET = "0197f3a0-1b2c-7def-8000-0000000000d1";

const state = vi.hoisted(() => ({
  role: "qa",
  memberProjectIds: [] as string[],
}));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  // A thenable over `rows`: awaited directly, or after where()/limit().
  const answer = (rows: () => unknown[]) => {
    const q: Record<string, unknown> = {};
    const self = () => Object.assign(Promise.resolve(rows()), q);
    q.where = () => self();
    q.limit = async () => rows().slice(0, 1);
    q.orderBy = async () => rows();
    return self();
  };
  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === schema.projects) {
            return answer(() => [{ id: P1 }, { id: P2 }]);
          }
          if (table === schema.projectMembers) {
            return answer(() =>
              state.memberProjectIds.map((projectId) => ({ projectId }))
            );
          }
          if (table === schema.environments) {
            return answer(() => [{ projectId: P1 }]);
          }
          throw new Error("unexpected table");
        },
      }),
    },
    pgClient: vi.fn(),
  };
});
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({ user: { id: "u1", role: state.role } }),
  getServerSession: async () => ({ user: { id: "u1", role: state.role } }),
}));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/environments", async (o) => ({
  ...(await o<typeof import("@/lib/environments")>()),
  loadEnvironmentWithServers: async () => null,
}));
vi.mock("@/lib/deploy/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deploy/repository")>()),
  getTarget: async (id: string) =>
    id === TARGET ? { id: TARGET, environmentId: ENV1 } : null,
}));

const { app } = await import("@/server/app");

function as(role: string, ...memberProjectIds: string[]) {
  state.role = role;
  state.memberProjectIds = memberProjectIds;
}

const deploy = () =>
  app.request("/api/deploys/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: TARGET, tag: "v1.0.0" }),
  });

const control = (action: string) =>
  app.request("/api/services/control-service", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ environmentId: ENV1, role: "backend", action }),
  });

describe("global job roles through the API", () => {
  it("an engineer sees only their memberships", async () => {
    as("engineer", P1);
    const res = await app.request("/api/project-catalog/my-access");
    expect(await res.json()).toEqual({
      all: false,
      roles: { [P1]: "engineer" },
    });
  });

  it("an observer sees every project as viewer", async () => {
    as("observer");
    const res = await app.request("/api/project-catalog/my-access");
    expect(await res.json()).toEqual({
      all: true,
      roles: { [P1]: "viewer", [P2]: "viewer" },
    });
  });

  it("a QA member cannot deploy (403)", async () => {
    as("qa", P1);
    expect((await deploy()).status).toBe(403);
  });

  it("an engineer who is not a member gets 404 on another project's deploy", async () => {
    as("engineer", P2);
    expect((await deploy()).status).toBe(404);
  });

  it("a pm sees only their memberships, with the qa set", async () => {
    as("pm", P1);
    const res = await app.request("/api/project-catalog/my-access");
    expect(await res.json()).toEqual({ all: false, roles: { [P1]: "qa" } });
  });

  it("a pm member cannot deploy (403)", async () => {
    as("pm", P1);
    expect((await deploy()).status).toBe(403);
  });

  it("a pm member cannot start or stop a service (403)", async () => {
    as("pm", P1);
    expect((await control("start")).status).toBe(403);
    expect((await control("stop")).status).toBe(403);
  });

  it("a pm member passes the restart guard", async () => {
    as("pm", P1);
    const { status } = await control("restart");
    expect([401, 403, 404]).not.toContain(status);
  });
});

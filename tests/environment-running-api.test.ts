import { describe, expect, it, vi } from "vitest";

// GET /api/environments/:id/running: what each deploy target of the
// environment runs, for the dashboard's Running card. Through the real
// lib/authz and server/app; the database is a fake that answers by table.

const P1 = "0197f3a0-1b2c-7def-8000-0000000000a1";
const P2 = "0197f3a0-1b2c-7def-8000-0000000000a2";
const ENV1 = "0197f3a0-1b2c-7def-8000-0000000000e1";
const T_API = "0197f3a0-1b2c-7def-8000-0000000000d1";
const T_WEB = "0197f3a0-1b2c-7def-8000-0000000000d2";
const B1 = "0197f3a0-1b2c-7def-8000-0000000000b1";

const state = vi.hoisted(() => ({
  role: "engineer",
  memberProjectIds: [] as string[],
}));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  // A thenable over `rows`: awaited directly, or after join/where/orderBy.
  const answer = (rows: () => unknown[]) => {
    const q: Record<string, unknown> = {};
    const self = () => Object.assign(Promise.resolve(rows()), q);
    q.innerJoin = () => self();
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
          if (table === schema.deployTargets) {
            return answer(() => [
              {
                id: T_API,
                componentKey: "api",
                sourceBranch: "main",
                repoFullName: "acme/api",
                ciConnectionId: "ci-1",
              },
              {
                id: T_WEB,
                componentKey: "web",
                sourceBranch: "develop",
                repoFullName: "acme/web",
                ciConnectionId: "ci-1",
              },
            ]);
          }
          if (table === schema.deployments) {
            return answer(() => [
              {
                targetId: T_API,
                status: "success",
                buildId: B1,
                tag: "v1.4.0",
                createdAt: new Date("2026-11-10T08:00:00Z"),
                finishedAt: new Date("2026-11-10T08:03:00Z"),
              },
            ]);
          }
          if (table === schema.builds) {
            return answer(() => [
              {
                id: B1,
                componentKey: "api",
                tag: "v1.4.0",
                commitSha: "0123456789abcdef0123456789abcdef01234567",
                receivedAt: new Date("2026-11-10T07:50:00Z"),
              },
            ]);
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

const { app } = await import("@/server/app");

function as(role: string, ...memberProjectIds: string[]) {
  state.role = role;
  state.memberProjectIds = memberProjectIds;
}

const running = () => app.request(`/api/environments/${ENV1}/running`);

const EXPECTED = [
  {
    componentKey: "api",
    repoFullName: "acme/api",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    tag: "v1.4.0",
    ref: "0123456789abcdef0123456789abcdef01234567",
    deployed: true,
    deployedAt: "2026-11-10T08:03:00.000Z",
  },
  {
    componentKey: "web",
    repoFullName: "acme/web",
    commitSha: null,
    tag: null,
    ref: "develop",
    deployed: false,
    deployedAt: null,
  },
];

describe("GET /api/environments/:id/running", () => {
  it("gives a project member the running version of every target, without the CI connection", async () => {
    as("engineer", P1);
    const res = await running();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: EXPECTED });
    for (const item of body.items)
      expect(item).not.toHaveProperty("ciConnectionId");
  });

  it("refuses a non-member engineer like the other environment reads (404)", async () => {
    as("engineer", P2);
    const res = await running();
    const teardown = await app.request(`/api/environments/${ENV1}/teardown`);
    expect(res.status).toBe(404);
    expect(res.status).toBe(teardown.status);
  });

  it.each(["observer", "admin"])(
    "lets an %s who is not a member read it",
    async (role) => {
      as(role);
      const res = await running();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: EXPECTED });
    }
  );

  it("rejects a malformed id (400)", async () => {
    as("admin");
    const res = await app.request("/api/environments/not-a-uuid/running");
    expect(res.status).toBe(400);
  });
});

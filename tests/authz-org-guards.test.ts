import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: { user: { id: "u1", role: "qa" } },
  memberships: [] as { projectId: string }[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => mocks.session,
  getServerSession: async () => mocks.session,
}));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => {
        const projectsQuery = Promise.resolve([{ id: "p1" }, { id: "p2" }]);
        return Object.assign(projectsQuery, {
          where: async () => mocks.memberships,
        });
      },
    }),
  },
}));

import {
  ForbiddenError,
  requireOrgPermission,
  routeOrgGuard,
} from "@/lib/authz";

// The job role decides the org grant; memberships only decide visibility.
function as(role: string, ...projectIds: string[]) {
  mocks.session = { user: { id: "u1", role } };
  mocks.memberships = projectIds.map((projectId) => ({ projectId }));
}

describe("org guards apply the engineer grant", () => {
  beforeEach(() => as("qa"));

  it("lets an engineer member read servers and open the terminal", async () => {
    as("engineer", "p1");
    await expect(
      requireOrgPermission({ server: ["read"] })
    ).resolves.toBeDefined();
    const guard = await routeOrgGuard({ server: ["terminal"] });
    expect(guard.ok).toBe(true);
  });

  it("still denies an engineer member server management", async () => {
    as("engineer", "p1");
    await expect(
      requireOrgPermission({ server: ["manage"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
    const guard = await routeOrgGuard({ server: ["manage"] });
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(403);
  });

  it("denies a QA member", async () => {
    as("qa", "p1");
    await expect(
      requireOrgPermission({ server: ["read"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
    const guard = await routeOrgGuard({ server: ["read"] });
    expect(guard.ok).toBe(false);
  });

  it("denies a QA with no memberships", async () => {
    await expect(
      requireOrgPermission({ server: ["read"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

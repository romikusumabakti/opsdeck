import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: { user: { id: "u1", role: "member" } },
  memberships: [] as { projectId: string; role: string }[],
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

function asMember(...roles: string[]) {
  mocks.session = { user: { id: "u1", role: "member" } };
  mocks.memberships = roles.map((role, i) => ({
    projectId: `p${i + 1}`,
    role,
  }));
}

describe("org guards apply the engineer grant", () => {
  beforeEach(() => asMember());

  it("lets an engineer member read servers and open the terminal", async () => {
    asMember("engineer");
    await expect(
      requireOrgPermission({ server: ["read"] })
    ).resolves.toBeDefined();
    const guard = await routeOrgGuard({ server: ["terminal"] });
    expect(guard.ok).toBe(true);
  });

  it("still denies an engineer member server management", async () => {
    asMember("engineer");
    await expect(
      requireOrgPermission({ server: ["manage"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
    const guard = await routeOrgGuard({ server: ["manage"] });
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(403);
  });

  it("denies a member holding only a qa membership", async () => {
    asMember("qa");
    await expect(
      requireOrgPermission({ server: ["read"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
    const guard = await routeOrgGuard({ server: ["read"] });
    expect(guard.ok).toBe(false);
  });

  it("denies a member with no memberships", async () => {
    await expect(
      requireOrgPermission({ server: ["read"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

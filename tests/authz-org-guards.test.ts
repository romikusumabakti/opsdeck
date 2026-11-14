import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: {
    user: { id: "u1", role: "qa" },
    session: { signInMethod: "passkey" as string | null },
  },
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
  mocks.session = {
    user: { id: "u1", role },
    session: { signInMethod: "passkey" },
  };
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

describe("org guards require a strong sign-in for risky actions", () => {
  function asWeak(role: string, signInMethod: string | null = "password") {
    as(role);
    mocks.session = { ...mocks.session, session: { signInMethod } };
  }

  it("refuses a password session the terminal with a coded 403", async () => {
    asWeak("admin");
    const error = await requireOrgPermission({ server: ["terminal"] }).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.code).toBe("strong_sign_in_required");
    const guard = await routeOrgGuard({ server: ["terminal"] });
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.response.status).toBe(403);
      expect(await guard.response.json()).toEqual({
        error: expect.any(String),
        code: "strong_sign_in_required",
      });
    }
  });

  it("treats a session without a method as weak", async () => {
    asWeak("admin", null);
    await expect(
      requireOrgPermission({ server: ["terminal"] })
    ).rejects.toMatchObject({ code: "strong_sign_in_required" });
  });

  it("still lets a password session use weak-allowed actions", async () => {
    asWeak("admin");
    await expect(
      requireOrgPermission({ server: ["read"] })
    ).resolves.toBeDefined();
    expect((await routeOrgGuard({ server: ["read"] })).ok).toBe(true);
  });

  it.each(["passkey", "microsoft", "password+totp"])(
    "lets a %s session in",
    async (method) => {
      asWeak("admin", method);
      await expect(
        requireOrgPermission({ server: ["terminal"] })
      ).resolves.toBeDefined();
      expect((await routeOrgGuard({ server: ["terminal"] })).ok).toBe(true);
    }
  );

  it("answers a qa user with the plain 403, not the strength code", async () => {
    asWeak("qa");
    const error = await requireOrgPermission({ server: ["terminal"] }).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.code).toBeUndefined();
    const guard = await routeOrgGuard({ server: ["terminal"] });
    if (!guard.ok)
      expect(await guard.response.json()).toEqual({ error: "Forbidden" });
  });
});

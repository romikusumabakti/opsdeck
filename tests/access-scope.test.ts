import { inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { environments } from "@/lib/db/schema";

// The explicit access scope: the same project roles whether resolved from the
// request's session (accessScopeFromSession) or, for the worker, from the
// user's row and memberships (accessScopeForUser). The database is a fake
// answering both the SQL-builder reads (lib/authz#getProjectAccess) and the
// relational ones (accessScopeForUser).

const P1 = "0197f3a0-1b2c-7def-8000-0000000000a1";
const P2 = "0197f3a0-1b2c-7def-8000-0000000000a2";
const ENV1 = "0197f3a0-1b2c-7def-8000-0000000000e1";

type UserRow = {
  id: string;
  role: string | null;
  banned: boolean;
  banExpires: Date | null;
};

const state = vi.hoisted(() => ({
  users: [] as UserRow[],
  members: [] as { userId: string; projectId: string }[],
  sessionUserId: "",
}));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const sessionMembers = () =>
    state.members
      .filter((m) => m.userId === state.sessionUserId)
      .map((m) => ({ projectId: m.projectId }));
  const rows = (table: unknown) => {
    if (table === schema.projects) return [{ id: P1 }, { id: P2 }];
    if (table === schema.projectMembers) return sessionMembers();
    if (table === schema.environments) return [{ projectId: P1 }];
    throw new Error("unexpected table");
  };
  const answer = (table: unknown) => {
    const q = Object.assign(Promise.resolve(rows(table)), {
      where: () => q,
      limit: async () => rows(table).slice(0, 1),
    });
    return q;
  };
  return {
    db: {
      select: () => ({ from: (table: unknown) => answer(table) }),
      query: {
        users: {
          findFirst: async ({ where }: { where: { id: string } }) =>
            state.users.find((u) => u.id === where.id),
        },
        projects: { findMany: async () => [{ id: P1 }, { id: P2 }] },
        projectMembers: {
          findMany: async ({ where }: { where: { userId: string } }) =>
            state.members.filter((m) => m.userId === where.userId),
        },
      },
    },
  };
});

vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => {
    const user = state.users.find((u) => u.id === state.sessionUserId);
    if (!user) throw new Error("no session");
    return { user: { id: user.id, role: user.role }, session: {} };
  },
  getServerSession: async () => null,
}));

const {
  AccessScopeError,
  accessScopeForUser,
  accessScopeFromSession,
  can,
  projectRoleIn,
  requireProjectPermissionIn,
  scopedProjectFilter,
  scopedProjectIds,
} = await import("@/lib/access-scope");

const user = (id: string, role: string | null, banned = false): UserRow => ({
  id,
  role,
  banned,
  banExpires: null,
});

beforeEach(() => {
  state.users = [
    user("admin", "admin"),
    user("observer", "observer"),
    user("engineer", "engineer"),
    user("qa", "qa"),
    user("banned", "admin", true),
  ];
  // The engineer is a member of P1; qa is a member of nothing.
  state.members = [{ userId: "engineer", projectId: P1 }];
});

describe("accessScopeForUser matches accessScopeFromSession", () => {
  for (const id of ["admin", "observer", "engineer", "qa"]) {
    it(`for ${id}`, async () => {
      state.sessionUserId = id;
      expect(await accessScopeForUser(id)).toEqual(
        await accessScopeFromSession()
      );
    });
  }

  it("resolves the roles the job role grants", async () => {
    expect(await accessScopeForUser("admin")).toEqual({
      userId: "admin",
      orgRole: "admin",
      projectRoles: { [P1]: "engineer", [P2]: "engineer" },
      seesAllProjects: true,
    });
    expect(await accessScopeForUser("observer")).toMatchObject({
      projectRoles: { [P1]: "viewer", [P2]: "viewer" },
      seesAllProjects: true,
    });
    expect(await accessScopeForUser("engineer")).toEqual({
      userId: "engineer",
      orgRole: "engineer",
      projectRoles: { [P1]: "engineer" },
      seesAllProjects: false,
    });
    expect(await accessScopeForUser("qa")).toMatchObject({
      orgRole: "qa",
      projectRoles: {},
      seesAllProjects: false,
    });
  });

  it("refuses an unknown or banned user, as a session would", async () => {
    await expect(accessScopeForUser("nobody")).rejects.toMatchObject({
      reason: "not_found",
    });
    await expect(accessScopeForUser("banned")).rejects.toBeInstanceOf(
      AccessScopeError
    );
    await expect(accessScopeForUser("banned")).rejects.toMatchObject({
      reason: "banned",
    });
  });

  it("an expired ban no longer applies", async () => {
    state.users.push({
      id: "was-banned",
      role: "qa",
      banned: true,
      banExpires: new Date(Date.now() - 60_000),
    });
    expect(await accessScopeForUser("was-banned")).toMatchObject({
      orgRole: "qa",
    });
  });
});

describe("decisions on a scope", () => {
  it("can() follows the project role's statements", async () => {
    const observer = await accessScopeForUser("observer");
    const engineer = await accessScopeForUser("engineer");
    expect(can(observer, P1, { deploy: ["view"] })).toBe(true);
    expect(can(observer, P1, { deploy: ["run"] })).toBe(false);
    expect(can(engineer, P1, { deploy: ["run"] })).toBe(true);
    expect(can(engineer, P2, { project: ["read"] })).toBe(false);
  });

  it("filters list queries like projectScope", async () => {
    expect(scopedProjectIds(await accessScopeForUser("admin"))).toBe("all");
    expect(
      scopedProjectFilter(
        await accessScopeForUser("admin"),
        environments.projectId
      )
    ).toBeUndefined();
    expect(
      scopedProjectFilter(
        await accessScopeForUser("qa"),
        environments.projectId
      )
    ).toEqual(sql`false`);
    expect(
      scopedProjectFilter(
        await accessScopeForUser("engineer"),
        environments.projectId
      )
    ).toEqual(inArray(environments.projectId, [P1]));
  });

  it("requireProjectPermissionIn: 404 invisible, 403 not permitted, else the role", async () => {
    const engineer = await accessScopeForUser("engineer");
    const observer = await accessScopeForUser("observer");
    await expect(
      requireProjectPermissionIn(
        engineer,
        { projectId: P2 },
        { project: ["read"] }
      )
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      requireProjectPermissionIn(
        engineer,
        { projectId: "not-a-uuid" },
        { project: ["read"] }
      )
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      requireProjectPermissionIn(
        observer,
        { environmentId: ENV1 },
        { deploy: ["run"] }
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await requireProjectPermissionIn(
        engineer,
        { environmentId: ENV1 },
        { deploy: ["run"] }
      )
    ).toEqual({ role: "engineer", projectId: P1 });
  });

  it("projectRoleIn resolves an environment to its project's role", async () => {
    expect(
      await projectRoleIn(await accessScopeForUser("observer"), {
        environmentId: ENV1,
      })
    ).toBe("viewer");
    expect(
      await projectRoleIn(await accessScopeForUser("qa"), {
        environmentId: ENV1,
      })
    ).toBeNull();
  });
});

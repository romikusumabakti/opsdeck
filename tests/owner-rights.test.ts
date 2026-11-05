import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canEnvironment,
  canProject,
  OWNER_PERMISSIONS,
  type ProjectPermissions,
} from "@/lib/permissions";

// The environment owner (environments.owner_id) may deploy, roll back, delete
// the environment and read/write its variables without the maintainer role —
// not configure deploy targets nor update the environment — but only on that environment and
// only while they hold at least `viewer` on the project.

const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";
const OTHER_PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f2";
const ENV_A = "0197f3a0-1b2c-7def-8000-0123456789e1";
const ENV_B = "0197f3a0-1b2c-7def-8000-0123456789e2";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const OTHER_USER = "0197f3a0-1b2c-7def-8000-0123456789a2";

describe("OWNER_PERMISSIONS", () => {
  it("is exactly the rights the spec gives an owner", () => {
    expect(OWNER_PERMISSIONS).toEqual({
      deploy: ["view", "run", "rollback"],
      environment: ["delete"],
      variable: ["read", "write"],
    });
  });
});

describe("variable statement", () => {
  it("is held by maintainers only", () => {
    for (const action of ["read", "write"] as const) {
      expect(canProject("maintainer", { variable: [action] })).toBe(true);
      expect(canProject("contributor", { variable: [action] })).toBe(false);
      expect(canProject("viewer", { variable: [action] })).toBe(false);
    }
  });
});

describe("canEnvironment", () => {
  it("adds the owner rights on top of the project role", () => {
    expect(canEnvironment("viewer", true, { deploy: ["run"] })).toBe(true);
    expect(canEnvironment("viewer", false, { deploy: ["run"] })).toBe(false);
    expect(
      canEnvironment("contributor", true, {
        environment: ["delete"],
        variable: ["read"],
      })
    ).toBe(true);
  });

  it("never grants an owner without a project role", () => {
    expect(canEnvironment(null, true, { deploy: ["view"] })).toBe(false);
  });

  it("refuses a request not fully covered by the owner rights", () => {
    const outside: ProjectPermissions[] = [
      { environment: ["create"] },
      { environment: ["update"] },
      { deploy: ["configure"] },
      { member: ["manage"] },
      { database: ["drop"] },
      { service: ["control"] },
      { deploy: ["run"], service: ["control"] },
    ];
    for (const perms of outside) {
      expect(canEnvironment("viewer", true, perms)).toBe(false);
    }
  });

  it("is not fooled by inherited property names", () => {
    // better-auth's authorize throws on such a key before the owner branch
    // runs; either way (throw or false) the request is not granted.
    const granted = (() => {
      try {
        return canEnvironment("viewer", true, {
          toString: ["x"],
        } as unknown as ProjectPermissions);
      } catch {
        return false;
      }
    })();
    expect(granted).toBe(false);
  });
});

// requireProjectPermission against a fake database: the environment rows and
// memberships come from the state, read on every call.
const state = vi.hoisted(() => ({
  orgRole: "member" as string,
  memberships: [] as { projectId: string; role: string }[],
  environments: {} as Record<
    string,
    { projectId: string; ownerId: string | null }
  >,
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({
    user: { id: "0197f3a0-1b2c-7def-8000-0123456789a1", role: state.orgRole },
  }),
  getServerSession: async () => ({
    user: { id: "0197f3a0-1b2c-7def-8000-0123456789a1", role: state.orgRole },
  }),
}));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const dialect = new PgDialect();
  const rows = (table: unknown, params: unknown[]): unknown[] => {
    if (table === schema.projects) {
      return [
        { id: "0197f3a0-1b2c-7def-8000-0123456789f1" },
        { id: "0197f3a0-1b2c-7def-8000-0123456789f2" },
      ];
    }
    if (table === schema.projectMembers) return state.memberships;
    if (table === schema.environments) {
      const env = state.environments[String(params[0])];
      return env ? [env] : [];
    }
    return [];
  };
  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          let params: unknown[] = [];
          // biome-ignore lint/suspicious/noExplicitAny: self-referential mock builder
          const chain: any = {
            where: (condition: SQL) => {
              params = dialect.sqlToQuery(condition).params;
              return chain;
            },
            limit: () => chain,
            // biome-ignore lint/suspicious/noThenProperty: awaitable query builder
            then: (resolve: (r: unknown[]) => unknown, reject: () => unknown) =>
              Promise.resolve(rows(table, params)).then(resolve, reject),
          };
          return chain;
        },
      }),
    },
  };
});

const { requireProjectPermission, ForbiddenError } = await import(
  "@/lib/authz"
);

beforeEach(() => {
  state.orgRole = "member";
  state.memberships = [{ projectId: PROJECT_ID, role: "viewer" }];
  state.environments = {
    [ENV_A]: { projectId: PROJECT_ID, ownerId: USER_ID },
    [ENV_B]: { projectId: PROJECT_ID, ownerId: OTHER_USER },
  };
});

describe("requireProjectPermission and the environment owner", () => {
  it("lets an owner who is only viewer deploy their own environment", async () => {
    for (const perms of [
      { deploy: ["run"] },
      { deploy: ["rollback"] },
      { environment: ["delete"] },
      { variable: ["read", "write"] },
    ] satisfies ProjectPermissions[]) {
      const result = await requireProjectPermission(
        { environmentId: ENV_A },
        perms
      );
      expect(result.role).toBe("viewer");
      expect(result.isOwner).toBe(true);
    }
  });

  it("refuses the same owner on a sibling environment", async () => {
    await expect(
      requireProjectPermission({ environmentId: ENV_B }, { deploy: ["run"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses the owner anything beyond the owner rights", async () => {
    for (const perms of [
      { deploy: ["configure"] },
      { environment: ["update"] },
      { deploy: ["run", "configure"] },
      { service: ["control"] },
      { database: ["drop"] },
      { deploy: ["run"], service: ["control"] },
    ] satisfies ProjectPermissions[]) {
      await expect(
        requireProjectPermission({ environmentId: ENV_A }, perms)
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("does not apply the owner rule to a project-scoped request", async () => {
    await expect(
      requireProjectPermission({ projectId: PROJECT_ID }, { deploy: ["run"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("removes the right as soon as the owner changes", async () => {
    await requireProjectPermission(
      { environmentId: ENV_A },
      {
        deploy: ["run"],
      }
    );
    state.environments[ENV_A] = { projectId: PROJECT_ID, ownerId: OTHER_USER };
    await expect(
      requireProjectPermission({ environmentId: ENV_A }, { deploy: ["run"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
    state.environments[ENV_A] = { projectId: PROJECT_ID, ownerId: null };
    await expect(
      requireProjectPermission({ environmentId: ENV_A }, { deploy: ["run"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("denies an owner without any project role (project invisible: 404)", async () => {
    state.memberships = [];
    await expect(
      requireProjectPermission({ environmentId: ENV_A }, { deploy: ["run"] })
    ).rejects.toMatchObject({ status: 404 });
    // A membership in another project does not help either.
    state.memberships = [{ projectId: OTHER_PROJECT_ID, role: "maintainer" }];
    await expect(
      requireProjectPermission({ environmentId: ENV_A }, { deploy: ["run"] })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("gives an observer owner (implicit viewer) the owner rights", async () => {
    state.orgRole = "observer";
    state.memberships = [];
    const result = await requireProjectPermission(
      { environmentId: ENV_A },
      { deploy: ["run"] }
    );
    expect(result.isOwner).toBe(true);
  });

  it("leaves a contributor who is not the owner without deploy rights", async () => {
    state.memberships = [{ projectId: PROJECT_ID, role: "contributor" }];
    await expect(
      requireProjectPermission({ environmentId: ENV_B }, { deploy: ["run"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      requireProjectPermission({ environmentId: ENV_B }, { variable: ["read"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("still answers maintainers from their role", async () => {
    state.memberships = [{ projectId: PROJECT_ID, role: "maintainer" }];
    const result = await requireProjectPermission(
      { environmentId: ENV_B },
      { deploy: ["run"] }
    );
    expect(result.isOwner).toBe(false);
  });
});

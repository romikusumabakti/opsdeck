import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canProject, type ProjectPermissions } from "@/lib/permissions";

// The environment owner (environments.owner_id) is a label: owning an
// environment grants nothing. Deploys and variables follow the project role
// only (owner decision 2026-11-05: QA do not deploy; developers are project
// maintainers). A deploy lock for the owner is a separate follow-up plan.

const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";
const ENV_A = "0197f3a0-1b2c-7def-8000-0123456789e1";
const ENV_B = "0197f3a0-1b2c-7def-8000-0123456789e2";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const OTHER_USER = "0197f3a0-1b2c-7def-8000-0123456789a2";

describe("variable statement", () => {
  it("is held by maintainers only", () => {
    for (const action of ["read", "write"] as const) {
      expect(canProject("engineer", { variable: [action] })).toBe(true);
      expect(canProject("qa", { variable: [action] })).toBe(false);
      expect(canProject("viewer", { variable: [action] })).toBe(false);
    }
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
  const OWNER_REQUESTS = [
    { deploy: ["run"] },
    { deploy: ["rollback"] },
    { environment: ["delete"] },
    { variable: ["read"] },
    { variable: ["write"] },
  ] satisfies ProjectPermissions[];

  for (const role of ["viewer", "qa"] as const) {
    it(`refuses an owner who is only ${role} (403) on their own environment`, async () => {
      state.memberships = [{ projectId: PROJECT_ID, role }];
      for (const perms of OWNER_REQUESTS) {
        await expect(
          requireProjectPermission({ environmentId: ENV_A }, perms)
        ).rejects.toBeInstanceOf(ForbiddenError);
      }
    });
  }

  it("refuses an observer owner (implicit viewer) too", async () => {
    state.orgRole = "observer";
    state.memberships = [];
    await expect(
      requireProjectPermission({ environmentId: ENV_A }, { deploy: ["run"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("answers maintainers from their role, owner or not", async () => {
    state.memberships = [{ projectId: PROJECT_ID, role: "engineer" }];
    for (const environmentId of [ENV_A, ENV_B]) {
      const result = await requireProjectPermission(
        { environmentId },
        { deploy: ["run"], variable: ["read", "write"] }
      );
      expect(result.role).toBe("engineer");
      expect(result).not.toHaveProperty("isOwner");
    }
  });
});

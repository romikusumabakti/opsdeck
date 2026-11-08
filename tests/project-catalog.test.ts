import { beforeEach, describe, expect, it, vi } from "vitest";

// addProject: who may create a project, and the creator's engineer membership
// landing in the same transaction as the project row.

const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a9";
const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";

const state = vi.hoisted(() => ({
  orgRole: "member" as string,
  roles: {} as Record<string, string>,
  inserts: [] as { table: unknown; values: unknown; inTx: boolean }[],
  committed: false,
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({
    user: { id: USER_ID, role: state.orgRole },
  }),
  getServerSession: async () => ({
    user: { id: USER_ID, role: state.orgRole },
  }),
}));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  getProjectAccess: async () => ({ all: false, roles: state.roles }),
}));
vi.mock("@/lib/db", () => {
  const writer = (inTx: boolean) => ({
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        state.inserts.push({ table, values, inTx });
        const rows = [{ id: PROJECT_ID, ...(values as object) }];
        return { returning: async () => rows };
      },
    }),
  });
  return {
    db: {
      ...writer(false),
      transaction: async (fn: (tx: ReturnType<typeof writer>) => unknown) => {
        const result = await fn(writer(true));
        state.committed = true;
        return result;
      },
    },
  };
});

const schema = await import("@/lib/db/schema");
const { addProject } = await import("@/server/services/project-catalog");

beforeEach(() => {
  state.orgRole = "member";
  state.roles = {};
  state.inserts = [];
  state.committed = false;
});

const input = { key: "NEW", name: "New project" };

describe("addProject", () => {
  it("makes the creator engineer", async () => {
    state.roles = { other: "engineer" };
    const result = await addProject(input);
    expect(result.success).toBe(true);
    const membership = state.inserts.find(
      (i) => i.table === schema.projectMembers
    );
    expect(membership).toMatchObject({
      inTx: true,
      values: { projectId: PROJECT_ID, userId: USER_ID, role: "engineer" },
    });
    expect(state.inserts.find((i) => i.table === schema.projects)?.inTx).toBe(
      true
    );
  });

  it("adds no membership for an admin, who is engineer everywhere", async () => {
    state.orgRole = "admin";
    expect((await addProject(input)).success).toBe(true);
    expect(state.inserts.some((i) => i.table === schema.projectMembers)).toBe(
      false
    );
  });

  it("refuses a member who is only QA, before writing anything", async () => {
    state.roles = { other: "qa" };
    await expect(addProject(input)).rejects.toMatchObject({ status: 403 });
    expect(state.inserts).toEqual([]);
  });
});

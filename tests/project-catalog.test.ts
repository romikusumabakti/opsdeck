import { beforeEach, describe, expect, it, vi } from "vitest";

// addProject: who may create a project, and the creator's engineer membership
// landing in the same transaction as the project row. editProject: only org
// server:manage may set or clear the project's default server.

const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a9";
const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";

const state = vi.hoisted(() => ({
  orgRole: "member" as string,
  roles: {} as Record<string, string>,
  inserts: [] as { table: unknown; values: unknown; inTx: boolean }[],
  updates: [] as { table: unknown; values: Record<string, unknown> }[],
  // Each select's rows, in call order (the project before, the server name).
  selects: [] as unknown[][],
  activity: [] as unknown[],
  committed: false,
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({
    user: { id: USER_ID, name: "Rina", role: state.orgRole },
  }),
  getServerSession: async () => ({
    user: { id: USER_ID, role: state.orgRole },
  }),
}));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  getProjectAccess: async () => ({ all: false, roles: state.roles }),
  // editProject's gate: an engineer of the project.
  requireProjectPermission: async () => ({
    session: { user: { id: USER_ID, role: state.orgRole } },
    role: "engineer",
    projectId: PROJECT_ID,
  }),
}));
vi.mock("@/lib/activity", () => ({
  recordActivity: async (entry: unknown) => {
    state.activity.push(entry);
  },
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
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => state.selects.shift() ?? [] }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          state.updates.push({ table, values });
          return {
            where: () => ({
              returning: async () => [{ id: PROJECT_ID, ...values }],
            }),
          };
        },
      }),
      transaction: async (fn: (tx: ReturnType<typeof writer>) => unknown) => {
        const result = await fn(writer(true));
        state.committed = true;
        return result;
      },
    },
  };
});

const schema = await import("@/lib/db/schema");
const { addProject, editProject } = await import(
  "@/server/services/project-catalog"
);

beforeEach(() => {
  state.orgRole = "member";
  state.roles = {};
  state.inserts = [];
  state.updates = [];
  state.selects = [];
  state.activity = [];
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
    expect(state.activity).toEqual([
      {
        actorId: USER_ID,
        action: "member.added",
        entityType: "member",
        entityId: USER_ID,
        data: { user: "Rina", project: "New project", role: "engineer" },
      },
    ]);
  });

  it("adds no membership for an admin, who is engineer everywhere", async () => {
    state.orgRole = "admin";
    expect((await addProject(input)).success).toBe(true);
    expect(state.inserts.some((i) => i.table === schema.projectMembers)).toBe(
      false
    );
    expect(state.activity).toEqual([]);
  });

  it("refuses a member who is only QA, before writing anything", async () => {
    state.roles = { other: "qa" };
    await expect(addProject(input)).rejects.toMatchObject({ status: 403 });
    expect(state.inserts).toEqual([]);
  });
});

const SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789c1";

describe("editProject default server", () => {
  it("lets server:manage set the default server", async () => {
    state.orgRole = "infra";
    const result = await editProject(PROJECT_ID, {
      defaultServerId: SERVER_ID,
    });
    expect(result.success).toBe(true);
    expect(state.updates[0]?.values).toMatchObject({
      defaultServerId: SERVER_ID,
    });
  });

  it("lets server:manage clear it with null", async () => {
    state.orgRole = "admin";
    expect(
      (await editProject(PROJECT_ID, { defaultServerId: null })).success
    ).toBe(true);
    expect(state.updates[0]?.values).toMatchObject({ defaultServerId: null });
  });

  it("refuses an engineer without server:manage with a stable code", async () => {
    state.orgRole = "member";
    await expect(
      editProject(PROJECT_ID, { name: "Renamed", defaultServerId: SERVER_ID })
    ).rejects.toMatchObject({ status: 403, code: "defaultServerForbidden" });
    await expect(
      editProject(PROJECT_ID, { defaultServerId: null })
    ).rejects.toMatchObject({ status: 403, code: "defaultServerForbidden" });
    expect(state.updates).toEqual([]);
  });

  it("still lets an engineer edit the other details", async () => {
    state.orgRole = "member";
    expect((await editProject(PROJECT_ID, { name: "Renamed" })).success).toBe(
      true
    );
    expect(state.updates[0]?.values).not.toHaveProperty("defaultServerId");
    expect(state.activity).toEqual([]);
  });
});

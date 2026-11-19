import { beforeEach, describe, expect, it, vi } from "vitest";

// addProject: who may create a project, and the creator's membership landing
// in the same transaction as the project row. editProject: only org
// server:manage may set or clear the project's default server.

const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a9";
const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";

const state = vi.hoisted(() => ({
  orgRole: "engineer" as string,
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
    session: { signInMethod: "passkey" },
  }),
  getServerSession: async () => ({
    user: { id: USER_ID, role: state.orgRole },
    session: { signInMethod: "passkey" },
  }),
}));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  // editProject's gate: an engineer of the project.
  requireProjectPermission: async () => ({
    session: {
      user: { id: USER_ID, role: state.orgRole },
      session: { signInMethod: "passkey" },
    },
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
  state.orgRole = "engineer";
  state.inserts = [];
  state.updates = [];
  state.selects = [];
  state.activity = [];
  state.committed = false;
});

const input = { key: "NEW", name: "New project" };

describe("addProject", () => {
  it("makes the creator a member", async () => {
    state.orgRole = "engineer";
    const result = await addProject(input);
    expect(result.success).toBe(true);
    const membership = state.inserts.find(
      (i) => i.table === schema.projectMembers
    );
    expect(membership).toMatchObject({
      inTx: true,
      values: { projectId: PROJECT_ID, userId: USER_ID },
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
        data: { user: "Rina", project: "New project" },
      },
    ]);
  });

  it("adds the admin as a member too", async () => {
    state.orgRole = "admin";
    expect((await addProject(input)).success).toBe(true);
    expect(
      state.inserts.find((i) => i.table === schema.projectMembers)
    ).toMatchObject({
      inTx: true,
      values: { projectId: PROJECT_ID, userId: USER_ID },
    });
    expect(state.activity).toEqual([
      expect.objectContaining({ action: "member.added", entityId: USER_ID }),
    ]);
  });

  it("refuses a member who is only QA, before writing anything", async () => {
    state.orgRole = "qa";
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
    state.orgRole = "engineer";
    await expect(
      editProject(PROJECT_ID, { name: "Renamed", defaultServerId: SERVER_ID })
    ).rejects.toMatchObject({ status: 403, code: "defaultServerForbidden" });
    await expect(
      editProject(PROJECT_ID, { defaultServerId: null })
    ).rejects.toMatchObject({ status: 403, code: "defaultServerForbidden" });
    expect(state.updates).toEqual([]);
  });

  it("still lets an engineer edit the other details", async () => {
    state.orgRole = "engineer";
    expect((await editProject(PROJECT_ID, { name: "Renamed" })).success).toBe(
      true
    );
    expect(state.updates[0]?.values).not.toHaveProperty("defaultServerId");
    expect(state.activity).toEqual([]);
  });
});

const GROUP_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const OTHER_GROUP_ID = "0197f3a0-1b2c-7def-8000-0123456789e2";

describe("a project's group", () => {
  it("refuses an engineer creating a project in a group, before writing", async () => {
    state.orgRole = "engineer";
    await expect(
      addProject({ ...input, groupId: GROUP_ID })
    ).rejects.toMatchObject({ status: 403, code: "projectGroupForbidden" });
    expect(state.inserts).toEqual([]);
  });

  it("lets an admin create a project in a group, never writing client", async () => {
    state.orgRole = "admin";
    expect(
      (await addProject({ ...input, groupId: GROUP_ID, client: "Legacy" }))
        .success
    ).toBe(true);
    const project = state.inserts.find((i) => i.table === schema.projects);
    expect(project?.values).toMatchObject({ groupId: GROUP_ID });
    expect(project?.values).not.toHaveProperty("client");
  });

  it("refuses an engineer moving a project to another group", async () => {
    state.orgRole = "engineer";
    state.selects = [[{ groupId: GROUP_ID, defaultServerId: null }]];
    await expect(
      editProject(PROJECT_ID, { groupId: OTHER_GROUP_ID })
    ).rejects.toMatchObject({ status: 403, code: "projectGroupForbidden" });
    expect(state.updates).toEqual([]);
  });

  it("lets an engineer resend the unchanged group with other edits", async () => {
    state.orgRole = "engineer";
    state.selects = [[{ groupId: GROUP_ID, defaultServerId: null }]];
    expect(
      (await editProject(PROJECT_ID, { name: "Renamed", groupId: GROUP_ID }))
        .success
    ).toBe(true);
    expect(state.activity).toEqual([]);
  });

  it("records an admin's group change", async () => {
    state.orgRole = "admin";
    state.selects = [
      [{ groupId: GROUP_ID, defaultServerId: null }],
      [{ name: "Beta" }],
    ];
    expect(
      (
        await editProject(PROJECT_ID, {
          name: "Kestrel",
          groupId: OTHER_GROUP_ID,
        })
      ).success
    ).toBe(true);
    expect(state.activity).toEqual([
      {
        actorId: USER_ID,
        action: "project.groupChanged",
        entityType: "project",
        entityId: PROJECT_ID,
        data: { project: "Kestrel", group: "Beta" },
      },
    ]);
  });
});

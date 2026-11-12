import { beforeEach, describe, expect, it, vi } from "vitest";

// The members service: membership carries no role. Adding is idempotent and
// logs only a row that was really inserted; the list shows each member's
// global role.

const P = "0197f3a0-1b2c-7def-8000-0123456789f1";
const U = "0197f3a0-1b2c-7def-8000-0123456789a9";

const state = vi.hoisted(() => ({
  insertValues: undefined as unknown,
  insertReturns: [] as unknown[],
  selectRows: [] as unknown[],
  // memberNames' two lookups, in call order (user, then project).
  nameRows: [] as unknown[][],
}));

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));

vi.mock("@/lib/authz", () => ({
  requireProjectPermission: async () => ({
    session: { user: { id: "actor" } },
  }),
}));
vi.mock("@/lib/activity", () => activity);
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));
vi.mock("@/lib/db", () => {
  // A select ending in .limit() is a memberNames lookup; one ending in
  // .orderBy() is the member list.
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => state.nameRows.shift() ?? [],
    orderBy: async () => state.selectRows,
  };
  return {
    db: {
      select: () => chain,
      insert: () => ({
        values: (values: unknown) => {
          state.insertValues = values;
          return {
            onConflictDoNothing: () => ({
              returning: async () => state.insertReturns,
            }),
          };
        },
      }),
    },
  };
});

const { addProjectMember, listProjectMembers } = await import(
  "@/server/services/project-members"
);

beforeEach(() => {
  state.insertValues = undefined;
  state.insertReturns = [];
  state.selectRows = [];
  state.nameRows = [[{ name: "Rina" }], [{ name: "Kestrel" }]];
  activity.recordActivity.mockReset();
});

describe("project members service", () => {
  it("adds a member without a role and logs member.added with user and project only", async () => {
    state.insertReturns = [{ userId: U }];
    expect((await addProjectMember({ projectId: P, userId: U })).success).toBe(
      true
    );
    expect(state.insertValues).toEqual({ projectId: P, userId: U });
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.added",
        data: { user: "Rina", project: "Kestrel" },
      })
    );
  });

  it("re-adding an existing member succeeds and logs nothing", async () => {
    state.insertReturns = []; // onConflictDoNothing returned no row
    expect((await addProjectMember({ projectId: P, userId: U })).success).toBe(
      true
    );
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("rejects an invalid id before writing", async () => {
    const result = await addProjectMember({ projectId: P, userId: "nope" });
    expect(result.success).toBe(false);
    expect(state.insertValues).toBeUndefined();
  });

  it("lists members with their normalized global role", async () => {
    state.selectRows = [
      { userId: U, name: "Rina", image: null, email: "r@x", role: "member" },
    ];
    expect(await listProjectMembers(P)).toEqual([
      { userId: U, name: "Rina", image: null, email: "r@x", orgRole: "qa" },
    ]);
  });
});

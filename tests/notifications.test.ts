import { beforeEach, describe, expect, it, vi } from "vitest";

const inserted: unknown[] = [];
vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: async (row: unknown) => {
        inserted.push(row);
      },
    }),
  },
}));

const { notifyJiraPushFailed } = await import("@/lib/notifications");

describe("notifyJiraPushFailed", () => {
  beforeEach(() => {
    inserted.length = 0;
  });

  it("tells the editor which issue and field did not reach Jira", async () => {
    await notifyJiraPushFailed({
      userId: "user-1",
      projectKey: "DPMB",
      number: 45,
      fields: "status",
      reason: "no_transition",
    });
    expect(inserted).toEqual([
      {
        userId: "user-1",
        type: "jira_push_failed",
        data: {
          key: "DPMB",
          number: 45,
          fields: "status",
          reason: "no_transition",
        },
        href: "/DPMB/issues/45",
      },
    ]);
  });

  it("does nothing when the edit has no known author", async () => {
    await notifyJiraPushFailed({
      userId: undefined,
      projectKey: "DPMB",
      number: 45,
      fields: "status",
      reason: "conflict",
    });
    expect(inserted).toEqual([]);
  });
});

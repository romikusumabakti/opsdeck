import { beforeEach, describe, expect, it, vi } from "vitest";

type UserRow = {
  id: string;
  role: string;
  banned: boolean;
  banExpires: Date | null;
};

const state = vi.hoisted(() => ({
  users: [] as UserRow[],
  projects: ["p1", "p2", "p3"],
  members: [] as { userId: string; projectId: string }[],
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      users: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          state.users.find((u) => u.id === where.id)
        ),
      },
      projects: {
        findMany: vi.fn(async () => state.projects.map((id) => ({ id }))),
      },
      projectMembers: {
        findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
          state.members.filter((m) => m.userId === where.userId)
        ),
      },
    },
  },
}));

const { loadAssistantViewer, AssistantViewerError } = await import(
  "@/lib/assistant/viewer"
);

beforeEach(() => {
  state.users = [
    { id: "qa", role: "qa", banned: false, banExpires: null },
    { id: "admin", role: "admin", banned: false, banExpires: null },
    { id: "weird", role: "nonsense", banned: false, banExpires: null },
    { id: "banned", role: "admin", banned: true, banExpires: null },
    {
      id: "expired-ban",
      role: "qa",
      banned: true,
      banExpires: new Date(Date.now() - 60_000),
    },
  ];
  state.members = [{ userId: "qa", projectId: "p2" }];
});

describe("loadAssistantViewer", () => {
  it("limits a qa user to their memberships", async () => {
    expect(await loadAssistantViewer("qa")).toEqual({
      userId: "qa",
      orgRole: "qa",
      projectIds: ["p2"],
      canManageKnowledge: false,
      scope: {
        userId: "qa",
        orgRole: "qa",
        projectRoles: { p2: "qa" },
        seesAllProjects: false,
      },
    });
  });

  it("gives an admin every project and knowledge management", async () => {
    expect(await loadAssistantViewer("admin")).toMatchObject({
      orgRole: "admin",
      projectIds: "all",
      canManageKnowledge: true,
    });
  });

  it("normalizes an unknown role to staff with no projects", async () => {
    expect(await loadAssistantViewer("weird")).toMatchObject({
      orgRole: "staff",
      projectIds: [],
    });
  });

  it("throws for an unknown or banned user", async () => {
    await expect(loadAssistantViewer("ghost")).rejects.toBeInstanceOf(
      AssistantViewerError
    );
    await expect(loadAssistantViewer("banned")).rejects.toMatchObject({
      reason: "banned",
    });
  });

  it("treats an expired ban as lifted", async () => {
    expect((await loadAssistantViewer("expired-ban")).userId).toBe(
      "expired-ban"
    );
  });
});

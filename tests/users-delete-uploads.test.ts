import { beforeEach, describe, expect, it, vi } from "vitest";

// Deleting a user removes the objects of their assistant uploads: the rows
// go with the user (ON DELETE CASCADE), the stored objects are removed after
// the delete, and one that cannot be removed never fails the delete.

const events = vi.hoisted(() => ({
  log: [] as string[],
  failDelete: new Set<string>(),
}));

vi.mock("@/lib/db", () => {
  const select = () => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () =>
      Object.assign(
        Promise.resolve([
          { id: "u2", name: "Dana", email: "dana@acme.test" },
          { id: "u3", name: "Eko", email: "eko@acme.test" },
        ]),
        chain
      );
    chain.limit = async () => [{ name: "Dana", email: "dana@acme.test" }];
    return chain;
  };
  return { db: { select } };
});
vi.mock("@/lib/assistant/file-store", () => ({
  uploadStorageKeysOfUser: vi.fn(async (userId: string) => {
    events.log.push(`keys:${userId}`);
    return [`assistant/${userId}/a`, `assistant/${userId}/b`];
  }),
  removeStoredUpload: vi.fn(async (key: string) => {
    events.log.push(`remove:${key}`);
  }),
}));
vi.mock("@/lib/authz", () => ({
  requireOrgPermission: async () => ({
    user: { id: "me", name: "Admin", role: "admin" },
  }),
  requireProjectPermission: vi.fn(),
  projectScope: vi.fn(),
}));
vi.mock("@/lib/admins", () => ({ listActiveAdminIds: async () => ["me"] }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendInvitationEmail: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  ALLOWED_EMAIL_DOMAIN: "acme.test",
  isAllowedEmail: () => true,
  auth: {
    $context: Promise.resolve({
      internalAdapter: {
        deleteUser: async (id: string) => {
          if (events.failDelete.has(id)) throw new Error("nope");
          events.log.push(`delete:${id}`);
        },
      },
    }),
  },
}));
vi.mock("@/lib/auth-session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/assignees", () => ({ assignableUsersWhere: vi.fn() }));
vi.mock("@/server/context", () => ({ getLocale: () => "en" }));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

import { bulkDeleteUsers, deleteUser } from "@/server/services/users";

beforeEach(() => {
  events.log.length = 0;
  events.failDelete.clear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("deleting a user removes their uploaded objects", () => {
  it("reads the keys before the delete and removes the objects after", async () => {
    const result = await deleteUser("u2");
    expect(result.success).toBe(true);
    expect(events.log).toEqual([
      "keys:u2",
      "delete:u2",
      "remove:assistant/u2/a",
      "remove:assistant/u2/b",
    ]);
  });

  it("does the same per user of a bulk delete, never for a failed one", async () => {
    events.failDelete.add("u3");
    const result = await bulkDeleteUsers(["u2", "u3", "me"]);
    expect(result).toMatchObject({ success: true, deleted: 1 });
    expect(events.log).toEqual([
      "keys:u2",
      "delete:u2",
      "remove:assistant/u2/a",
      "remove:assistant/u2/b",
      "keys:u3",
    ]);
  });
});

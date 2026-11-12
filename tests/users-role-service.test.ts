import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  writes: [] as { op: string; table: unknown }[],
}));

vi.mock("@/lib/db", () => {
  const select = () => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = async () => [];
    chain.orderBy = async () => [];
    return chain;
  };
  const write = (op: string) => (table: unknown) => {
    db.writes.push({ op, table });
    const chain: Record<string, unknown> = {};
    chain.set = () => chain;
    chain.values = async () => undefined;
    chain.where = () => Object.assign(Promise.resolve(), chain);
    chain.returning = async () => [{ id: "u2" }];
    return chain;
  };
  const writers = {
    insert: write("insert"),
    update: write("update"),
    delete: write("delete"),
  };
  return {
    db: {
      select,
      ...writers,
      transaction: async (fn: (tx: typeof writers) => Promise<void>) =>
        fn(writers),
    },
  };
});
vi.mock("@/lib/authz", () => ({
  requireOrgPermission: async () => ({
    user: { id: "me", name: "Admin", role: "admin" },
  }),
  requireProjectPermission: vi.fn(),
  projectScope: vi.fn(),
}));
vi.mock("@/lib/admins", () => ({
  listActiveAdminIds: async () => ["me", "u2"],
}));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendInvitationEmail: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  ALLOWED_EMAIL_DOMAIN: "acme.test",
  isAllowedEmail: () => true,
  auth: {},
}));
vi.mock("@/lib/auth-session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/assignees", () => ({ assignableUsersWhere: vi.fn() }));
vi.mock("@/server/context", () => ({ getLocale: () => "en" }));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

import * as schema from "@/lib/db/schema";
import { ORG_ROLES } from "@/lib/permissions";
import { inviteUser, updateUserRole } from "@/server/services/users";

beforeEach(() => {
  db.writes.length = 0;
});

describe("changing a role", () => {
  it("demoting an admin to qa touches only the users row", async () => {
    const result = await updateUserRole({ userId: "u2", role: "qa" });
    expect(result.success).toBe(true);
    expect(db.writes.map((w) => w.table)).toEqual([schema.users]);
    expect(db.writes.some((w) => w.table === schema.projectMembers)).toBe(
      false
    );
  });
});

describe("inviting", () => {
  it.each(["member", "viewer", "", "toString"])(
    "refuses to invite with role %j",
    async (role) => {
      const result = await inviteUser({
        email: "new@acme.test",
        name: "New",
        role,
      });
      expect(result).toEqual({ success: false, message: "invalidInput" });
      expect(db.writes).toEqual([]);
    }
  );

  it("invites with each of the five roles", async () => {
    for (const role of ORG_ROLES) {
      const result = await inviteUser({
        email: `${role}@acme.test`,
        name: role,
        role,
      });
      expect(result.success).toBe(true);
    }
  });
});

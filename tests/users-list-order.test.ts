import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ orderBy: [] as unknown[] }));

vi.mock("@/lib/db", () => {
  const select = () => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.leftJoin = () => chain;
    chain.groupBy = () => chain;
    chain.orderBy = async (...args: unknown[]) => {
      db.orderBy = args;
      return [];
    };
    return chain;
  };
  return { db: { select } };
});
vi.mock("@/lib/authz", () => ({
  requireOrgPermission: async () => ({
    user: { id: "me", name: "Admin", role: "admin" },
  }),
  requireProjectPermission: vi.fn(),
  projectScope: vi.fn(),
}));
vi.mock("@/lib/admins", () => ({ listActiveAdminIds: async () => [] }));
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
import { listUsers } from "@/server/services/users";

describe("listUsers order", () => {
  it("lists users by name", async () => {
    await listUsers();
    expect(db.orderBy).toHaveLength(1);
    expect(db.orderBy[0]).toBe(schema.users.name);
  });
});

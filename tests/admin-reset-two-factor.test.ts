import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: {
    user: { id: "admin1", name: "Admin", role: "admin" },
    session: { signInMethod: "passkey" as string | null },
  },
  target: { name: "Dana", twoFactorEnabled: true } as {
    name: string;
    twoFactorEnabled: boolean;
  } | null,
  writes: [] as { op: string; table: unknown; set?: unknown }[],
  activity: [] as unknown[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => mocks.session,
  getServerSession: async () => mocks.session,
}));
vi.mock("@/lib/db", () => {
  const select = () => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = async () => (mocks.target ? [mocks.target] : []);
    return chain;
  };
  const write = (op: string) => (table: unknown) => {
    const entry: { op: string; table: unknown; set?: unknown } = { op, table };
    mocks.writes.push(entry);
    const chain: Record<string, unknown> = {};
    chain.set = (values: unknown) => {
      entry.set = values;
      return chain;
    };
    chain.where = () => Object.assign(Promise.resolve(), chain);
    return chain;
  };
  const writers = { update: write("update"), delete: write("delete") };
  return {
    db: {
      select,
      ...writers,
      transaction: async (fn: (tx: typeof writers) => Promise<void>) =>
        fn(writers),
    },
  };
});
vi.mock("@/lib/activity", () => ({
  recordActivity: async (entry: unknown) => {
    mocks.activity.push(entry);
  },
}));
vi.mock("@/lib/admins", () => ({ listActiveAdminIds: async () => [] }));
vi.mock("@/lib/email/send", () => ({ sendInvitationEmail: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  ALLOWED_EMAIL_DOMAIN: "acme.test",
  isAllowedEmail: () => true,
  auth: {},
}));
vi.mock("@/lib/assignees", () => ({ assignableUsersWhere: vi.fn() }));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

import { ForbiddenError } from "@/lib/authz";
import * as schema from "@/lib/db/schema";
import { STRONG_SIGN_IN_CODE } from "@/lib/sign-in-method";
import { resetTwoFactor } from "@/server/services/users";

function as(role: string, signInMethod: string | null) {
  mocks.session = {
    user: { id: "admin1", name: "Admin", role },
    session: { signInMethod },
  };
}

beforeEach(() => {
  as("admin", "passkey");
  mocks.target = { name: "Dana", twoFactorEnabled: true };
  mocks.writes.length = 0;
  mocks.activity.length = 0;
});

describe("resetTwoFactor", () => {
  it("refuses a caller without user:update", async () => {
    as("qa", "passkey");
    await expect(resetTwoFactor("u2")).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.writes).toEqual([]);
  });

  it("refuses a weak session with the coded 403", async () => {
    as("admin", "password");
    await expect(resetTwoFactor("u2")).rejects.toMatchObject({
      status: 403,
      code: STRONG_SIGN_IN_CODE,
    });
    expect(mocks.writes).toEqual([]);
  });

  it("removes the secret, clears the flag, revokes sessions and logs it", async () => {
    await resetTwoFactor("u2");
    expect(mocks.writes.map((w) => [w.op, w.table])).toEqual([
      ["delete", schema.twoFactors],
      ["update", schema.users],
      ["delete", schema.sessions],
    ]);
    expect(mocks.writes[1]?.set).toMatchObject({ twoFactorEnabled: false });
    expect(mocks.activity).toEqual([
      expect.objectContaining({
        actorId: "admin1",
        action: "auth.two_factor_reset",
        data: { target: "Dana" },
      }),
    ]);
  });

  it("refuses to reset your own two-factor", async () => {
    await expect(resetTwoFactor("admin1")).rejects.toMatchObject({
      status: 400,
    });
    expect(mocks.writes).toEqual([]);
    expect(mocks.activity).toEqual([]);
  });

  it("is a silent no-op when the user has no two-factor", async () => {
    mocks.target = { name: "Dana", twoFactorEnabled: false };
    await resetTwoFactor("u2");
    expect(mocks.writes).toEqual([]);
    expect(mocks.activity).toEqual([]);
  });

  it("is a no-op for an unknown user", async () => {
    mocks.target = null;
    await resetTwoFactor("u2");
    expect(mocks.writes).toEqual([]);
    expect(mocks.activity).toEqual([]);
  });
});

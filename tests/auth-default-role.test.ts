import { describe, expect, it, vi } from "vitest";

// A user nobody assigned a role to (a first Microsoft sign-in that
// self-provisions an account) lands on staff: the real better-auth admin
// plugin as lib/auth configures it, run through its own user-create hook.

vi.mock("@/lib/db", () => ({ db: {}, pgClient: vi.fn() }));

const { auth } = await import("@/lib/auth");
const schema = await import("@/lib/db/schema");

type CreateHook = (user: Record<string, unknown>) => Promise<{
  data: Record<string, unknown>;
}>;

function adminCreateHook(): CreateHook {
  const plugin = auth.options.plugins?.find((p) => p.id === "admin") as
    | { init: (ctx: unknown) => { options: unknown } }
    | undefined;
  if (!plugin) throw new Error("admin plugin not configured");
  const { options } = plugin.init({}) as {
    options: { databaseHooks: { user: { create: { before: CreateHook } } } };
  };
  return options.databaseHooks.user.create.before;
}

describe("the default role", () => {
  it("is staff for a user created without a role", async () => {
    const { data } = await adminCreateHook()({
      name: "New",
      email: "new@example.com",
    });
    expect(data.role).toBe("staff");
  });

  it("keeps a role the caller set (an invitation's)", async () => {
    const { data } = await adminCreateHook()({
      name: "New",
      email: "new@example.com",
      role: "ba",
    });
    expect(data.role).toBe("ba");
  });

  // The database floor for a row written without a role (the migration that
  // sets it is checked on a real Postgres in read-cores-org-scratch).
  it("is the users and invitations column default", () => {
    expect(schema.users.role.default).toBe("staff");
    expect(schema.invitations.role.default).toBe("staff");
  });
});

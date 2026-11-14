process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  signInMethod: "password" as string | null,
}));

vi.mock("@/lib/authz", async (importOriginal) => ({
  // Real assertStrongSession; only the project lookup is replaced.
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  requireProjectPermission: vi.fn(async () => ({
    session: {
      user: { id: "u1", role: "engineer" },
      session: { signInMethod: state.signInMethod },
    },
    role: "engineer",
    projectId: "p1",
  })),
}));

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

vi.mock("@/lib/variables/repository", () => ({
  getEnvironmentContext: vi.fn(async () => ({
    id: "e1",
    name: "prod",
    envFileManaged: true,
    appId: null,
  })),
  listVariables: vi.fn(async () => [
    {
      id: "v1",
      name: "TOKEN",
      kind: "secret",
      value: encryptSecret("hunter2"),
      escrow: false,
      updatedBy: null,
      updatedByName: null,
    },
  ]),
}));

const { encryptSecret } = await import("@/lib/secrets");
const { listVariables } = await import("@/server/services/variables");

describe("listVariables reveal needs a strong sign-in", () => {
  beforeEach(() => {
    state.signInMethod = "password";
    activity.recordActivity.mockClear();
  });

  it("refuses a password session with the coded 403 and records nothing", async () => {
    const error = await listVariables("e1", { reveal: true }).catch((e) => e);
    expect(error).toMatchObject({
      status: 403,
      code: "strong_sign_in_required",
    });
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("still lists the masked values for a password session", async () => {
    const result = await listVariables("e1", { reveal: false });
    expect(result.variables).toHaveLength(1);
    expect(result.variables[0]?.value).toBeNull();
  });

  it("lets a passkey session reveal and records it", async () => {
    state.signInMethod = "passkey";
    const result = await listVariables("e1", { reveal: true });
    expect(result.variables[0]?.value).toBe("hunter2");
    expect(activity.recordActivity).toHaveBeenCalledTimes(1);
  });
});

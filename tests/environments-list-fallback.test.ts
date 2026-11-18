import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";

// listEnvironments resolves the caller's scope first: a failed lookup (the
// database) still answers an empty list, as before the scope split; an auth
// refusal still propagates.

const state = vi.hoisted(() => ({ error: null as unknown }));

vi.mock("@/lib/access-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/access-scope")>()),
  accessScopeFromSession: async () => {
    throw state.error;
  },
}));

const { listEnvironments } = await import("@/server/services/environments");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("listEnvironments", () => {
  it("answers [] when the access lookup fails", async () => {
    state.error = new Error("connection refused");
    expect(await listEnvironments()).toEqual([]);
  });

  it("propagates a 401 without a session", async () => {
    state.error = new HTTPException(401, { message: "Unauthorized" });
    await expect(listEnvironments()).rejects.toMatchObject({ status: 401 });
  });
});

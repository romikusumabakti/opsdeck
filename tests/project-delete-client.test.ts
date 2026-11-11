import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/web/api/client";

// The project delete answers 409 for two reasons; only the escrow one may be
// confirmed by an admin, so the client tells them apart by code.
const hono = vi.hoisted(() => ({ error: null as unknown }));
vi.mock("@/web/api/client", async (importOriginal) => {
  const { ApiError } =
    await importOriginal<typeof import("@/web/api/client")>();
  // Any route's $post: parseResponse below decides the outcome.
  const route = { $post: async () => new Response() };
  const routes = new Proxy({}, { get: () => route });
  return {
    ApiError,
    api: { api: new Proxy({}, { get: () => routes }) },
    orFailure: vi.fn(),
  };
});
vi.mock("hono/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  parseResponse: async () => {
    throw hono.error;
  },
}));

const { removeProject } = await import("@/web/api/project-catalog");
const ID = "0197f3a0-1b2c-7def-8000-0123456789f1";

describe("removeProject (client)", () => {
  it("flags an escrow refusal as confirmable", async () => {
    hono.error = new ApiError(409, "escrow", "projectHasEscrowedVariables");
    expect(await removeProject(ID)).toEqual({
      success: false,
      message: "escrow",
      escrowed: true,
    });
  });

  it("does not offer the escrow confirmation for a project with releases", async () => {
    hono.error = new ApiError(409, "has releases", "projectHasReleases");
    expect(await removeProject(ID)).toEqual({
      success: false,
      message: "has releases",
      escrowed: false,
    });
  });
});

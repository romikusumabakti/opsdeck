import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ signedIn: true }));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => {
    if (!session.signedIn) {
      const { HTTPException } = await import("hono/http-exception");
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    return { user: { id: "user-1", role: "engineer" } };
  }),
  getServerSession: vi.fn(async () => null),
}));

import { app } from "@/server/app";

// A SPA bundle cached from before the milestones removal still requests this
// path; it must answer an empty list rather than 404.
describe("GET /api/milestones/list-milestones compatibility stub", () => {
  beforeEach(() => {
    session.signedIn = true;
  });

  it("returns 200 [] for a signed-in caller", async () => {
    const res = await app.request(
      "/api/milestones/list-milestones?projectId=0197f3a0-1b2c-7def-8000-0123456789a1"
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("requires a session", async () => {
    session.signedIn = false;
    const res = await app.request("/api/milestones/list-milestones");
    expect(res.status).toBe(401);
  });
});

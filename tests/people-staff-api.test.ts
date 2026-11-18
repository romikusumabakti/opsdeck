import { beforeEach, describe, expect, it, vi } from "vitest";

// Staff has no user:list right and no project: the people list and the person
// page (which carries project data) refuse it before any query runs.

const ID = "0197f3a0-1b2c-7def-8000-0000000000c1";
const state = vi.hoisted(() => ({ role: "staff", reached: 0 }));

vi.mock("@/lib/db", () => {
  const untouchable = new Proxy(
    {},
    {
      get(_target, key) {
        state.reached++;
        throw new Error(`db.${String(key)} reached`);
      },
    }
  );
  return { db: untouchable, pgClient: vi.fn() };
});
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => {
  const current = async () => ({
    user: { id: "u1", role: state.role },
    session: { signInMethod: "passkey" },
  });
  return { requireSession: current, getServerSession: current };
});

const { app } = await import("@/server/app");

beforeEach(() => {
  state.role = "staff";
  state.reached = 0;
});

describe("people API for staff", () => {
  it.each(["/api/users/people", `/api/users/${ID}/person`])(
    "refuses %s with 403 and no query",
    async (path) => {
      expect((await app.request(path)).status).toBe(403);
      expect(state.reached).toBe(0);
    }
  );

  it("lets a qa past the guard (control)", async () => {
    state.role = "qa";
    const res = await app.request("/api/users/people");
    expect(res.status).not.toBe(403);
    expect(state.reached).toBeGreaterThan(0);
  });
});

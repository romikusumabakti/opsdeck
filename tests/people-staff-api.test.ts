import { beforeEach, describe, expect, it, vi } from "vitest";

// Staff has no user:list right and no project. The people directory and the
// org-wide lists that exist to pick or bind something inside a project (apps,
// database hosts, cross-project assignees) refuse it before any query runs.
// A person's page stays open to it (My profile, author links): its project,
// issue and run lists are filtered to the viewer's projects, so they come out
// empty (tests/read-cores-org-scratch.test.ts checks that on a real database).

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

const REFUSED = [
  "/api/users/people",
  "/api/service-catalog",
  "/api/database-hosts",
  "/api/users/list-assignable-users-across-projects",
];

describe("org-wide lists for staff", () => {
  it.each(REFUSED)("refuses %s with 403 and no query", async (path) => {
    expect((await app.request(path)).status).toBe(403);
    expect(state.reached).toBe(0);
  });

  it.each(["unknown-role", "qa-ba"])(
    "refuses a role that floors to staff (%s)",
    async (role) => {
      state.role = role;
      for (const path of REFUSED) {
        expect((await app.request(path)).status).toBe(403);
      }
      expect(state.reached).toBe(0);
    }
  );

  it.each(["qa", "ba", "pm", "engineer", "observer"])(
    "lets %s past the guard (control)",
    async (role) => {
      state.role = role;
      for (const path of REFUSED) {
        state.reached = 0;
        const res = await app.request(path);
        expect(res.status, path).not.toBe(403);
        expect(state.reached, path).toBeGreaterThan(0);
      }
    }
  );

  it("lets staff open a person's page (own profile, author links)", async () => {
    const res = await app.request(`/api/users/${ID}/person`);
    expect(res.status).not.toBe(403);
    expect(state.reached).toBeGreaterThan(0);
  });
});

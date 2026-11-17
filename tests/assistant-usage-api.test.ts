import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  role: "admin" as string,
  // Results of the successive db.select() calls: rows, then month total.
  results: [] as unknown[][],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/authz", async () => {
  const { canOrg } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    requireOrgPermission: vi.fn(async (perms: Parameters<typeof canOrg>[1]) => {
      if (!canOrg(state.role as "admin", perms)) {
        throw new HTTPException(403, { message: "Forbidden" });
      }
      return { user: { id: "user-1", role: state.role } };
    }),
  };
});

// A chainable, awaitable query: every builder step returns it, awaiting it
// yields the next canned result.
vi.mock("@/lib/db", () => {
  function chain(result: unknown[]) {
    const q = Promise.resolve(result) as Promise<unknown[]> &
      Record<string, unknown>;
    for (const step of ["from", "innerJoin", "where", "groupBy", "orderBy"]) {
      q[step] = () => q;
    }
    return q;
  }
  return { db: { select: () => chain(state.results.shift() ?? []) } };
});

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { app } = await import("@/server/app");

const URL = "/api/assistant-settings/usage";

beforeEach(() => {
  state.role = "admin";
  state.results = [];
});

describe("GET /usage", () => {
  it("answers 403 without assistant:manage", async () => {
    state.role = "engineer";
    expect((await app.request(URL)).status).toBe(403);
  });

  it("returns per-day per-user rows with numeric totals", async () => {
    state.results = [
      [
        {
          day: "2026-11-16",
          userId: "u1",
          userName: "Ana",
          turns: 3,
          costUsd: "0.412300",
          estimated: 2,
        },
        {
          day: "2026-11-16",
          userId: "u2",
          userName: "Budi",
          turns: 1,
          costUsd: "0.100000",
          estimated: 0,
        },
      ],
      [{ total: "7.250000" }],
    ];
    const res = await app.request(`${URL}?from=2026-11-01&to=2026-11-16`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rows: [
        {
          day: "2026-11-16",
          userId: "u1",
          userName: "Ana",
          turns: 3,
          costUsd: 0.4123,
        },
        {
          day: "2026-11-16",
          userId: "u2",
          userName: "Budi",
          turns: 1,
          costUsd: 0.1,
        },
      ],
      totalUsd: 0.5123,
      monthToDateUsd: 7.25,
      estimatedRows: 2,
    });
  });

  it("defaults the range and handles an empty table", async () => {
    state.results = [[], []];
    const res = await app.request(URL);
    expect(await res.json()).toEqual({
      rows: [],
      totalUsd: 0,
      monthToDateUsd: 0,
      estimatedRows: 0,
    });
  });

  it("rejects bad dates, reversed ranges and ranges over 92 days", async () => {
    for (const qs of [
      "from=nope&to=2026-11-16",
      "from=2026-11-16&to=2026-11-01",
      "from=2026-01-01&to=2026-11-16",
    ]) {
      expect((await app.request(`${URL}?${qs}`)).status).toBe(400);
    }
  });
});

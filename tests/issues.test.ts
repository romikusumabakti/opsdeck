import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_STATUSES } from "@/lib/issue-query";

// The environment and project Issues pages open on "still needs work" (open +
// in progress), like the sidebar badge counts; the same list without a status
// filter (the issue detail's parent picker) still returns every status.

const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";

const state = vi.hoisted(() => ({
  wheres: [] as unknown[],
  rows: [] as { id: string; status: string }[],
}));

vi.mock("@/lib/authz", () => ({
  requireProjectPage: async () => undefined,
  projectScope: async () => undefined,
}));
vi.mock("@/lib/db", () => ({
  db: {
    // Applies the relational `where` to in-memory rows, so the assertion is on
    // what comes back, not on the shape of the query.
    query: {
      issues: {
        findMany: async ({
          where,
        }: {
          where: { status?: { in: string[] } };
        }) => {
          state.wheres.push(where);
          const allowed = where.status?.in;
          return state.rows.filter(
            (r) => !allowed || allowed.includes(r.status)
          );
        },
      },
    },
    select: () => ({
      from: () => ({ innerJoin: () => ({ where: async () => [] }) }),
    }),
  },
}));

import { listIssues } from "@/server/services/issues";

describe("listIssues", () => {
  beforeEach(() => {
    state.wheres = [];
    state.rows = [
      { id: "a", status: "open" },
      { id: "b", status: "in_progress" },
      { id: "c", status: "resolved" },
      { id: "d", status: "closed" },
    ];
  });

  it("env issues default to open: closed and resolved rows are excluded", async () => {
    const rows = await listIssues(PROJECT_ID, OPEN_STATUSES);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(state.wheres[0]).toEqual({
      projectId: PROJECT_ID,
      status: { in: ["open", "in_progress"] },
    });
  });

  it("returns every status when no statuses are given", async () => {
    const rows = await listIssues(PROJECT_ID);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(state.wheres[0]).toEqual({ projectId: PROJECT_ID });
  });
});

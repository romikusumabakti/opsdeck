import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm/sql";
import { describe, expect, it, vi } from "vitest";
import { MEMBERSHIP_VISIBLE_ROLES } from "@/lib/assignees";

// Staff (and every unknown role, which floors to it) gains nothing from a
// membership, so the Members picker never offers it. The database filters it,
// as lib/assignees does: an exact role match on the roles a membership opens a
// project to, so a junk or legacy role string matches nothing. Checked on a
// real database in tests/read-cores-org-scratch.test.ts.

const rows = vi.hoisted(() => ({
  value: [] as Record<string, unknown>[],
  where: null as unknown,
  fields: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = (cond: unknown) => {
    rows.where = cond;
    return chain;
  };
  chain.orderBy = async () => rows.value;
  return {
    db: {
      select: (fields: Record<string, unknown>) => {
        rows.fields = fields;
        return chain;
      },
    },
  };
});
vi.mock("@/lib/authz", () => ({
  requireProjectPermission: async () => ({}),
}));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

import { listMemberCandidates } from "@/server/services/project-members";

describe("listMemberCandidates", () => {
  it("filters staff out in SQL: non-banned users with a membership-visible role", async () => {
    rows.value = [
      { id: "a", name: "a", email: "a@example.invalid", image: null },
    ];
    const result = await listMemberCandidates("p1");
    expect(result.map((r) => r.id)).toEqual(["a"]);

    const query = new PgDialect().sqlToQuery(rows.where as SQL);
    expect(query.sql).toMatch(/"banned" = \$1/);
    expect(query.sql).toMatch(/"role" in \(/);
    expect(query.params).toEqual([false, ...MEMBERSHIP_VISIBLE_ROLES]);
    expect(query.params).not.toContain("staff");
    // The role is only filtered on, never read back.
    expect(Object.keys(rows.fields ?? {})).not.toContain("role");
  });

  it("the visible roles are every role but staff", () => {
    expect(MEMBERSHIP_VISIBLE_ROLES).toEqual([
      "admin",
      "infra",
      "engineer",
      "qa",
      "ba",
      "pm",
      "observer",
    ]);
  });
});

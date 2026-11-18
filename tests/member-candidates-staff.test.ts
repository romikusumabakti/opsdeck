import { describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({
  value: [] as {
    id: string;
    name: string;
    email: string;
    image: string | null;
    role: string | null;
  }[],
}));

vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = async () => rows.value;
  return { db: { select: () => chain } };
});
vi.mock("@/lib/authz", () => ({
  requireProjectPermission: async () => ({}),
}));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

import { listMemberCandidates } from "@/server/services/project-members";

const person = (id: string, role: string | null) => ({
  id,
  name: id,
  email: `${id}@example.invalid`,
  image: null,
  role,
});

describe("listMemberCandidates", () => {
  it("leaves out staff, including unknown roles that floor to staff", async () => {
    rows.value = [
      person("a", "engineer"),
      person("b", "staff"),
      person("c", "ba"),
      person("d", "legacy-role"),
      person("e", null),
      person("f", "observer"),
    ];
    const result = await listMemberCandidates("p1");
    expect(result.map((r) => r.id)).toEqual(["a", "c", "f"]);
    expect(Object.keys(result[0] ?? {})).not.toContain("role");
  });
});

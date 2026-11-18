import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

// The collection-visibility rule in lib/knowledge, without a database: the
// pure predicates, the SQL they build, and the session viewer. The SQL paths
// against a real Postgres are in knowledge-visibility-scratch.test.ts.

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; role: string } },
}));

vi.mock("@/lib/db", () => ({ db: {}, pgClient: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({
  getServerSession: async () => state.session,
  requireSession: async () => state.session,
}));

const {
  canViewCollection,
  canViewDoc,
  currentViewer,
  visibleCollections,
  visibleDocs,
} = await import("@/lib/knowledge");

const qa = { userId: "u-qa", role: "qa", canManage: false } as const;
const infra = { userId: "u-infra", role: "infra", canManage: false } as const;
const admin = { userId: "u-admin", role: "admin", canManage: true } as const;
const anonymous = { userId: null, role: null, canManage: false } as const;

const open = { visibleToRoles: [] as string[] };
const infraOnly = { visibleToRoles: ["infra"] };

describe("canViewCollection", () => {
  it("lets every role with knowledge:read see an unrestricted collection", () => {
    expect(canViewCollection(open, qa)).toBe(true);
    expect(canViewCollection(open, { ...qa, role: "staff" })).toBe(true);
    expect(canViewCollection(open, { ...qa, role: "observer" })).toBe(true);
  });

  it("lets only the listed roles and managers see a restricted collection", () => {
    expect(canViewCollection(infraOnly, infra)).toBe(true);
    expect(canViewCollection(infraOnly, qa)).toBe(false);
    expect(canViewCollection(infraOnly, admin)).toBe(true);
  });

  it("ignores unknown stored roles: they grant nothing", () => {
    expect(canViewCollection({ visibleToRoles: ["typo"] }, qa)).toBe(false);
    expect(canViewCollection({ visibleToRoles: ["typo"] }, admin)).toBe(true);
    expect(canViewCollection({ visibleToRoles: ["typo", "qa"] }, qa)).toBe(
      true
    );
  });

  it("shows nothing to a viewer without a role", () => {
    expect(canViewCollection(open, anonymous)).toBe(false);
  });
});

describe("canViewDoc", () => {
  const draft = { publishedAt: null, createdById: qa.userId };
  const published = { publishedAt: new Date(), createdById: "someone" };

  it("keeps the draft rule inside a visible collection", () => {
    expect(canViewDoc({ ...draft, collection: open }, qa)).toBe(true);
    expect(canViewDoc({ ...draft, collection: open }, infra)).toBe(false);
    expect(canViewDoc({ ...draft, collection: open }, admin)).toBe(true);
    expect(canViewDoc({ ...published, collection: open }, infra)).toBe(true);
  });

  it("lets collection visibility win over authorship and publishing", () => {
    expect(canViewDoc({ ...draft, collection: infraOnly }, qa)).toBe(false);
    expect(canViewDoc({ ...published, collection: infraOnly }, qa)).toBe(false);
    expect(canViewDoc({ ...published, collection: infraOnly }, infra)).toBe(
      true
    );
    expect(canViewDoc({ ...draft, collection: infraOnly }, admin)).toBe(true);
  });
});

describe("SQL predicates", () => {
  const dialect = new PgDialect();

  it("constrain nothing for a manager", () => {
    expect(visibleCollections(admin)).toBeUndefined();
    expect(visibleDocs(admin)).toBeUndefined();
  });

  it("bind the viewer's role into the collection rule", () => {
    const sql = visibleCollections(qa);
    if (!sql) throw new Error("expected a predicate");
    const q = dialect.sqlToQuery(sql);
    expect(q.sql).toContain("visible_to_roles");
    expect(q.params).toContain("qa");
  });

  it("fold the collection rule into the document rule", () => {
    const sql = visibleDocs(qa);
    if (!sql) throw new Error("expected a predicate");
    const q = dialect.sqlToQuery(sql);
    expect(q.sql).toContain("visible_to_roles");
    expect(q.sql).toContain("published_at");
    expect(q.params).toContain("qa");
    expect(q.params).toContain(qa.userId);
  });
});

describe("currentViewer", () => {
  it("fills the org role from the session", async () => {
    state.session = { user: { id: "u1", role: "infra" } };
    expect(await currentViewer()).toEqual({
      userId: "u1",
      role: "infra",
      canManage: false,
    });
  });

  it("floors an unknown stored role like the rest of the app", async () => {
    state.session = { user: { id: "u1", role: "maintainer" } };
    expect((await currentViewer()).role).toBe("staff");
  });

  it("has no role without a session", async () => {
    state.session = null;
    expect(await currentViewer()).toEqual({
      userId: null,
      role: null,
      canManage: false,
    });
  });
});

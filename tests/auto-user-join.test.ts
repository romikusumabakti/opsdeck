import { eq } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { runs, users } from "@/lib/db/schema";

vi.mock("@/lib/db", () => ({ db: {} }));

const { autoUserColumns, autoUserOn, autoUserRef, autoUsers } = await import(
  "@/lib/deploy/repository"
);

describe("auto user join", () => {
  it("resolves at most one user per run: a lateral subquery with limit 1", () => {
    const { sql } = new QueryBuilder()
      .select({ id: runs.id, ...autoUserColumns })
      .from(runs)
      .leftJoin(users, eq(users.id, runs.userId))
      .leftJoinLateral(autoUsers, autoUserOn)
      .toSQL();
    expect(sql).toMatch(
      /left join lateral \(select .* from "users" "matched_user"/
    );
    expect(sql).toContain(
      'lower("matched_user"."email") = lower("runs"."triggered_by")'
    );
    expect(sql).toContain('"runs"."user_id" is null');
    expect(sql).toMatch(
      /order by "matched_user"."id" limit \$\d+\) "auto_user" on true/
    );
  });
});

describe("autoUserRef", () => {
  it("builds a user ref from the joined columns", () => {
    expect(
      autoUserRef({
        autoUserId: "u1",
        autoUserName: "Romi",
        autoUserImage: null,
      })
    ).toEqual({ id: "u1", name: "Romi", image: null });
  });

  it("is null when no user matched", () => {
    expect(
      autoUserRef({ autoUserId: null, autoUserName: null, autoUserImage: null })
    ).toBeNull();
  });
});

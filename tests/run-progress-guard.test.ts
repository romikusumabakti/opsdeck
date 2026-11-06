import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// completeRun / failRun with { onlyIfStarted: true } (provision runs): the
// update is conditional on status = 'started', and a guarded call that
// changed nothing reports false and sends no failure notification. Unguarded
// calls (every other run kind) keep the plain update by id.

const fake = vi.hoisted(() => ({
  wheres: [] as unknown[],
  returned: [] as { id: string }[],
  usedReturning: false,
  selects: 0,
}));

vi.mock("@/lib/db", () => ({
  db: {
    update: () => ({
      set: () => ({
        where: (cond: unknown) => {
          fake.wheres.push(cond);
          return Object.assign(Promise.resolve(undefined), {
            returning: async () => {
              fake.usedReturning = true;
              return fake.returned;
            },
          });
        },
      }),
    }),
    select: () => {
      fake.selects++;
      return {
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      };
    },
  },
}));
vi.mock("@/lib/notifications", () => ({ notifyRunFailed: vi.fn() }));

const { completeRun, failRun } = await import("@/lib/run-progress");
const dialect = new PgDialect();
const rendered = (i: number) =>
  dialect.sqlToQuery(fake.wheres[i] as Parameters<PgDialect["sqlToQuery"]>[0]);

beforeEach(() => {
  fake.wheres = [];
  fake.returned = [];
  fake.usedReturning = false;
  fake.selects = 0;
});

describe("guarded run completion", () => {
  it("completes only a started run; a closed one reports false", async () => {
    await expect(completeRun("r1", { onlyIfStarted: true })).resolves.toBe(
      false
    );
    const q = rendered(0);
    expect(q.sql).toBe('(("runs"."id" = $1) and ("runs"."status" = $2))');
    expect(q.params).toEqual(["r1", "started"]);
    fake.returned = [{ id: "r1" }];
    await expect(completeRun("r1", { onlyIfStarted: true })).resolves.toBe(
      true
    );
  });

  it("a guarded failRun on a closed run neither changes it nor notifies", async () => {
    await expect(failRun("r1", "boom", { onlyIfStarted: true })).resolves.toBe(
      false
    );
    expect(rendered(0).params).toEqual(["r1", "started"]);
    expect(fake.selects).toBe(0);
  });

  it("unguarded calls keep the plain update by id", async () => {
    await completeRun("r1");
    await failRun("r1", "boom");
    expect(rendered(0).sql).toBe('"runs"."id" = $1');
    expect(rendered(1).sql).toBe('"runs"."id" = $1');
    expect(fake.usedReturning).toBe(false);
    // failRun still looks up the run to notify its initiator.
    expect(fake.selects).toBe(1);
  });
});

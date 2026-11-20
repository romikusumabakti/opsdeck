import { execFileSync, spawnSync } from "node:child_process";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessScope } from "@/lib/access-scope";
import * as schema from "@/lib/db/schema";

// The assistant's issue filters (IssueQuery: statuses, types, priorities,
// unassigned, reporter, environment, any-of labels, half-open date
// bounds) against a real Postgres through listAllIssuesFor. Same setup as
// issue-writes-scratch.test.ts: the local menara-postgres container, a
// scratch database migrated with `menara migrate` and dropped afterwards; no
// other database is touched. The job queue is mocked (no Valkey needed).
//
//   ISSUES_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/issue-list-filters-scratch.test.ts
const enabled = process.env.ISSUES_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "issue_list_filters_scratch";

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queue")>()),
  enqueue: async () => {},
}));

function psql(db: string, args: string[]) {
  return execFileSync(
    "podman",
    [
      "exec",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      db,
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("expected a row");
  return row;
}

const ADMIN = "00000000-0000-7000-8000-00000000e001";
const WULAN = "00000000-0000-7000-8000-00000000e002";

describe.skipIf(!enabled)("issue list filters on Postgres", () => {
  let client: ReturnType<typeof postgres>;
  let d: ReturnType<typeof drizzle>;
  let previousUrl: string | undefined;
  let scope: AccessScope;
  const ids = {
    acme: "",
    globex: "",
    env: "",
    bug: "",
    ui: "",
    perf: "",
  };
  const numbers = new Map<string, number>();

  const seed = async (
    name: string,
    values: Partial<typeof schema.issues.$inferInsert> = {}
  ) => {
    const n = numbers.size + 1;
    numbers.set(name, n);
    return one(
      await d
        .insert(schema.issues)
        .values({
          projectId: ids.acme,
          number: n,
          title: name,
          createdById: ADMIN,
          assigneeId: ADMIN,
          ...values,
        })
        .returning()
    ).id;
  };
  const titles = async (
    query: import("@/server/services/issues").IssueQuery
  ) => {
    const { listAllIssuesFor } = await import("@/server/services/issues");
    const page = await listAllIssuesFor(scope, { status: "all", ...query });
    return { total: page.total, titles: page.rows.map((r) => r.title).sort() };
  };

  beforeAll(async () => {
    const password = encodeURIComponent(
      execFileSync("podman", [
        "exec",
        CONTAINER,
        "printenv",
        "POSTGRES_PASSWORD",
      ])
        .toString()
        .trim()
    );
    const url = `postgres://postgres:${password}@127.0.0.1:5432/${DB_NAME}`;
    psql("postgres", [
      "-c",
      `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`,
      "-c",
      `CREATE DATABASE ${DB_NAME}`,
    ]);
    const result = spawnSync("bun", ["scripts/cli.ts", "migrate"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: url,
      },
    });
    if (result.status !== 0)
      throw new Error(`migrate failed: ${result.stderr}`);
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    client = postgres(url, {
      max: 1,
      onnotice: () => {},
      connection: { TimeZone: "UTC" },
    });
    d = drizzle({ client });

    for (const [id, name] of [
      [ADMIN, "admin"],
      [WULAN, "wulan"],
    ] as const) {
      await d.insert(schema.users).values({
        id,
        name,
        email: `${name}@example.com`,
        role: name === "admin" ? "admin" : "qa",
      });
    }
    scope = {
      userId: ADMIN,
      orgRole: "admin",
      projectRoles: {},
      seesAllProjects: true,
    };
    const project = async (key: string) =>
      one(
        await d.insert(schema.projects).values({ name: key, key }).returning()
      ).id;
    ids.acme = await project("ACME");
    ids.globex = await project("GLOBEX");
    ids.env = one(
      await d
        .insert(schema.environments)
        .values({ projectId: ids.acme, name: "UAT", slug: "uat" })
        .returning()
    ).id;
    const label = async (name: string) =>
      one(await d.insert(schema.labels).values({ name }).returning()).id;
    ids.bug = await label("scratch-bug");
    ids.ui = await label("scratch-ui");
    ids.perf = await label("scratch-perf");

    const a = await seed("a-open-bug-urgent", {
      status: "open",
      type: "bug",
      priority: "urgent",
      environmentId: ids.env,
      createdById: WULAN,
    });
    const b = await seed("b-progress-task-low", {
      status: "in_progress",
      type: "task",
      priority: "low",
      assigneeId: null,
    });
    await seed("c-closed-story-high", {
      status: "closed",
      type: "story",
      priority: "high",
    });
    const dd = await seed("d-resolved-bug-medium", {
      status: "resolved",
      type: "bug",
    });
    await seed("e-other-project", { projectId: ids.globex, number: 1 });
    await d.insert(schema.issueLabels).values([
      { issueId: a, labelId: ids.bug },
      { issueId: a, labelId: ids.ui },
      { issueId: b, labelId: ids.ui },
      { issueId: dd, labelId: ids.perf },
    ]);
    // Fixed timestamps for the date bounds.
    for (const [title, created] of [
      ["a-open-bug-urgent", "2026-11-18 00:00:00"],
      ["b-progress-task-low", "2026-11-19 00:00:00"],
      ["c-closed-story-high", "2026-11-20 00:00:00"],
      ["d-resolved-bug-medium", "2026-11-21 00:00:00"],
    ] as const) {
      await client`update issues set created_at = ${created}, updated_at = ${created}
        where title = ${title}`;
    }
  });

  afterAll(async () => {
    await client?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
  });

  it("filters by statuses, types, priorities, reporter, environment, labels any-of", async () => {
    expect(
      (await titles({ statuses: ["open", "in_progress"] })).titles
    ).toEqual(["a-open-bug-urgent", "b-progress-task-low", "e-other-project"]);
    // Wins over `status`; junk members are dropped, not an error.
    expect(
      (
        await titles({
          status: "closed",
          statuses: ["resolved", "nonsense" as never],
        })
      ).titles
    ).toEqual(["d-resolved-bug-medium"]);
    expect(
      (await titles({ types: ["bug"], projectId: ids.acme })).titles
    ).toEqual(["a-open-bug-urgent", "d-resolved-bug-medium"]);
    expect((await titles({ priorities: ["urgent", "low"] })).titles).toEqual([
      "a-open-bug-urgent",
      "b-progress-task-low",
    ]);
    expect((await titles({ createdById: WULAN })).titles).toEqual([
      "a-open-bug-urgent",
    ]);
    expect((await titles({ environmentId: ids.env })).titles).toEqual([
      "a-open-bug-urgent",
    ]);
    // Any of the labels, and an issue with two matching labels counts once.
    const labelled = await titles({ labelIds: [ids.bug, ids.ui] });
    expect(labelled).toEqual({
      total: 2,
      titles: ["a-open-bug-urgent", "b-progress-task-low"],
    });
  });

  it("date bounds are half-open", async () => {
    const day = (s: string) => new Date(`${s}T00:00:00Z`);
    expect(
      (
        await titles({
          createdFrom: day("2026-11-19"),
          createdTo: day("2026-11-21"),
          projectId: ids.acme,
        })
      ).titles
    ).toEqual(["b-progress-task-low", "c-closed-story-high"]);
    expect(
      (
        await titles({
          updatedFrom: day("2026-11-21"),
          projectId: ids.acme,
        })
      ).titles
    ).toEqual(["d-resolved-bug-medium"]);
    expect(
      (await titles({ updatedTo: day("2026-11-19"), projectId: ids.acme }))
        .titles
    ).toEqual(["a-open-bug-urgent"]);
  });

  it("unassigned", async () => {
    expect((await titles({ unassigned: true })).titles).toEqual([
      "b-progress-task-low",
    ]);
  });

  it("total counts before limit", async () => {
    const { listAllIssuesFor } = await import("@/server/services/issues");
    const page = await listAllIssuesFor(scope, {
      status: "all",
      projectId: ids.acme,
      limit: 2,
      offset: 1,
      sort: "createdAt",
      desc: false,
    });
    expect(page.total).toBe(4);
    expect(page.rows.map((r) => r.title)).toEqual([
      "b-progress-task-low",
      "c-closed-story-high",
    ]);
  });
});

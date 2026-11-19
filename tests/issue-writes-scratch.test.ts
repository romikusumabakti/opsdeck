import { execFileSync, spawnSync } from "node:child_process";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { HTTPException } from "hono/http-exception";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";

// Issue writes (server/services/issues.ts) against a real Postgres: the
// conflict precondition on updateIssue (`expectedUpdatedAt`, evaluated in the
// UPDATE's WHERE at millisecond precision, so a row whose updated_at came from
// the database default with microseconds still matches its ISO round-trip),
// the one-request create with status, labels and parent, and the create
// form's options. Same setup as knowledge-writes-scratch.test.ts: the local
// menara-postgres container, a scratch database migrated with
// `menara migrate` and dropped afterwards; no other database is touched.
// The job queue is mocked (no Valkey needed).
//
//   ISSUES_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/issue-writes-scratch.test.ts
const enabled = process.env.ISSUES_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "issue_writes_scratch";

const session = vi.hoisted(() => ({
  user: { id: "", role: "admin" },
}));
const queue = vi.hoisted(() => ({ jobs: [] as unknown[] }));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => {
  const current = async () => ({
    user: session.user,
    session: { signInMethod: "passkey" },
  });
  return { requireSession: current, getServerSession: current };
});
vi.mock("@/lib/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queue")>()),
  enqueue: async (name: string, data: unknown) => {
    queue.jobs.push({ name, data });
  },
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

// What a refused call answers: the HTTP status and code it throws.
async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    if (error instanceof HTTPException) {
      return {
        status: error.status,
        code: (error as { code?: string }).code,
      };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

const ADMIN = "00000000-0000-7000-8000-00000000d001";
const OBSERVER = "00000000-0000-7000-8000-00000000d002";
const QA = "00000000-0000-7000-8000-00000000d003";
const MISSING = "00000000-0000-7000-8000-0000000000ff";

describe.skipIf(!enabled)("issue writes on Postgres", () => {
  let client: ReturnType<typeof postgres>;
  let d: ReturnType<typeof drizzle>;
  let previousUrl: string | undefined;
  const ids = {
    project: "",
    other: "",
    env: "",
    bugLabel: "",
    uiLabel: "",
    epic: "",
    closed: "",
    foreign: "",
  };

  const issueRow = async (id: string) =>
    one(await d.select().from(schema.issues).where(eq(schema.issues.id, id)));
  const issueCount = async (projectId: string) =>
    (
      await d
        .select()
        .from(schema.issues)
        .where(eq(schema.issues.projectId, projectId))
    ).length;
  const activityFor = async (entityId: string) =>
    d
      .select()
      .from(schema.activityLog)
      .where(eq(schema.activityLog.entityId, entityId));
  // An issue whose updated_at comes from the column default (now(), with
  // microseconds), like the rows Jira sync and older writes leave behind.
  const seedIssue = async (
    projectId: string,
    number: number,
    values: Partial<typeof schema.issues.$inferInsert> = {}
  ) =>
    one(
      await d
        .insert(schema.issues)
        .values({
          projectId,
          number,
          title: `Issue ${number}`,
          createdById: ADMIN,
          ...values,
        })
        .returning()
    ).id;
  const as = (id: string, role: string) => {
    session.user = { id, role };
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
    // lib/db reads DATABASE_URL lazily, on the first query.
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    // UTC like the app's own connections (lib/db), so the column defaults
    // and what the app writes agree.
    client = postgres(url, {
      max: 1,
      onnotice: () => {},
      connection: { TimeZone: "UTC" },
    });
    d = drizzle({ client });

    for (const [id, role] of [
      [ADMIN, "admin"],
      [OBSERVER, "observer"],
      [QA, "qa"],
    ] as const) {
      await d
        .insert(schema.users)
        .values({ id, name: role, email: `${role}@example.com`, role });
    }
    const project = async (key: string) =>
      one(
        await d.insert(schema.projects).values({ name: key, key }).returning()
      ).id;
    ids.project = await project("ACME");
    ids.other = await project("GLOBEX");
    ids.env = one(
      await d
        .insert(schema.environments)
        .values({ projectId: ids.project, name: "ACME dev", slug: "dev" })
        .returning()
    ).id;
    const label = async (name: string) =>
      one(await d.insert(schema.labels).values({ name }).returning()).id;
    ids.bugLabel = await label("regression");
    ids.uiLabel = await label("ui");
    ids.epic = await seedIssue(ids.project, 1, {
      title: "Checkout epic",
      jiraIssueId: "10001",
    });
    ids.closed = await seedIssue(ids.project, 2, {
      title: "Old closed issue",
      status: "closed",
    });
    ids.foreign = await seedIssue(ids.other, 1, { title: "Other project" });
  });

  afterAll(async () => {
    await client?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
  });

  describe("updateIssue precondition", () => {
    it("a fresh updatedAt (DB default, microseconds) saves and returns the new one", async () => {
      const { listIssues, updateIssue } = await import(
        "@/server/services/issues"
      );
      as(ADMIN, "admin");
      const id = await seedIssue(ids.project, 10, { jiraIssueId: "10010" });
      // The database keeps microseconds (the column default, Jira sync);
      // the client only ever sees the ISO string (milliseconds) the API
      // returned.
      await client`update issues set updated_at = '2026-01-02 03:04:05.123456'
        where id = ${id}`;
      const seen = (await listIssues(ids.project)).find((i) => i.id === id);
      const expectedUpdatedAt = new Date(seen?.updatedAt ?? "").toISOString();
      queue.jobs = [];

      const res = await updateIssue(id, {
        description: "Steps to reproduce",
        expectedUpdatedAt,
      });

      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data.description).toBe("Steps to reproduce");
      expect(res.data.updatedAt.getTime()).toBeGreaterThan(
        new Date(expectedUpdatedAt).getTime()
      );
      // The returned updatedAt is the next precondition.
      const again = await updateIssue(id, {
        title: "Renamed",
        expectedUpdatedAt: res.data.updatedAt.toISOString(),
      });
      expect(again.success).toBe(true);
      expect(queue.jobs).toHaveLength(2);
    });

    it("a stale updatedAt is refused with 409 issueChanged and nothing is written", async () => {
      const { updateIssue } = await import("@/server/services/issues");
      as(ADMIN, "admin");
      const id = await seedIssue(ids.project, 11, { jiraIssueId: "10011" });
      const before = await issueRow(id);
      const stale = new Date(before.updatedAt.getTime() - 60_000).toISOString();
      queue.jobs = [];

      expect(
        await refusal(
          updateIssue(id, {
            title: "Overwritten",
            description: "Lost text",
            status: "resolved",
            expectedUpdatedAt: stale,
          })
        )
      ).toEqual({ status: 409, code: "issueChanged" });

      const after = await issueRow(id);
      expect(after.title).toBe(before.title);
      expect(after.description).toBe(before.description);
      expect(after.status).toBe(before.status);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(await activityFor(id)).toHaveLength(0);
      expect(queue.jobs).toHaveLength(0);
    });

    it("the second of two editors holding the same updatedAt gets 409", async () => {
      const { updateIssue } = await import("@/server/services/issues");
      as(ADMIN, "admin");
      const id = await seedIssue(ids.project, 12);
      const seen = (await issueRow(id)).updatedAt.toISOString();

      const first = await updateIssue(id, {
        description: "First editor",
        expectedUpdatedAt: seen,
      });
      expect(first.success).toBe(true);
      expect(
        await refusal(
          updateIssue(id, {
            description: "Second editor",
            expectedUpdatedAt: seen,
          })
        )
      ).toEqual({ status: 409, code: "issueChanged" });
      expect((await issueRow(id)).description).toBe("First editor");
    });

    it("two concurrent saves with the same updatedAt: exactly one wins", async () => {
      const { updateIssue } = await import("@/server/services/issues");
      as(ADMIN, "admin");
      const id = await seedIssue(ids.project, 17);
      const seen = (await issueRow(id)).updatedAt.toISOString();
      const outcomes = await Promise.allSettled(
        ["Editor A", "Editor B"].map((description) =>
          updateIssue(id, { description, expectedUpdatedAt: seen })
        )
      );
      const won = outcomes.filter(
        (o) => o.status === "fulfilled" && o.value.success
      );
      const refused = outcomes.filter(
        (o) =>
          o.status === "rejected" &&
          (o.reason as { code?: string }).code === "issueChanged"
      );
      expect(won).toHaveLength(1);
      expect(refused).toHaveLength(1);
      const kept = (await issueRow(id)).description;
      const winner = won[0];
      expect(
        winner?.status === "fulfilled" && winner.value.success
          ? winner.value.data.description
          : undefined
      ).toBe(kept);
    });

    it("over HTTP the stale save answers 409 with code issueChanged", async () => {
      const { app } = await import("@/server/app");
      as(ADMIN, "admin");
      const id = await seedIssue(ids.project, 16);
      const seen = (await issueRow(id)).updatedAt.toISOString();
      const post = (description: string) =>
        app.request("/api/issues/update-issue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            data: { description, expectedUpdatedAt: seen },
          }),
        });

      const first = await post("First editor");
      expect(first.status).toBe(200);
      const saved = (await first.json()) as {
        success: boolean;
        data: { updatedAt: string };
      };
      expect(saved.success).toBe(true);
      expect(new Date(saved.data.updatedAt).getTime()).toBeGreaterThan(
        new Date(seen).getTime()
      );
      const second = await post("Second editor");
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({
        code: "issueChanged",
        error: expect.any(String),
      });
      expect((await issueRow(id)).description).toBe("First editor");
    });

    it("without expectedUpdatedAt an update still saves (pickers, status)", async () => {
      const { updateIssue } = await import("@/server/services/issues");
      as(ADMIN, "admin");
      const id = await seedIssue(ids.project, 13);
      const res = await updateIssue(id, { priority: "high" });
      expect(res.success).toBe(true);
      expect((await issueRow(id)).priority).toBe("high");
    });

    it("an invalid expectedUpdatedAt is invalid issue data", async () => {
      const { updateIssue } = await import("@/server/services/issues");
      as(ADMIN, "admin");
      const id = await seedIssue(ids.project, 14);
      const res = await updateIssue(id, {
        title: "x",
        expectedUpdatedAt: "yesterday",
      });
      expect(res).toEqual({ success: false, message: "Invalid issue data" });
      expect((await issueRow(id)).title).toBe("Issue 14");
    });

    it("refuses a caller without issue:write before the precondition, as today", async () => {
      const { updateIssue } = await import("@/server/services/issues");
      const id = await seedIssue(ids.project, 15);
      as(OBSERVER, "observer");
      expect(
        await refusal(
          updateIssue(id, {
            title: "x",
            expectedUpdatedAt: new Date(0).toISOString(),
          })
        )
      ).toMatchObject({ status: 403 });
      expect((await issueRow(id)).title).toBe("Issue 15");
    });
  });

  describe("createIssue with status, labels and parent", () => {
    it("creates everything in one request", async () => {
      const { createIssue } = await import("@/server/services/issues");
      as(ADMIN, "admin");
      const res = await createIssue({
        projectId: ids.project,
        title: "Payment button misaligned",
        status: "in_progress",
        labelIds: [ids.bugLabel, ids.uiLabel, ids.bugLabel],
        parentId: ids.epic,
        environmentId: ids.env,
        assigneeId: ADMIN,
        priority: "high",
        type: "bug",
      });

      expect(res.success).toBe(true);
      if (!res.success) return;
      const row = await issueRow(res.data.id);
      expect(row).toMatchObject({
        status: "in_progress",
        parentId: ids.epic,
        environmentId: ids.env,
        assigneeId: ADMIN,
        priority: "high",
        type: "bug",
      });
      const attached = await d
        .select({ labelId: schema.issueLabels.labelId })
        .from(schema.issueLabels)
        .where(eq(schema.issueLabels.issueId, res.data.id));
      expect(attached.map((a) => a.labelId).sort()).toEqual(
        [ids.bugLabel, ids.uiLabel].sort()
      );
      expect((await activityFor(res.data.id)).map((a) => a.action)).toEqual([
        "issue.created",
      ]);
    });

    it("defaults to open with no labels", async () => {
      const { createIssue } = await import("@/server/services/issues");
      as(ADMIN, "admin");
      const res = await createIssue({ projectId: ids.project, title: "Plain" });
      expect(res.success).toBe(true);
      if (!res.success) return;
      expect((await issueRow(res.data.id)).status).toBe("open");
    });

    it("an unknown label creates nothing", async () => {
      const { createIssue } = await import("@/server/services/issues");
      as(ADMIN, "admin");
      const before = await issueCount(ids.project);
      const res = await createIssue({
        projectId: ids.project,
        title: "Has a bad label",
        labelIds: [ids.bugLabel, MISSING],
      });
      expect(res).toEqual({ success: false, message: "Invalid issue data" });
      expect(await issueCount(ids.project)).toBe(before);
    });

    it("an invalid status or a parent from another project creates nothing", async () => {
      const { createIssue } = await import("@/server/services/issues");
      as(ADMIN, "admin");
      const before = await issueCount(ids.project);
      expect(
        await createIssue({
          projectId: ids.project,
          title: "Bad status",
          status: "archived",
        })
      ).toEqual({ success: false, message: "Invalid issue data" });
      expect(
        await createIssue({
          projectId: ids.project,
          title: "Foreign parent",
          parentId: ids.foreign,
          labelIds: [ids.uiLabel],
        })
      ).toEqual({ success: false, message: "Invalid issue data" });
      expect(await issueCount(ids.project)).toBe(before);
    });

    it("refuses a caller without issue:write, as today", async () => {
      const { createIssue } = await import("@/server/services/issues");
      as(OBSERVER, "observer");
      const before = await issueCount(ids.project);
      expect(
        await refusal(
          createIssue({
            projectId: ids.project,
            title: "Not allowed",
            status: "closed",
            labelIds: [ids.uiLabel],
          })
        )
      ).toMatchObject({ status: 403 });
      // qa holds issue:write, but only on projects it is a member of.
      as(QA, "qa");
      expect(
        (
          await refusal(
            createIssue({ projectId: ids.project, title: "Not a member" })
          )
        ).status
      ).toBeGreaterThanOrEqual(403);
      expect(await issueCount(ids.project)).toBe(before);
    });
  });

  describe("getIssueFormOptions", () => {
    it("returns labels and the project's open issues as parents", async () => {
      const { getIssueFormOptions } = await import("@/server/services/issues");
      as(ADMIN, "admin");
      const options = await getIssueFormOptions(ids.project);

      expect(options.environments).toEqual([{ id: ids.env, name: "ACME dev" }]);
      // Every workspace label (the migrations seed a few), name-ordered.
      const names = options.labels.map((l) => l.name);
      expect(names).toEqual(expect.arrayContaining(["regression", "ui"]));
      expect(names).toEqual([...names].sort());
      expect(options.labels.find((l) => l.id === ids.bugLabel)).toEqual({
        id: ids.bugLabel,
        name: "regression",
        color: expect.any(String),
      });
      const parentIds = options.parents.map((p) => p.id);
      expect(parentIds).toContain(ids.epic);
      expect(parentIds).not.toContain(ids.closed);
      expect(parentIds).not.toContain(ids.foreign);
      expect(options.parents.find((p) => p.id === ids.epic)).toEqual({
        id: ids.epic,
        number: 1,
        title: "Checkout epic",
      });
      // Newest first, like the issue lists.
      const numbers = options.parents.map((p) => p.number);
      expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
      const open = await d
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.issues)
        .where(
          and(
            eq(schema.issues.projectId, ids.project),
            sql`${schema.issues.status} in ('open', 'in_progress')`
          )
        );
      expect(options.parents).toHaveLength(Number(one(open).n));
    });

    it("is refused without issue:write, as today", async () => {
      const { getIssueFormOptions } = await import("@/server/services/issues");
      as(OBSERVER, "observer");
      expect(await refusal(getIssueFormOptions(ids.project))).toMatchObject({
        status: 403,
      });
    });
  });
});

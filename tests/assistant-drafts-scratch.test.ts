import { execFileSync, spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";

// Assistant drafts (lib/assistant/draft-store.ts, lib/issue-number.ts,
// lib/jira/create.ts) against a real Postgres, with Jira mocked (fetch and the
// link lookup). Same scratch setup as the conversation-store test: the local
// menara-postgres container (postgres 18) through its published port, with
// the container's superuser password read from the container and never
// printed. It creates a scratch database, migrates it with `menara migrate`
// and drops it afterwards; no other database is touched.
//
//   ASSISTANT_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/assistant-drafts-scratch.test.ts
const enabled = process.env.ASSISTANT_SCRATCH_DB === "1";

const link = vi.hoisted(() => ({ projectId: "" }));
vi.mock("@/lib/jira/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jira/sync")>()),
  resolveLink: async (projectId: string) =>
    projectId === link.projectId
      ? {
          link: {
            enabled: true,
            pushEnabled: true,
            jiraProjectKey: "KST",
            mappingOverrides: null,
          },
          connection: { flavor: "cloud" },
          credentials: {
            baseUrl: "https://acme.atlassian.net",
            flavor: "cloud",
            email: "bot@example.com",
            token: "token",
          },
        }
      : null,
}));
const CONTAINER = "menara-postgres";
const DB_NAME = "assistant_drafts_scratch";

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

describe.skipIf(!enabled)(
  "assistant conversation store on a real Postgres",
  () => {
    let client: ReturnType<typeof postgres>;
    let previousUrl: string | undefined;

    beforeAll(() => {
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
      // UTC like the app's own connections (lib/db), so created_at defaults
      // and now() agree with what the app writes.
      client = postgres(url, {
        max: 1,
        onnotice: () => {},
        connection: { TimeZone: "UTC" },
      });
    });

    afterAll(async () => {
      await client?.end();
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      psql("postgres", [
        "-c",
        `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`,
      ]);
    });

    it("stores drafts, creates one Jira issue per draft with the next number, and lists it", async () => {
      const d = drizzle({ client });
      const drafts = await import("@/lib/assistant/draft-store");
      const store = await import("@/lib/assistant/conversation-store");
      const { createJiraIssueFromDraft } = await import("@/lib/jira/create");

      const user = one(
        await d
          .insert(schema.users)
          .values({
            id: "00000000-0000-7000-8000-00000000c001",
            name: "Widya",
            email: "ba@example.com",
            role: "qa",
          })
          .returning()
      );
      const project = one(
        await d
          .insert(schema.projects)
          .values({ name: "Kestrel Membership", key: "KMEM" })
          .returning()
      );
      link.projectId = project.id;
      const env = one(
        await d
          .insert(schema.environments)
          .values({ projectId: project.id, name: "Dev 1", slug: "dev-1" })
          .returning()
      );
      await d.insert(schema.issues).values([
        { projectId: project.id, number: 1, title: "a" },
        { projectId: project.id, number: 2, title: "b" },
      ]);
      const connection = one(
        await d
          .insert(schema.jiraConnections)
          .values({
            name: "Acme",
            baseUrl: "https://acme.atlassian.net",
            apiToken: "not-a-real-token",
            webhookSecret: "x",
          })
          .returning()
      );
      await d.insert(schema.jiraProjectLinks).values({
        projectId: project.id,
        connectionId: connection.id,
        jiraProjectKey: "KST",
        pushEnabled: true,
      });

      const conversationId = await store.insertConversation({
        userId: user.id,
      });
      await d.insert(schema.assistantMessages).values([
        {
          conversationId,
          role: "user",
          status: "done",
          content: "Tanya",
          projectId: project.id,
          projectName: project.name,
          environmentId: env.id,
          environmentName: "Dev 1",
        },
        { conversationId, role: "assistant", status: "done", content: "Jawab" },
        {
          conversationId,
          role: "assistant",
          status: "failed",
          content: "Separuh",
        },
        { conversationId, role: "assistant", status: "done", content: "  " },
        {
          conversationId,
          role: "user",
          status: "done",
          content: "Lagi",
          projectId: project.id,
          projectName: project.name,
        },
      ]);
      // Each question with the context it was asked in.
      expect(await drafts.loadDraftTranscript(conversationId)).toEqual({
        messages: [
          {
            role: "user",
            content: "Tanya",
            context: {
              kind: "environment",
              environmentId: env.id,
              environmentName: "Dev 1",
              projectId: project.id,
              projectName: "Kestrel Membership",
            },
          },
          { role: "assistant", content: "Jawab" },
          {
            role: "user",
            content: "Lagi",
            context: {
              kind: "project",
              projectId: project.id,
              projectName: "Kestrel Membership",
            },
          },
        ],
      });

      const content = {
        summary: "Iuran tambahan dibulatkan ke atas",
        issueType: "Story",
        description: "Saat ini ke bawah.",
        acceptanceCriteria: ["Ke atas"],
      };
      const draftId = await drafts.insertDraft({
        conversationId,
        projectId: project.id,
        kind: "jira",
        content,
      });
      expect(await drafts.findDraftOwner(draftId)).toEqual({
        conversation: { id: conversationId, userId: user.id },
        projectId: project.id,
        kind: "jira",
        issueId: null,
      });
      expect(
        await drafts.updateDraftContent(draftId, { ...content, summary: "S" })
      ).toBe(true);
      await drafts.updateDraftContent(draftId, content);

      let posts = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL, init: RequestInit = {}) => {
          const path = new URL(String(input)).pathname;
          if (path === "/rest/api/3/issue/createmeta/KST/issuetypes") {
            return Response.json({
              issueTypes: [{ id: "10002", name: "Story" }],
            });
          }
          if (path === "/rest/api/3/issue/createmeta/KST/issuetypes/10002") {
            return Response.json({ fields: [] });
          }
          if (path === "/rest/api/3/issue" && init.method === "POST") {
            posts++;
            // Slow enough that a second request has to wait on the row lock.
            await new Promise((r) => setTimeout(r, 200));
            return Response.json({ id: "20001", key: "KST-901" });
          }
          if (path === "/rest/api/3/issue/20001") {
            return Response.json({
              id: "20001",
              key: "KST-901",
              fields: { updated: "2026-11-16T23:30:00.000+0700" },
            });
          }
          return new Response("unexpected", { status: 500 });
        })
      );
      try {
        // Two creates at once: the draft row lock lets exactly one through.
        const results = await Promise.allSettled([
          createJiraIssueFromDraft(draftId, user.id),
          createJiraIssueFromDraft(draftId, user.id),
        ]);
        expect(posts).toBe(1);
        const ok = results.filter((r) => r.status === "fulfilled");
        const refused = results.filter((r) => r.status === "rejected");
        expect(ok).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
          code: "assistant.draft_already_created",
        });
        const created = (
          ok[0] as PromiseFulfilledResult<{
            issueId: string;
            jiraKey: string;
          }>
        ).value;
        expect(created.jiraKey).toBe("KST-901");

        const [issue] = await d
          .select()
          .from(schema.issues)
          .where(eq(schema.issues.id, created.issueId));
        expect(issue).toMatchObject({
          projectId: project.id,
          number: 3,
          title: "Iuran tambahan dibulatkan ke atas",
          type: "story",
          createdById: user.id,
          jiraIssueId: "20001",
          jiraKey: "KST-901",
          jiraUpdatedAt: new Date("2026-11-16T16:30:00.000Z"),
        });
        expect(
          await drafts.updateDraftContent(draftId, { ...content, summary: "S" })
        ).toBe(false);

        const [activity] = await d
          .select()
          .from(schema.activityLog)
          .where(eq(schema.activityLog.action, "issue.created_from_assistant"));
        expect(activity).toMatchObject({
          actorId: user.id,
          entityId: created.issueId,
          data: { key: "KMEM-3", jiraKey: "KST-901" },
        });

        const detail = await store.loadConversationDetail(conversationId);
        expect(detail).not.toHaveProperty("jiraPushEnabled");
        expect(detail?.drafts).toEqual([
          expect.objectContaining({
            id: draftId,
            projectId: project.id,
            kind: "jira",
            issueId: created.issueId,
            jiraKey: "KST-901",
            issueNumber: 3,
            content,
          }),
        ]);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("adopts the webhook mirror committed while its insert waits, and keeps a record of an unstored issue", async () => {
      const d = drizzle({ client });
      const drafts = await import("@/lib/assistant/draft-store");
      const { createJiraIssueFromDraft } = await import("@/lib/jira/create");
      const [user] = await d.select().from(schema.users).limit(1);
      const [conversation] = await d
        .select()
        .from(schema.assistantConversations)
        .limit(1);
      if (!user || !conversation) throw new Error("first test's rows missing");
      const content = {
        summary: "Race",
        issueType: "Task",
        description: "x",
        acceptanceCriteria: [],
      };
      const [project] = await d.select().from(schema.projects).limit(1);
      if (!project) throw new Error("first test's rows missing");
      const draftId = await drafts.insertDraft({
        conversationId: conversation.id,
        projectId: project.id,
        kind: "jira",
        content,
      });

      // The sync job's transaction: its mirror of 20002 is inserted but not
      // yet committed when the assistant's insert reaches the unique index.
      const sync = await client.reserve();
      let posts = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL, init: RequestInit = {}) => {
          const path = new URL(String(input)).pathname;
          if (path === "/rest/api/3/issue/createmeta/KST/issuetypes") {
            return Response.json({
              issueTypes: [{ id: "10001", name: "Task" }],
            });
          }
          if (path === "/rest/api/3/issue/createmeta/KST/issuetypes/10001") {
            return Response.json({ fields: [] });
          }
          if (path === "/rest/api/3/issue" && init.method === "POST") {
            posts++;
            await sync`begin`;
            await sync`insert into issues (project_id, number, title, jira_issue_id, jira_key)
              values (${project.id}, 100, 'Race (synced)', '20002', 'KST-902')`;
            // Commit once the assistant's insert is waiting on the row.
            setTimeout(() => {
              sync`commit`.then(() => {});
            }, 300);
            return Response.json({ id: "20002", key: "KST-902" });
          }
          if (path === "/rest/api/3/issue/20002") {
            // Slow enough that the assistant still found no mirror before.
            return Response.json({
              id: "20002",
              key: "KST-902",
              fields: { updated: "2026-11-16T23:40:00.000+0700" },
            });
          }
          return new Response("unexpected", { status: 500 });
        })
      );
      try {
        const result = await createJiraIssueFromDraft(draftId, user.id);
        // The test's own client has one connection: free it for the reads.
        sync.release();
        expect(posts).toBe(1);
        const mirrors = await d
          .select()
          .from(schema.issues)
          .where(eq(schema.issues.jiraIssueId, "20002"));
        expect(mirrors).toHaveLength(1);
        expect(mirrors[0]).toMatchObject({
          id: result.issueId,
          number: 100,
          title: "Race (synced)",
          createdById: user.id,
        });
        expect(await drafts.findDraftOwner(draftId)).toMatchObject({
          issueId: result.issueId,
        });
      } finally {
        vi.unstubAllGlobals();
      }

      // The record a failed local write leaves, read back by the next try.
      const other = await drafts.insertDraft({
        conversationId: conversation.id,
        projectId: project.id,
        kind: "jira",
        content,
      });
      await drafts.recordUnlinkedRemote(other, user.id, {
        jiraIssueId: "20003",
        jiraKey: "KST-903",
      });
      const { db } = await import("@/lib/db");
      expect(
        await db.transaction((tx) => drafts.findUnlinkedRemote(tx, other))
      ).toEqual({ jiraIssueId: "20003", jiraKey: "KST-903" });
      expect(
        await db.transaction((tx) => drafts.findUnlinkedRemote(tx, draftId))
      ).toBeNull();
    });

    it("suggests a draft's project from the last question, else the last answer's reads", async () => {
      const d = drizzle({ client });
      const drafts = await import("@/lib/assistant/draft-store");
      const store = await import("@/lib/assistant/conversation-store");
      const [user] = await d.select().from(schema.users).limit(1);
      if (!user) throw new Error("first test's rows missing");
      const [a, b, c] = await d
        .insert(schema.projects)
        .values([
          { name: "Alpha", key: "ALP" },
          { name: "Bravo", key: "BRV" },
          { name: "Charlie", key: "CHR" },
        ])
        .returning();
      if (!a || !b || !c) throw new Error("projects not inserted");
      const all = () => true;

      // A pinned, then B pinned: B.
      const mixed = await store.insertConversation({ userId: user.id });
      await d.insert(schema.assistantMessages).values([
        {
          conversationId: mixed,
          role: "user",
          status: "done",
          content: "A?",
          projectId: a.id,
          projectName: a.name,
        },
        {
          conversationId: mixed,
          role: "assistant",
          status: "done",
          content: "A",
        },
        {
          conversationId: mixed,
          role: "user",
          status: "done",
          content: "B?",
          projectId: b.id,
          projectName: b.name,
        },
        {
          conversationId: mixed,
          role: "assistant",
          status: "done",
          content: "B",
        },
      ]);
      expect(await drafts.suggestDraftProject(mixed, all)).toBe(b.id);
      expect(
        await drafts.suggestDraftProject(mixed, (id) => id !== b.id)
      ).toBeNull();

      // Automatic only: the project the last finished answer read most.
      const auto = await store.insertConversation({ userId: user.id });
      await d.insert(schema.assistantMessages).values({
        conversationId: auto,
        role: "user",
        status: "done",
        content: "Mana?",
      });
      const [answer] = await d
        .insert(schema.assistantMessages)
        .values({
          conversationId: auto,
          role: "assistant",
          status: "done",
          content: "Di CHR",
          sources: [],
        })
        .returning();
      if (!answer) throw new Error("answer not inserted");
      await d.insert(schema.assistantToolCalls).values([
        {
          messageId: answer.id,
          tool: "list_projects",
          input: {},
          resultMeta: { projectKeys: ["ALP", "CHR"] },
        },
        {
          messageId: answer.id,
          tool: "read_file",
          input: {},
          resultMeta: { project: "ALP" },
        },
        {
          messageId: answer.id,
          tool: "read_file",
          input: {},
          resultMeta: { project: "CHR" },
        },
        {
          messageId: answer.id,
          tool: "search_code",
          input: {},
          resultMeta: { project: "CHR" },
        },
        {
          messageId: answer.id,
          tool: "read_file",
          input: {},
          resultMeta: { project: "NOPE" },
        },
      ]);
      expect(await drafts.suggestDraftProject(auto, all)).toBe(c.id);
      expect(await drafts.suggestDraftProject(auto, (id) => id !== c.id)).toBe(
        a.id
      );

      // Nothing names a project.
      const empty = await store.insertConversation({ userId: user.id });
      await d.insert(schema.assistantMessages).values([
        {
          conversationId: empty,
          role: "user",
          status: "done",
          content: "Halo",
        },
        {
          conversationId: empty,
          role: "assistant",
          status: "done",
          content: "Hai",
        },
      ]);
      expect(await drafts.suggestDraftProject(empty, all)).toBeNull();

      // A Stage 2 conversation's own project, only when nothing else does.
      await d
        .update(schema.assistantConversations)
        .set({ projectId: a.id })
        .where(eq(schema.assistantConversations.id, auto));
      expect(await drafts.suggestDraftProject(auto, all)).toBe(c.id);
      expect(await drafts.suggestDraftProject(auto, (id) => id === a.id)).toBe(
        a.id
      );

      // The projects a draft may choose, with their Jira write-back switch.
      const [link] = await d
        .select({ projectId: schema.jiraProjectLinks.projectId })
        .from(schema.jiraProjectLinks)
        .limit(1);
      const listed = await drafts.loadDraftProjects([a.id, b.id]);
      expect(listed).toEqual([
        { id: a.id, key: "ALP", name: "Alpha", jiraPushEnabled: false },
        { id: b.id, key: "BRV", name: "Bravo", jiraPushEnabled: false },
      ]);
      if (!link) throw new Error("first test's link missing");
      expect(await drafts.loadDraftProjects([link.projectId])).toEqual([
        expect.objectContaining({ jiraPushEnabled: true }),
      ]);
      expect(await drafts.loadDraftProjects([])).toEqual([]);

      // Saving a draft can move it to another project.
      const draftId = await drafts.insertDraft({
        conversationId: auto,
        projectId: null,
        kind: "jira",
        content: {
          summary: "S",
          issueType: "Task",
          description: "",
          acceptanceCriteria: [],
        },
      });
      expect(
        await drafts.updateDraftContent(
          draftId,
          {
            summary: "T",
            issueType: "Task",
            description: "",
            acceptanceCriteria: [],
          },
          { projectId: c.id }
        )
      ).toBe(true);
      expect(await drafts.findDraftOwner(draftId)).toMatchObject({
        projectId: c.id,
      });
    });

    it("insertIssueWithNextNumber takes the next number inside an open transaction", async () => {
      const d = drizzle({ client });
      const { db } = await import("@/lib/db");
      const { insertIssueWithNextNumber } = await import("@/lib/issue-number");
      const project = one(
        await d
          .insert(schema.projects)
          .values({ name: "Other", key: "OTH" })
          .returning()
      );
      const numbers = await db.transaction(async (tx) => {
        const a = await insertIssueWithNextNumber(tx, project.id, {
          title: "a",
        });
        const b = await insertIssueWithNextNumber(tx, project.id, {
          title: "b",
        });
        return [a.number, b.number];
      });
      expect(numbers).toEqual([1, 2]);
    });
  }
);

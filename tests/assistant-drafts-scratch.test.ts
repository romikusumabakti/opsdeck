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
vi.mock("@/lib/jira/sync", () => ({
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
        projectId: project.id,
        environmentId: env.id,
        environmentName: "Dev 1",
      });
      await d.insert(schema.assistantMessages).values([
        { conversationId, role: "user", status: "done", content: "Tanya" },
        { conversationId, role: "assistant", status: "done", content: "Jawab" },
        {
          conversationId,
          role: "assistant",
          status: "failed",
          content: "Separuh",
        },
        { conversationId, role: "assistant", status: "done", content: "  " },
      ]);
      expect(await drafts.loadDraftTranscript(conversationId)).toEqual({
        projectName: "Kestrel Membership",
        environmentName: "Dev 1",
        messages: [
          { role: "user", content: "Tanya" },
          { role: "assistant", content: "Jawab" },
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
        kind: "jira",
        content,
      });
      expect(await drafts.findDraftOwner(draftId)).toEqual({
        conversation: {
          id: conversationId,
          userId: user.id,
          projectId: project.id,
        },
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
        expect(detail?.jiraPushEnabled).toBe(true);
        expect(detail?.drafts).toEqual([
          expect.objectContaining({
            id: draftId,
            kind: "jira",
            issueId: created.issueId,
            jiraKey: "KST-901",
            content,
          }),
        ]);
      } finally {
        vi.unstubAllGlobals();
      }
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

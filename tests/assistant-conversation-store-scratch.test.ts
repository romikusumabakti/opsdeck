import { execFileSync, spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";

// The assistant conversation store (lib/assistant/conversation-store.ts) against a real Postgres: the local
// menara-postgres container (postgres 18) through its published port, with
// the container's superuser password read from the container and never
// printed. It creates a scratch database, migrates it with `menara migrate`
// and drops it afterwards; no other database is touched.
//
//   ASSISTANT_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/assistant-conversation-store-scratch.test.ts
const enabled = process.env.ASSISTANT_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "assistant_conversation_store_scratch";

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

    it("creates turns atomically, refuses a busy conversation and reads the chat back", async () => {
      const d = drizzle({ client });
      const store = await import("@/lib/assistant/conversation-store");

      const user = one(
        await d
          .insert(schema.users)
          .values({
            id: "00000000-0000-7000-8000-00000000c001",
            name: "Wulan",
            email: "qa@example.com",
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
      const env = one(
        await d
          .insert(schema.environments)
          .values({ projectId: project.id, name: "Dev 1", slug: "dev-1" })
          .returning()
      );

      const otherProject = one(
        await d
          .insert(schema.projects)
          .values({ name: "Heron Membership", key: "HMEM" })
          .returning()
      );
      const otherEnv = one(
        await d
          .insert(schema.environments)
          .values({ projectId: otherProject.id, name: "UAT", slug: "uat" })
          .returning()
      );
      expect(await store.findEnvironment(otherEnv.id)).toEqual({
        id: otherEnv.id,
        name: "UAT",
        projectId: otherProject.id,
        projectName: "Heron Membership",
      });
      expect(await store.findProject(project.id)).toEqual({
        id: project.id,
        name: "Kestrel Membership",
      });
      expect(
        await store.findEnvironment("00000000-0000-7000-8000-0000000000ff")
      ).toBeNull();
      const devContext = {
        kind: "environment",
        environmentId: env.id,
        environmentName: "Dev 1",
        projectId: project.id,
        projectName: "Kestrel Membership",
      } as const;
      const branches = {
        kind: "project",
        projectId: project.id,
        projectName: "Kestrel Membership",
      } as const;
      const auto = { kind: "auto" } as const;
      expect(await store.loadAssistantLimits()).toEqual({
        enabled: false,
        hasApiKey: false,
        dailyCapUsd: 1.5,
        // No provider chosen yet: nothing says images cannot be read.
        readsImages: true,
      });

      const conversationId = await store.insertConversation({
        userId: user.id,
      });
      const [row] =
        await client`select project_id, environment_id, environment_name from assistant_conversations where id = ${conversationId}`;
      expect(row).toEqual({
        project_id: null,
        environment_id: null,
        environment_name: null,
      });
      const empty = await store.insertConversation({ userId: user.id });
      expect(await store.findConversation(conversationId)).toEqual({
        id: conversationId,
        userId: user.id,
      });

      const now = new Date("2026-11-16T03:00:00Z");
      const first = await store.insertTurn({
        conversationId,
        text: "Bagaimana iuran dihitung?\n\nJelaskan.",
        attachmentIds: ["10001"],
        context: devContext,
        now,
      });
      if (typeof first === "string") throw new Error(`unexpected ${first}`);
      expect(first.userMessageId < first.assistantMessageId).toBe(true);
      // The list names an environment with its project.
      expect(
        (await store.listConversationsOf(user.id)).recent.find(
          (c) => c.id === conversationId
        )?.lastContextLabel
      ).toBe("Kestrel Membership · Dev 1");

      // The first answer is still queued: any further send is busy.
      const [a, b] = await Promise.all([
        store.insertTurn({
          conversationId,
          text: "x",
          attachmentIds: [],
          context: branches,
        }),
        store.insertTurn({
          conversationId,
          text: "y",
          attachmentIds: [],
          context: branches,
        }),
      ]);
      expect([a, b]).toEqual(["busy", "busy"]);

      await client`update assistant_messages set status = 'done', content = 'Di IuranService.' where id = ${first.assistantMessageId}`;
      const answerParts = [
        { type: "step-start" as const },
        {
          type: "text" as const,
          text: "Di IuranService.",
          state: "done" as const,
        },
      ];
      await d
        .update(schema.assistantMessages)
        .set({ parts: answerParts })
        .where(eq(schema.assistantMessages.id, first.assistantMessageId));
      // Two sends at once: the conversation row lock lets exactly one through.
      const [c1, c2] = await Promise.all([
        store.insertTurn({
          conversationId,
          text: "Lalu?",
          attachmentIds: [],
          context: branches,
        }),
        store.insertTurn({
          conversationId,
          text: "Lalu lagi?",
          attachmentIds: [],
          context: branches,
        }),
      ]);
      expect([c1, c2].filter((t) => t === "busy")).toHaveLength(1);
      const second = c1 === "busy" ? c2 : c1;
      if (typeof second === "string") throw new Error("expected one turn");

      await d.insert(schema.assistantToolCalls).values({
        messageId: first.assistantMessageId,
        tool: "read_file",
        input: { path: "backend/Iuran.java" },
        resultMeta: { paths: ["backend/Iuran.java"] },
      });

      // Every conversation of the user, newest first, labelled with the
      // latest question's context.
      const listed = await store.listConversationsOf(user.id);
      expect(listed.pinned).toEqual([]);
      expect(listed.recent).toEqual([
        {
          id: conversationId,
          title: "Bagaimana iuran dihitung? Jelaskan.",
          updatedAt: expect.any(Date),
          lastContextLabel: "Kestrel Membership",
          lastContextDeleted: false,
          pinnedAt: null,
        },
        {
          id: empty,
          title: "",
          updatedAt: expect.any(Date),
          lastContextLabel: null,
          lastContextDeleted: false,
          pinnedAt: null,
        },
      ]);
      const detail = await store.loadConversationDetail(conversationId);
      expect(detail).not.toHaveProperty("projectId");
      expect(detail?.messages.map((m) => [m.role, m.status])).toEqual([
        ["user", "done"],
        ["assistant", "done"],
        ["user", "done"],
        ["assistant", "queued"],
      ]);
      expect(detail?.messages[0]).toMatchObject({
        content: "Bagaimana iuran dihitung?\n\nJelaskan.",
        attachmentIds: ["10001"],
        context: {
          kind: "environment",
          label: "Dev 1",
          deleted: false,
          projectId: project.id,
          environmentId: env.id,
        },
        toolCalls: [],
      });
      // The answer carries no context; the second question asked about the
      // project branches.
      expect(detail?.messages[1]).toMatchObject({
        context: null,
        parts: answerParts,
      });
      // A question, and an answer from before parts, have none.
      expect(detail?.messages[0]?.parts).toBeNull();
      expect(detail?.messages[2]).toMatchObject({
        context: {
          kind: "project",
          label: "Kestrel Membership",
          deleted: false,
          projectId: project.id,
          environmentId: null,
        },
      });
      expect(detail?.messages[1]?.toolCalls).toEqual([
        { tool: "read_file", meta: { paths: ["backend/Iuran.java"] } },
      ]);
      expect(detail?.drafts).toEqual([]);

      // Deleting the environment keeps the question's name snapshot.
      await d
        .delete(schema.environments)
        .where(eq(schema.environments.id, env.id));
      // A send racing that delete: the FK refuses the question, nothing is
      // written.
      await client`update assistant_messages set status = 'done' where id = ${second.assistantMessageId}`;
      expect(
        await store.insertTurn({
          conversationId,
          text: "Masih ada?",
          attachmentIds: [],
          context: devContext,
        })
      ).toBe("context_gone");
      expect(
        (await store.loadConversationDetail(conversationId))?.messages
      ).toHaveLength(4);
      expect(
        (await store.loadConversationDetail(conversationId))?.messages[0]
      ).toMatchObject({
        context: {
          kind: "environment",
          label: "Dev 1",
          deleted: true,
          projectId: project.id,
          environmentId: null,
        },
      });

      // An automatic question stores no project; a deleted project nulls
      // the id and keeps the name.
      const third = await store.insertTurn({
        conversationId,
        text: "Apa saja?",
        attachmentIds: [],
        context: auto,
      });
      if (typeof third === "string") throw new Error(`unexpected ${third}`);
      const [stored] =
        await client`select project_id, project_name, environment_id, environment_name from assistant_messages where id = ${third.userMessageId}`;
      expect(stored).toEqual({
        project_id: null,
        project_name: null,
        environment_id: null,
        environment_name: null,
      });
      expect(
        (await store.listConversationsOf(user.id)).recent[0]?.lastContextLabel
      ).toBeNull();
      await client`update assistant_messages set status = 'done' where id = ${third.assistantMessageId}`;
      const fourth = await store.insertTurn({
        conversationId,
        text: "Di Heron?",
        attachmentIds: [],
        context: {
          kind: "project",
          projectId: otherProject.id,
          projectName: "Heron Membership",
        },
      });
      if (typeof fourth === "string") throw new Error(`unexpected ${fourth}`);
      await d
        .delete(schema.projects)
        .where(eq(schema.projects.id, otherProject.id));
      expect(
        (await store.loadConversationDetail(conversationId))?.messages.at(-2)
          ?.context
      ).toEqual({
        kind: "project",
        label: "Heron Membership",
        deleted: true,
        projectId: null,
        environmentId: null,
      });
      expect(
        await store.insertTurn({
          conversationId,
          text: "Masih?",
          attachmentIds: [],
          context: {
            kind: "project",
            projectId: otherProject.id,
            projectName: "Heron Membership",
          },
        })
      ).toBe("busy");
      await client`update assistant_messages set status = 'done' where id = ${fourth.assistantMessageId}`;
      expect(
        await store.insertTurn({
          conversationId,
          text: "Masih?",
          attachmentIds: [],
          context: {
            kind: "project",
            projectId: otherProject.id,
            projectName: "Heron Membership",
          },
        })
      ).toBe("context_gone");
      await client`update assistant_messages set status = 'queued' where id = ${second.assistantMessageId}`;

      expect(await store.readAnswerStatus(first.assistantMessageId)).toEqual({
        status: "done",
        errorCode: null,
      });

      // Only a queued answer is failed by a lost enqueue.
      await store.failQueuedMessage(
        first.assistantMessageId,
        "assistant.unavailable"
      );
      await store.failQueuedMessage(
        second.assistantMessageId,
        "assistant.unavailable"
      );
      expect(
        await store.readAnswerStatus(first.assistantMessageId)
      ).toMatchObject({
        status: "done",
        errorCode: null,
      });
      expect(
        await store.readAnswerStatus(second.assistantMessageId)
      ).toMatchObject({
        status: "failed",
        errorCode: "assistant.unavailable",
      });
      expect(await store.readAnswerStatus(conversationId)).toBeNull();
    });

    it("renames a chat and deletes it with its rows, keeping usage and other chats", async () => {
      const d = drizzle({ client });
      const store = await import("@/lib/assistant/conversation-store");
      const turns = await import("@/lib/assistant/turn-store");
      const { recordUsage } = await import("@/lib/assistant/usage");
      const user = one(
        await d
          .insert(schema.users)
          .values({
            id: "00000000-0000-7000-8000-00000000c009",
            name: "Rina",
            email: "rina@example.com",
            role: "qa",
          })
          .returning()
      );
      const doomed = await store.insertConversation({ userId: user.id });
      const kept = await store.insertConversation({ userId: user.id });
      const turn = await store.insertTurn({
        conversationId: doomed,
        text: "Bagaimana iuran dihitung?",
        attachmentIds: [],
        context: { kind: "auto" },
      });
      if (typeof turn === "string") throw new Error(turn);
      const keptTurn = await store.insertTurn({
        conversationId: kept,
        text: "Lain",
        attachmentIds: [],
        context: { kind: "auto" },
      });
      if (typeof keptTurn === "string") throw new Error(keptTurn);

      const [before] =
        await client`select updated_at from assistant_conversations where id = ${doomed}`;
      await store.updateConversationTitle(doomed, "Iuran tambahan");
      const [renamed] =
        await client`select title, updated_at from assistant_conversations where id = ${doomed}`;
      expect(renamed?.title).toBe("Iuran tambahan");
      expect(renamed?.updated_at).toEqual(before?.updated_at);

      await turns.recordToolCall(turn.assistantMessageId, "list_files", {}, {});
      const prices = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
      const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
      await recordUsage({
        messageId: turn.assistantMessageId,
        userId: user.id,
        modelId: "acme-max",
        prices,
        usage,
        estimated: false,
      });
      await d.insert(schema.assistantDrafts).values({
        conversationId: doomed,
        kind: "brd",
        content: { title: "T", sections: [] },
      });
      await d.insert(schema.assistantFiles).values([
        // Sent with the question.
        {
          userId: user.id,
          conversationId: doomed,
          messageId: turn.userMessageId,
          storageKey: "assistant/u/a",
          filename: "a.png",
          mediaType: "image/png",
          size: 1,
        },
        // Tied to a message of the chat only.
        {
          userId: user.id,
          messageId: turn.userMessageId,
          storageKey: "assistant/u/b",
          filename: "b.pdf",
          mediaType: "application/pdf",
          size: 1,
        },
        // Another chat's, and one not sent yet.
        {
          userId: user.id,
          conversationId: kept,
          storageKey: "assistant/u/c",
          filename: "c.txt",
          mediaType: "text/plain",
          size: 1,
        },
        {
          userId: user.id,
          storageKey: "assistant/u/d",
          filename: "d.txt",
          mediaType: "text/plain",
          size: 1,
        },
      ]);

      const keys = await store.deleteConversationRows(doomed);
      expect(keys.sort()).toEqual(["assistant/u/a", "assistant/u/b"]);
      expect(await store.findConversation(doomed)).toBeNull();
      const count = async (table: string, where = "true") =>
        Number(
          one(
            await client.unsafe(
              `select count(*)::int as n from ${table} where ${where}`
            )
          ).n
        );
      expect(
        await count("assistant_messages", `conversation_id = '${doomed}'`)
      ).toBe(0);
      expect(
        await count(
          "assistant_tool_calls",
          `message_id = '${turn.assistantMessageId}'`
        )
      ).toBe(0);
      expect(
        await count("assistant_drafts", `conversation_id = '${doomed}'`)
      ).toBe(0);
      expect(
        (
          await client`select storage_key from assistant_files where user_id = ${user.id} order by storage_key`
        ).map((r) => r.storage_key)
      ).toEqual(["assistant/u/c", "assistant/u/d"]);
      // The spend stays, without its message.
      const spend =
        await client`select message_id from assistant_usage where user_id = ${user.id}`;
      expect(spend).toEqual([{ message_id: null }]);
      expect(await store.findConversation(kept)).not.toBeNull();
      // Deleting it again is a no-op.
      expect(await store.deleteConversationRows(doomed)).toEqual([]);

      // A turn writing after the deletion finds its message gone: no rows,
      // no error; its usage is still recorded, without the message.
      const answer = turn.assistantMessageId;
      expect(
        await turns.saveParts(answer, { parts: [], content: "late" })
      ).toBe(false);
      expect(await turns.saveSources(answer, [])).toBe(false);
      expect(await turns.recordToolCall(answer, "list_files", {}, {})).toBe(
        false
      );
      await turns.finishMessage(answer, {
        status: "done",
        content: "late",
        parts: [],
      });
      await recordUsage({
        messageId: answer,
        userId: user.id,
        modelId: "acme-max",
        prices,
        usage,
        estimated: false,
      });
      expect(
        await client`select message_id from assistant_usage where user_id = ${user.id}`
      ).toEqual([{ message_id: null }, { message_id: null }]);
      expect(
        await count("assistant_tool_calls", `message_id = '${answer}'`)
      ).toBe(0);
      // The live chat's writes still land (while its answer streams).
      await turns.claimMessage(keptTurn.assistantMessageId);
      expect(
        await turns.saveParts(keptTurn.assistantMessageId, {
          parts: [],
          content: "ok",
        })
      ).toBe(true);
    });

    it("stops a pending answer without touching a finished one", async () => {
      const d = drizzle({ client });
      const store = await import("@/lib/assistant/conversation-store");
      const turns = await import("@/lib/assistant/turn-store");
      const user = one(
        await d
          .insert(schema.users)
          .values({
            id: "00000000-0000-7000-8000-00000000c00a",
            name: "Sari",
            email: "sari@example.com",
            role: "qa",
          })
          .returning()
      );
      const ask = async (conversationId: string) => {
        const turn = await store.insertTurn({
          conversationId,
          text: "Why?",
          attachmentIds: [],
          context: { kind: "auto" },
        });
        if (typeof turn === "string") throw new Error(turn);
        return turn.assistantMessageId;
      };
      const row = async (id: string) =>
        one(
          await client`select status, content, error_code, finished_at::text as finished_at from assistant_messages where id = ${id}`
        );
      const at = new Date("2026-11-18T03:00:00Z");

      // Streaming: failed with assistant.stopped, content kept.
      const chat = await store.insertConversation({ userId: user.id });
      const streaming = await ask(chat);
      expect(await turns.claimMessage(streaming)).toBe(true);
      await turns.saveParts(streaming, {
        parts: [],
        content: "half an answer",
      });
      expect(await store.stopPendingAnswer(chat, at)).toBe(streaming);
      expect(await row(streaming)).toMatchObject({
        status: "failed",
        content: "half an answer",
        error_code: "assistant.stopped",
        finished_at: "2026-11-18 03:00:00",
      });
      // The turn's own later writes no-op.
      expect(
        await turns.saveParts(streaming, { parts: [], content: "late" })
      ).toBe(false);
      expect((await row(streaming)).content).toBe("half an answer");
      // Nothing pending any more.
      expect(await store.stopPendingAnswer(chat)).toBeNull();

      // Done: untouched.
      const doneChat = await store.insertConversation({ userId: user.id });
      const done = await ask(doneChat);
      await client`update assistant_messages set status = 'done', content = 'ok' where id = ${done}`;
      expect(await store.stopPendingAnswer(doneChat)).toBeNull();
      expect(await row(done)).toMatchObject({
        status: "done",
        content: "ok",
        error_code: null,
      });

      // Queued: stopped too, and the worker can no longer claim it.
      const queuedChat = await store.insertConversation({ userId: user.id });
      const queued = await ask(queuedChat);
      expect(await store.stopPendingAnswer(queuedChat)).toBe(queued);
      expect(await row(queued)).toMatchObject({
        status: "failed",
        error_code: "assistant.stopped",
      });
      expect(await turns.claimMessage(queued)).toBe(false);
    });

    it("replaces the last answer for a retry", async () => {
      const d = drizzle({ client });
      const store = await import("@/lib/assistant/conversation-store");
      const user = one(
        await d
          .insert(schema.users)
          .values({
            id: "00000000-0000-7000-8000-00000000c00b",
            name: "Dewi",
            email: "dewi@example.com",
            role: "qa",
          })
          .returning()
      );
      const ask = async (conversationId: string) => {
        const turn = await store.insertTurn({
          conversationId,
          text: "Why?",
          attachmentIds: [],
          context: { kind: "auto" },
        });
        if (typeof turn === "string") throw new Error(turn);
        return turn;
      };
      const messages = async (chat: string) =>
        await client`select id, role, status from assistant_messages where conversation_id = ${chat} order by id`;

      for (const finished of ["done", "failed"]) {
        const chat = await store.insertConversation({ userId: user.id });
        const turn = await ask(chat);
        const old = turn.assistantMessageId;
        await client`update assistant_messages set status = ${finished}, error_code = ${finished === "failed" ? "assistant.stopped" : null}, content = 'old', sources = '[{"kind":"doc","title":"t","slug":"s"}]'::jsonb where id = ${old}`;
        await client`insert into assistant_tool_calls (message_id, tool, input, result_meta) values (${old}, 'list_files', '{}', '{}')`;
        await client`insert into assistant_usage (message_id, user_id, cost_usd, day) values (${old}, ${user.id}, 0.01, '2026-11-18')`;

        const result = await store.replaceLastAnswer(chat);
        if (typeof result === "string") throw new Error(result);
        expect(result.assistantMessageId).not.toBe(old);
        expect(
          await client`select id from assistant_messages where id = ${old}`
        ).toEqual([]);
        expect(
          await client`select id from assistant_tool_calls where message_id = ${old}`
        ).toEqual([]);
        // One new queued answer, after the question.
        expect(await messages(chat)).toEqual([
          { id: turn.userMessageId, role: "user", status: "done" },
          {
            id: result.assistantMessageId,
            role: "assistant",
            status: "queued",
          },
        ]);
        expect(
          await client`select content, error_code from assistant_messages where id = ${result.assistantMessageId}`
        ).toEqual([{ content: "", error_code: null }]);
      }
      // The spend of both old answers stays, without a message.
      expect(
        await client`select message_id from assistant_usage where user_id = ${user.id}`
      ).toEqual([{ message_id: null }, { message_id: null }]);

      // A pending answer: busy, nothing changed.
      const pendingChat = await store.insertConversation({ userId: user.id });
      const pending = await ask(pendingChat);
      expect(await store.replaceLastAnswer(pendingChat)).toBe("busy");
      await client`update assistant_messages set status = 'streaming' where id = ${pending.assistantMessageId}`;
      expect(await store.replaceLastAnswer(pendingChat)).toBe("busy");
      expect((await messages(pendingChat)).map((m) => m.id)).toEqual([
        pending.userMessageId,
        pending.assistantMessageId,
      ]);

      // No answer yet (only a question): nothing to retry.
      const lonely = await store.insertConversation({ userId: user.id });
      expect(await store.replaceLastAnswer(lonely)).toBe("nothing_to_retry");
      await client`insert into assistant_messages (conversation_id, role, status, content) values (${lonely}, 'user', 'done', 'Hi')`;
      expect(await store.replaceLastAnswer(lonely)).toBe("nothing_to_retry");

      // Two retries at once queue one answer.
      const race = await store.insertConversation({ userId: user.id });
      const raced = await ask(race);
      await client`update assistant_messages set status = 'done' where id = ${raced.assistantMessageId}`;
      const results = await Promise.all([
        store.replaceLastAnswer(race),
        store.replaceLastAnswer(race),
      ]);
      expect(results.filter((r) => r === "busy")).toHaveLength(1);
      expect(
        results.filter(
          (r) => typeof r === "object" && "assistantMessageId" in r
        )
      ).toHaveLength(1);
      expect(await messages(race)).toHaveLength(2);
    });

    it("lists pinned and recent chats, searches title and message text, never a temporary chat", async () => {
      const d = drizzle({ client });
      const store = await import("@/lib/assistant/conversation-store");
      const [owner, other] = await d
        .insert(schema.users)
        .values([
          {
            id: "00000000-0000-7000-8000-00000000c0a1",
            name: "Sekar",
            email: "sekar@example.invalid",
            role: "qa",
          },
          {
            id: "00000000-0000-7000-8000-00000000c0a2",
            name: "Bayu",
            email: "bayu@example.invalid",
            role: "qa",
          },
        ])
        .returning();
      if (!owner || !other) throw new Error("users");
      const auto = { kind: "auto" } as const;
      const chatWith = async (
        userId: string,
        text: string,
        at: string,
        options: { temporary?: boolean; answer?: string } = {}
      ) => {
        const id = await store.insertConversation({
          userId,
          temporary: options.temporary ?? false,
        });
        const turn = await store.insertTurn({
          conversationId: id,
          text,
          attachmentIds: [],
          context: auto,
          now: new Date(at),
        });
        if (typeof turn === "string") throw new Error(turn);
        await client`update assistant_messages set status = 'done', content = ${options.answer ?? "Ok."} where id = ${turn.assistantMessageId}`;
        return id;
      };
      const iuran = await chatWith(
        owner.id,
        "Iuran tambahan dibulatkan?",
        "2026-11-20T01:00:00Z"
      );
      const recon = await chatWith(
        owner.id,
        "Cek status batch",
        "2026-11-20T02:00:00Z",
        { answer: "Batch Rekonsiliasi selesai 03:00." }
      );
      const secret = await chatWith(
        owner.id,
        "Rekonsiliasi sementara",
        "2026-11-20T03:00:00Z",
        { temporary: true }
      );
      const theirs = await chatWith(
        other.id,
        "Rekonsiliasi milik Bayu",
        "2026-11-20T04:00:00Z"
      );
      const ids = (items: { id: string }[]) => items.map((c) => c.id);

      expect(
        await client`select temporary, title_source, pinned_at from assistant_conversations where id = ${secret}`
      ).toEqual([
        { temporary: true, title_source: "first_message", pinned_at: null },
      ]);

      // Newest first; the temporary chat and the other user's are absent.
      let list = await store.listConversationsOf(owner.id);
      expect(ids(list.pinned)).toEqual([]);
      expect(ids(list.recent)).toEqual([recon, iuran]);

      // Pins: most recently pinned first, out of Recent; unpin puts it back.
      expect(
        await store.setConversationPinned(
          owner.id,
          iuran,
          true,
          new Date("2026-11-20T05:00:00Z")
        )
      ).toBe("ok");
      expect(
        await store.setConversationPinned(
          owner.id,
          recon,
          true,
          new Date("2026-11-20T06:00:00Z")
        )
      ).toBe("ok");
      list = await store.listConversationsOf(owner.id);
      expect(ids(list.pinned)).toEqual([recon, iuran]);
      expect(list.pinned[0]?.pinnedAt).toEqual(
        new Date("2026-11-20T06:00:00Z")
      );
      expect(ids(list.recent)).toEqual([]);
      // Pinning again keeps the original pin time (and order).
      expect(
        await store.setConversationPinned(
          owner.id,
          iuran,
          true,
          new Date("2026-11-20T07:00:00Z")
        )
      ).toBe("ok");
      expect(ids((await store.listConversationsOf(owner.id)).pinned)).toEqual([
        recon,
        iuran,
      ]);
      expect(await store.setConversationPinned(owner.id, recon, false)).toBe(
        "ok"
      );
      list = await store.listConversationsOf(owner.id);
      expect(ids(list.pinned)).toEqual([iuran]);
      expect(ids(list.recent)).toEqual([recon]);
      // Pinning leaves updated_at (the Recent order) alone.
      expect(list.recent[0]?.updatedAt).toEqual(
        new Date("2026-11-20T02:00:00Z")
      );

      // A temporary chat can't be pinned; another user's chat is not found.
      expect(await store.setConversationPinned(owner.id, secret, true)).toBe(
        "temporary"
      );
      expect(await store.setConversationPinned(other.id, iuran, false)).toBe(
        "not_found"
      );
      expect(await store.setConversationPinned(owner.id, theirs, true)).toBe(
        "not_found"
      );
      expect(
        await client`select pinned_at from assistant_conversations where id in (${secret}, ${theirs})`
      ).toEqual([{ pinned_at: null }, { pinned_at: null }]);
      expect(ids((await store.listConversationsOf(owner.id)).pinned)).toEqual([
        iuran,
      ]);

      // Search: case-insensitive, on the title or any message (answers too),
      // own non-temporary chats only, split like the list.
      list = await store.listConversationsOf(owner.id, {
        query: "rekonsiliasi",
      });
      expect(ids(list.pinned)).toEqual([]);
      expect(ids(list.recent)).toEqual([recon]);
      list = await store.listConversationsOf(owner.id, { query: "IURAN" });
      expect(ids(list.pinned)).toEqual([iuran]);
      expect(ids(list.recent)).toEqual([]);
      list = await store.listConversationsOf(owner.id, { query: "milik Bayu" });
      expect([...list.pinned, ...list.recent]).toEqual([]);
      list = await store.listConversationsOf(owner.id, {
        query: "sementara",
      });
      expect([...list.pinned, ...list.recent]).toEqual([]);
      // LIKE wildcards are matched literally.
      for (const query of ["%", "_", "\\"]) {
        list = await store.listConversationsOf(owner.id, { query });
        expect([...list.pinned, ...list.recent], query).toEqual([]);
      }
      // A blank query is no query.
      list = await store.listConversationsOf(owner.id, { query: "  " });
      expect(ids(list.recent)).toEqual([recon]);

      // The other user sees only their own chat.
      list = await store.listConversationsOf(other.id, {
        query: "rekonsiliasi",
      });
      expect(ids(list.recent)).toEqual([theirs]);
    });

    it("keeps a renamed title from the auto title", async () => {
      const d = drizzle({ client });
      const store = await import("@/lib/assistant/conversation-store");
      const user = one(
        await d
          .insert(schema.users)
          .values({
            id: "00000000-0000-7000-8000-00000000c0b1",
            name: "Laras",
            email: "laras@example.invalid",
            role: "qa",
          })
          .returning()
      );
      const titleOf = async (id: string) =>
        one(
          await client`select title, title_source from assistant_conversations where id = ${id}`
        );
      const ask = async (id: string, text: string) => {
        const turn = await store.insertTurn({
          conversationId: id,
          text,
          attachmentIds: [],
          context: { kind: "auto" },
        });
        if (typeof turn === "string") throw new Error(turn);
        await client`update assistant_messages set status = 'done', content = 'Jawaban pertama.' where id = ${turn.assistantMessageId}`;
        return turn;
      };

      const chat = await store.insertConversation({ userId: user.id });
      const turn = await ask(chat, "Kapan batch iuran berjalan?");
      expect(await titleOf(chat)).toEqual({
        title: "Kapan batch iuran berjalan?",
        title_source: "first_message",
      });
      expect(await store.loadTitleInput(chat)).toEqual({
        userId: user.id,
        question: "Kapan batch iuran berjalan?",
        answer: "Jawaban pertama.",
        answerMessageId: turn.assistantMessageId,
      });
      expect(await store.saveGeneratedTitle(chat, "Jadwal batch iuran")).toBe(
        true
      );
      expect(await titleOf(chat)).toEqual({
        title: "Jadwal batch iuran",
        title_source: "generated",
      });
      // Generated once: not again.
      expect(await store.loadTitleInput(chat)).toBeNull();
      expect(await store.saveGeneratedTitle(chat, "Lain")).toBe(false);

      // A rename is the user's: the auto title never overwrites it.
      const renamed = await store.insertConversation({ userId: user.id });
      await ask(renamed, "Siapa pemilik server staging?");
      await store.updateConversationTitle(renamed, "Server staging");
      expect(await titleOf(renamed)).toEqual({
        title: "Server staging",
        title_source: "user",
      });
      expect(await store.loadTitleInput(renamed)).toBeNull();
      expect(await store.saveGeneratedTitle(renamed, "Pemilik server")).toBe(
        false
      );
      expect((await titleOf(renamed)).title).toBe("Server staging");

      // A temporary chat gets no auto title.
      const temporary = await store.insertConversation({
        userId: user.id,
        temporary: true,
      });
      await ask(temporary, "Pertanyaan sementara");
      expect(await store.loadTitleInput(temporary)).toBeNull();
      expect(await store.saveGeneratedTitle(temporary, "Judul")).toBe(false);

      // Only after the first answer is done, and only for the first question.
      const pending = await store.insertConversation({ userId: user.id });
      await store.insertTurn({
        conversationId: pending,
        text: "Masih menunggu",
        attachmentIds: [],
        context: { kind: "auto" },
      });
      expect(await store.loadTitleInput(pending)).toBeNull();
      const longer = await store.insertConversation({ userId: user.id });
      await ask(longer, "Pertama");
      await ask(longer, "Kedua");
      expect(await store.loadTitleInput(longer)).toBeNull();
    });

    it("edits the last question and re-answers it", async () => {
      const d = drizzle({ client });
      const store = await import("@/lib/assistant/conversation-store");
      const turns = await import("@/lib/assistant/turn-store");
      const [user, other] = await d
        .insert(schema.users)
        .values([
          {
            id: "00000000-0000-7000-8000-00000000c0c1",
            name: "Gilang",
            email: "gilang@example.invalid",
            role: "qa",
          },
          {
            id: "00000000-0000-7000-8000-00000000c0c2",
            name: "Rani",
            email: "rani@example.invalid",
            role: "qa",
          },
        ])
        .returning();
      if (!user || !other) throw new Error("users");
      const messages = async (chat: string) =>
        await client`select id, role, status, content from assistant_messages where conversation_id = ${chat} order by id`;

      const chat = await store.insertConversation({ userId: user.id });
      const first = await store.insertTurn({
        conversationId: chat,
        text: "Berapa iuran minimum?",
        attachmentIds: [],
        context: { kind: "auto" },
      });
      if (typeof first === "string") throw new Error(first);

      // Queued or streaming: busy, nothing changed.
      expect(await store.editLastQuestion(user.id, chat, "Ubah")).toBe("busy");
      expect(await turns.claimMessage(first.assistantMessageId)).toBe(true);
      expect(await store.editLastQuestion(user.id, chat, "Ubah")).toBe("busy");
      expect((await messages(chat)).map((m) => m.content)).toEqual([
        "Berapa iuran minimum?",
        "",
      ]);
      await client`update assistant_messages set status = 'done', content = 'Rp 100.000.' where id = ${first.assistantMessageId}`;

      // Another user's chat: not found.
      expect(await store.editLastQuestion(other.id, chat, "Ubah")).toBe(
        "not_found"
      );

      const at = new Date("2026-11-20T08:00:00Z");
      const edited = await store.editLastQuestion(
        user.id,
        chat,
        "Berapa iuran maksimum?",
        at
      );
      if (typeof edited === "string") throw new Error(edited);
      expect(edited.userMessageId).toBe(first.userMessageId);
      expect(await messages(chat)).toEqual([
        {
          id: first.userMessageId,
          role: "user",
          status: "done",
          content: "Berapa iuran maksimum?",
        },
        {
          id: edited.assistantMessageId,
          role: "assistant",
          status: "queued",
          content: "",
        },
      ]);
      // The first question's title follows its edit; updated_at moves.
      expect(
        await client`select title, title_source, updated_at::text as updated_at from assistant_conversations where id = ${chat}`
      ).toEqual([
        {
          title: "Berapa iuran maksimum?",
          title_source: "first_message",
          updated_at: "2026-11-20 08:00:00",
        },
      ]);

      // A renamed title stays; only the last question changes.
      await client`update assistant_messages set status = 'failed', error_code = 'assistant.stopped' where id = ${edited.assistantMessageId}`;
      await store.updateConversationTitle(chat, "Iuran");
      const second = await store.insertTurn({
        conversationId: chat,
        text: "Dan untuk peserta baru?",
        attachmentIds: [],
        context: { kind: "auto" },
      });
      if (typeof second === "string") throw new Error(second);
      await client`update assistant_messages set status = 'failed', error_code = 'assistant.stopped' where id = ${second.assistantMessageId}`;
      const again = await store.editLastQuestion(
        user.id,
        chat,
        "Dan untuk peserta lama?"
      );
      if (typeof again === "string") throw new Error(again);
      expect(again.userMessageId).toBe(second.userMessageId);
      expect((await messages(chat)).map((m) => m.content)).toEqual([
        "Berapa iuran maksimum?",
        "",
        "Dan untuk peserta lama?",
        "",
      ]);
      expect(
        one(
          await client`select title from assistant_conversations where id = ${chat}`
        ).title
      ).toBe("Iuran");

      // An only question with its auto title: the title follows the edit
      // and goes back to first_message, so the new answer is titled again.
      // A title the user gave an only question stays.
      const titled = await store.insertConversation({ userId: user.id });
      const only = await store.insertTurn({
        conversationId: titled,
        text: "Kapan iuran jatuh tempo?",
        attachmentIds: [],
        context: { kind: "auto" },
      });
      if (typeof only === "string") throw new Error(only);
      await client`update assistant_messages set status = 'done', content = 'Tanggal 10.' where id = ${only.assistantMessageId}`;
      await client`update assistant_conversations set title = 'Jatuh tempo iuran', title_source = 'generated' where id = ${titled}`;
      const retitled = await store.editLastQuestion(
        user.id,
        titled,
        "Kapan iuran tambahan jatuh tempo?"
      );
      if (typeof retitled === "string") throw new Error(retitled);
      expect(
        await client`select title, title_source from assistant_conversations where id = ${titled}`
      ).toEqual([
        {
          title: "Kapan iuran tambahan jatuh tempo?",
          title_source: "first_message",
        },
      ]);
      await client`update assistant_messages set status = 'done', content = 'Tanggal 15.' where id = ${retitled.assistantMessageId}`;
      await store.updateConversationTitle(titled, "Tempo");
      const kept = await store.editLastQuestion(user.id, titled, "Lagi?");
      if (typeof kept === "string") throw new Error(kept);
      expect(
        await client`select title, title_source from assistant_conversations where id = ${titled}`
      ).toEqual([{ title: "Tempo", title_source: "user" }]);

      // No question yet: nothing to edit.
      const empty = await store.insertConversation({ userId: user.id });
      expect(await store.editLastQuestion(user.id, empty, "Hai")).toBe(
        "nothing_to_edit"
      );
    });

    it("prunes temporary chats 24 h after their last activity", async () => {
      const d = drizzle({ client });
      const store = await import("@/lib/assistant/conversation-store");
      const user = one(
        await d
          .insert(schema.users)
          .values({
            id: "00000000-0000-7000-8000-00000000c0d1",
            name: "Wira",
            email: "wira@example.invalid",
            role: "qa",
          })
          .returning()
      );
      const now = new Date("2026-11-21T12:00:00Z");
      const DAY = 24 * 60 * 60 * 1000;
      const chat = async (temporary: boolean, lastActivityMs: number) => {
        const id = await store.insertConversation({
          userId: user.id,
          temporary,
        });
        const turn = await store.insertTurn({
          conversationId: id,
          text: "Sementara",
          attachmentIds: [],
          context: { kind: "auto" },
          now: new Date(now.getTime() - lastActivityMs),
        });
        if (typeof turn === "string") throw new Error(turn);
        return { id, turn };
      };
      const stale = await chat(true, DAY + 1000);
      const fresh = await chat(true, DAY - 1000);
      const kept = await chat(false, 3 * DAY);
      await d.insert(schema.assistantFiles).values({
        userId: user.id,
        conversationId: stale.id,
        messageId: stale.turn.userMessageId,
        storageKey: `assistant/${user.id}/stale-file`,
        filename: "catatan.txt",
        mediaType: "text/plain",
        size: 3,
      });

      // Earlier tests' temporary chats are idle at `now` too: they go as well.
      const before =
        await client`select count(*)::int as n from assistant_conversations where temporary and updated_at < ${new Date(now.getTime() - DAY)}`;
      const pruned = await store.deleteStaleTemporaryConversations(now);
      expect(pruned.count).toBe(one(before).n);
      expect(pruned.storageKeys).toEqual([`assistant/${user.id}/stale-file`]);
      const left =
        await client`select id from assistant_conversations where user_id = ${user.id} order by id`;
      expect(left.map((r) => r.id).sort()).toEqual([fresh.id, kept.id].sort());
      expect(
        await client`select id from assistant_messages where conversation_id = ${stale.id}`
      ).toEqual([]);
      // Nothing left to prune at the same instant.
      expect(await store.deleteStaleTemporaryConversations(now)).toEqual({
        count: 0,
        storageKeys: [],
      });
    });
  }
);

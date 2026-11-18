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
        (await store.listConversationsOf(user.id)).find(
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

      // A user message's stream lookup finds nothing; an answer's finds the chat.
      expect(
        await store.findAssistantMessageConversation(first.userMessageId)
      ).toBeNull();
      expect(
        await store.findAssistantMessageConversation(second.assistantMessageId)
      ).toMatchObject({ id: conversationId, userId: user.id });

      await d.insert(schema.assistantToolCalls).values({
        messageId: first.assistantMessageId,
        tool: "read_file",
        input: { path: "backend/Iuran.java" },
        resultMeta: { paths: ["backend/Iuran.java"] },
      });

      // Every conversation of the user, newest first, labelled with the
      // latest question's context.
      const listed = await store.listConversationsOf(user.id);
      expect(listed).toEqual([
        {
          id: conversationId,
          title: "Bagaimana iuran dihitung? Jelaskan.",
          updatedAt: expect.any(Date),
          lastContextLabel: "Kestrel Membership",
          lastContextDeleted: false,
        },
        {
          id: empty,
          title: "",
          updatedAt: expect.any(Date),
          lastContextLabel: null,
          lastContextDeleted: false,
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
      expect(detail?.messages[1]).toMatchObject({ context: null });
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
        (await store.listConversationsOf(user.id))[0]?.lastContextLabel
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

      expect(await store.readStreamSnapshot(first.assistantMessageId)).toEqual({
        content: "Di IuranService.",
        status: "done",
        errorCode: null,
        toolCalls: [
          { tool: "read_file", meta: { paths: ["backend/Iuran.java"] } },
        ],
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
        await store.readStreamSnapshot(first.assistantMessageId)
      ).toMatchObject({
        status: "done",
        errorCode: null,
      });
      expect(
        await store.readStreamSnapshot(second.assistantMessageId)
      ).toMatchObject({
        status: "failed",
        errorCode: "assistant.unavailable",
      });
      expect(await store.readStreamSnapshot(conversationId)).toBeNull();
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
      expect(await turns.saveContent(answer, "late")).toBe(false);
      expect(await turns.saveSources(answer, [])).toBe(false);
      expect(await turns.recordToolCall(answer, "list_files", {}, {})).toBe(
        false
      );
      await turns.finishMessage(answer, { status: "done", content: "late" });
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
      // The live chat's writes still land.
      expect(await turns.saveContent(keptTurn.assistantMessageId, "ok")).toBe(
        true
      );
    });
  }
);

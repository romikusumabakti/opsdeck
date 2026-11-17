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
      expect(await store.environmentOfProject(env.id, project.id)).toEqual({
        id: env.id,
        name: "Dev 1",
      });
      // An environment of another project is not one of this project's.
      expect(
        await store.environmentOfProject(otherEnv.id, project.id)
      ).toBeNull();
      expect(await store.loadAssistantLimits()).toEqual({
        enabled: false,
        hasApiKey: false,
        dailyCapUsd: 1.5,
      });

      const conversationId = await store.insertConversation({
        userId: user.id,
        projectId: project.id,
      });
      const [row] =
        await client`select environment_id, environment_name from assistant_conversations where id = ${conversationId}`;
      expect(row).toEqual({ environment_id: null, environment_name: null });
      await store.insertConversation({
        userId: user.id,
        projectId: otherProject.id,
      });
      expect(await store.findConversation(conversationId)).toEqual({
        id: conversationId,
        userId: user.id,
        projectId: project.id,
      });

      const now = new Date("2026-11-16T03:00:00Z");
      const first = await store.insertTurn({
        conversationId,
        text: "Bagaimana iuran dihitung?\n\nJelaskan.",
        attachmentIds: ["10001"],
        environment: { id: env.id, name: "Dev 1" },
        now,
      });
      if (typeof first === "string") throw new Error(`unexpected ${first}`);
      expect(first.userMessageId < first.assistantMessageId).toBe(true);

      // The first answer is still queued: any further send is busy.
      const [a, b] = await Promise.all([
        store.insertTurn({
          conversationId,
          text: "x",
          attachmentIds: [],
          environment: null,
        }),
        store.insertTurn({
          conversationId,
          text: "y",
          attachmentIds: [],
          environment: null,
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
          environment: null,
        }),
        store.insertTurn({
          conversationId,
          text: "Lalu lagi?",
          attachmentIds: [],
          environment: null,
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

      // Only this project's conversations.
      const listed = await store.listConversationsOf(user.id, project.id);
      expect(listed).toEqual([
        {
          id: conversationId,
          title: "Bagaimana iuran dihitung? Jelaskan.",
          updatedAt: expect.any(Date),
        },
      ]);

      const detail = await store.loadConversationDetail(conversationId);
      // The page checks a ?c= link against its own project.
      expect(detail?.projectId).toBe(project.id);
      expect(detail?.messages.map((m) => [m.role, m.status])).toEqual([
        ["user", "done"],
        ["assistant", "done"],
        ["user", "done"],
        ["assistant", "queued"],
      ]);
      expect(detail?.messages[0]).toMatchObject({
        content: "Bagaimana iuran dihitung?\n\nJelaskan.",
        attachmentIds: ["10001"],
        environmentId: env.id,
        environmentName: "Dev 1",
        environmentDeleted: false,
        toolCalls: [],
      });
      // The answer carries no source; the second question asked about the
      // project branches.
      expect(detail?.messages[1]).toMatchObject({
        environmentId: null,
        environmentName: null,
        environmentDeleted: false,
      });
      expect(detail?.messages[2]).toMatchObject({
        environmentId: null,
        environmentName: null,
        environmentDeleted: false,
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
          environment: { id: env.id, name: "Dev 1" },
        })
      ).toBe("environment_gone");
      expect(
        (await store.loadConversationDetail(conversationId))?.messages
      ).toHaveLength(4);
      await client`update assistant_messages set status = 'queued' where id = ${second.assistantMessageId}`;
      expect(
        (await store.loadConversationDetail(conversationId))?.messages[0]
      ).toMatchObject({
        environmentId: null,
        environmentName: "Dev 1",
        environmentDeleted: true,
      });

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
  }
);

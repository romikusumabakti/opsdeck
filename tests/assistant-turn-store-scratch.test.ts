import { execFileSync, spawnSync } from "node:child_process";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";

// The assistant turn store and usage meter (lib/assistant/turn-store.ts, lib/assistant/usage.ts) against a real Postgres: the local
// menara-postgres container (postgres 18) through its published port, with
// the container's superuser password read from the container and never
// printed. It creates a scratch database, migrates it with `menara migrate`
// and drops it afterwards; no other database is touched.
//
//   ASSISTANT_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/assistant-turn-store-scratch.test.ts
const enabled = process.env.ASSISTANT_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "assistant_turn_store_scratch";

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

describe.skipIf(!enabled)("assistant turn store on a real Postgres", () => {
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
    psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
  });

  it("loads the user's title and timezone, falling back to APP_TIMEZONE", async () => {
    const d = drizzle({ client });
    const store = await import("@/lib/assistant/turn-store");
    const { APP_TIMEZONE } = await import("@/lib/timezone");
    const cases = [
      { n: 1, title: null, timezone: null, expected: APP_TIMEZONE },
      { n: 2, title: "QA Lead", timezone: "Mars/Base", expected: APP_TIMEZONE },
      {
        n: 3,
        title: "Business Analyst",
        timezone: "Asia/Makassar",
        expected: "Asia/Makassar",
      },
    ];
    for (const c of cases) {
      const user = one(
        await d
          .insert(schema.users)
          .values({
            id: `00000000-0000-7000-8000-00000000c00${c.n}`,
            name: `User ${c.n}`,
            email: `tz${c.n}@example.com`,
            role: "qa",
            title: c.title,
            timezone: c.timezone,
          })
          .returning()
      );
      const conversation = one(
        await d
          .insert(schema.assistantConversations)
          .values({ userId: user.id })
          .returning()
      );
      await d.insert(schema.assistantMessages).values({
        conversationId: conversation.id,
        role: "user",
        status: "done",
        content: "Q",
      });
      const answer = one(
        await d
          .insert(schema.assistantMessages)
          .values({
            conversationId: conversation.id,
            role: "assistant",
            status: "queued",
            content: "",
          })
          .returning()
      );
      expect(await store.loadTurn(answer.id), `case ${c.n}`).toMatchObject({
        userTitle: c.title,
        timeZone: c.expected,
      });
      await client`delete from assistant_conversations where id = ${conversation.id}`;
      await client`delete from users where id = ${user.id}`;
    }
  });

  it("loads a turn, moves it through its statuses and meters usage", async () => {
    const d = drizzle({ client });
    const store = await import("@/lib/assistant/turn-store");
    const { recordUsage, spentTodayUsd } = await import(
      "@/lib/assistant/usage"
    );

    const user = one(
      await d
        .insert(schema.users)
        .values({
          id: "00000000-0000-7000-8000-00000000b001",
          name: "Widya Astuti",
          preferredName: "Widya",
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
    const env = one(
      await d
        .insert(schema.environments)
        .values({ projectId: project.id, name: "Dev 1", slug: "dev-1" })
        .returning()
    );
    // A conversation from before per-question sources: its own environment
    // fields are not what a turn reads.
    const conversation = one(
      await d
        .insert(schema.assistantConversations)
        .values({
          userId: user.id,
          projectId: project.id,
          environmentName: "Legacy",
        })
        .returning()
    );
    const message = async (
      role: "user" | "assistant",
      status: "queued" | "streaming" | "done" | "failed",
      content = "",
      attachmentIds: string[] = [],
      context: Partial<{
        projectId: string;
        projectName: string;
        environmentId: string;
        environmentName: string;
      }> = {},
      conversationId = conversation.id
    ) =>
      one(
        await d
          .insert(schema.assistantMessages)
          .values({
            conversationId,
            role,
            status,
            content,
            attachmentIds,
            ...context,
          })
          .returning()
      );
    const branches = { projectId: project.id, projectName: project.name };
    await message("user", "done", "Q1", [], branches);
    await message("assistant", "done", "A1");
    await message("user", "done", "Q2", ["att-1"], {
      ...branches,
      environmentId: env.id,
      environmentName: "Dev 1",
    });
    const answer = await message("assistant", "queued");

    const turn = await store.loadTurn(answer.id);
    expect(turn).toMatchObject({
      status: "queued",
      userId: user.id,
      userName: "Widya Astuti",
      preferredName: "Widya",
      // The context of the question this turn answers (Q2), not Q1's.
      context: {
        kind: "environment",
        environmentId: env.id,
        environmentName: "Dev 1",
        projectId: project.id,
        projectName: "Kestrel Membership",
      },
      attachmentIds: ["att-1"],
    });
    expect(turn?.history.map((m) => m.content)).toEqual(["Q1", "A1", "Q2"]);
    // Each replayed question keeps the context it asked about.
    expect(turn?.history.map((m) => m.context?.kind ?? null)).toEqual([
      "project",
      null,
      "environment",
    ]);
    expect(await store.loadTurn(conversation.id)).toBeNull();

    // A conversation without a project (the global assistant) loads too; an
    // automatic question has no project.
    const global = one(
      await d
        .insert(schema.assistantConversations)
        .values({ userId: user.id })
        .returning()
    );
    await message("user", "done", "Apa saja?", [], {}, global.id);
    const globalAnswer = await message(
      "assistant",
      "queued",
      "",
      [],
      {},
      global.id
    );
    expect(await store.loadTurn(globalAnswer.id)).toMatchObject({
      conversationId: global.id,
      context: { kind: "auto" },
    });
    await client`delete from assistant_conversations where id = ${global.id}`;

    expect(await store.claimMessage(answer.id)).toBe(true);
    expect(await store.claimMessage(answer.id)).toBe(false);
    // The claim records the answer's stream id: its own id.
    const [claimed] =
      await client`select active_stream_id from assistant_messages where id = ${answer.id}`;
    expect(claimed?.active_stream_id).toBe(answer.id);
    const parts = [
      { type: "step-start" as const },
      { type: "text" as const, text: "partial", state: "done" as const },
      {
        type: "dynamic-tool" as const,
        toolName: "search_code",
        toolCallId: "tu_1",
        state: "output-available" as const,
        input: { pattern: "x" },
        output: { ok: true, meta: { paths: ["backend/a.java"] } },
      },
    ];
    expect(
      await store.saveParts(answer.id, { parts, content: "partial" })
    ).toBe(true);
    // Stored as a jsonb array, not a JSON string.
    const [saved] =
      await client`select jsonb_typeof(parts) as kind, parts, content from assistant_messages where id = ${answer.id}`;
    expect(saved).toMatchObject({ kind: "array", parts, content: "partial" });
    await store.recordToolCall(
      answer.id,
      "search_code",
      { pattern: "x" },
      {
        paths: ["backend/a.java"],
      }
    );
    await store.finishMessage(answer.id, {
      status: "failed",
      content: "partial",
      errorCode: "assistant.credit_exhausted",
    });
    const [row] =
      await client`select status, content, error_code, finished_at from assistant_messages where id = ${answer.id}`;
    expect(row).toMatchObject({
      status: "failed",
      content: "partial",
      error_code: "assistant.credit_exhausted",
    });
    expect(row?.finished_at).not.toBeNull();
    // A failure without parts keeps the parts saved so far.
    const [kept] =
      await client`select parts, active_stream_id from assistant_messages where id = ${answer.id}`;
    expect(kept?.parts).toEqual(parts);
    expect(kept?.active_stream_id).toBe(answer.id);
    // Released whatever the status.
    await store.releaseStream(answer.id);
    const [released] =
      await client`select active_stream_id from assistant_messages where id = ${answer.id}`;
    expect(released?.active_stream_id).toBeNull();

    // The first terminal write wins: a second finish is a no-op.
    await store.finishMessage(answer.id, {
      status: "done",
      content: "late",
      parts: [],
    });
    const [again] =
      await client`select status, content, error_code from assistant_messages where id = ${answer.id}`;
    expect(again).toMatchObject({
      status: "failed",
      content: "partial",
      error_code: "assistant.credit_exhausted",
    });
    // A queued (never claimed) message is not finished either.
    const unclaimed = await message("assistant", "queued");
    await store.finishMessage(unclaimed.id, {
      status: "done",
      content: "x",
      parts: [],
    });
    const [still] =
      await client`select status from assistant_messages where id = ${unclaimed.id}`;
    expect(still?.status).toBe("queued");
    await client`delete from assistant_messages where id = ${unclaimed.id}`;

    // Usage: two rows on the Jakarta day 2026-11-16 (23:30 UTC on the 15th),
    // one on the next day.
    const usage = {
      input: 1000,
      output: 200,
      cacheRead: 5000,
      cacheWrite: 2000,
    };
    const prices = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
    const day = new Date("2026-11-15T23:30:00Z");
    const cost = await recordUsage({
      messageId: answer.id,
      userId: user.id,
      modelId: "acme-max",
      prices,
      usage,
      estimated: false,
      now: day,
    });
    await recordUsage({
      messageId: null,
      userId: user.id,
      modelId: "acme-max",
      prices,
      usage,
      estimated: false,
      now: day,
    });
    await recordUsage({
      messageId: answer.id,
      userId: user.id,
      modelId: "acme-max",
      prices,
      usage,
      estimated: false,
      now: new Date("2026-11-16T17:30:00Z"),
    });
    expect(cost).toBeCloseTo(0.019, 6);
    expect(
      await spentTodayUsd(user.id, new Date("2026-11-16T10:00:00Z"))
    ).toBeCloseTo(0.038, 6);
    expect(
      await spentTodayUsd(user.id, new Date("2026-11-17T10:00:00Z"))
    ).toBeCloseTo(0.019, 6);

    // Boot sweep: only queued/streaming rows older than 15 minutes.
    const stale = await message("assistant", "streaming", "half");
    const fresh = await message("assistant", "queued");
    await client`update assistant_messages set created_at = now() - interval '20 minutes', active_stream_id = ${stale.id} where id = ${stale.id}`;
    expect(await store.failStaleAssistantMessages()).toBe(1);
    const rows =
      await client`select id, status, error_code, content, active_stream_id from assistant_messages where id in (${stale.id}, ${fresh.id})`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(stale.id)).toMatchObject({
      status: "failed",
      error_code: "assistant.interrupted",
      active_stream_id: null,
      content: "half",
    });
    expect(byId.get(fresh.id)).toMatchObject({ status: "queued" });

    // The turn that lost its worker cannot overwrite the sweep's outcome.
    await store.finishMessage(stale.id, {
      status: "done",
      content: "too late",
      parts: [],
    });
    const [swept] =
      await client`select status, content from assistant_messages where id = ${stale.id}`;
    expect(swept).toMatchObject({ status: "failed", content: "half" });

    // A stopped (failed) answer takes no more content or sources.
    const stopped = await message("assistant", "failed", "kept");
    expect(
      await store.saveParts(stopped.id, { parts: [], content: "more" })
    ).toBe(false);
    expect(await store.saveSources(stopped.id, [])).toBe(false);
    const [after] =
      await client`select content, sources from assistant_messages where id = ${stopped.id}`;
    expect(after?.content).toBe("kept");
    expect(after?.sources).toBeNull();
    const live = await message("assistant", "streaming");
    expect(await store.saveParts(live.id, { parts: [], content: "x" })).toBe(
      true
    );
    // A tool call is audited only while the answer streams.
    expect(await store.recordToolCall(stopped.id, "search_code", {}, {})).toBe(
      false
    );
    expect(
      await client`select 1 from assistant_tool_calls where message_id = ${stopped.id}`
    ).toHaveLength(0);
    expect(
      await store.recordToolCall(live.id, "search_code", { a: 1 }, { b: 2 })
    ).toBe(true);
    expect(
      await client`select tool, input, result_meta from assistant_tool_calls where message_id = ${live.id}`
    ).toEqual([
      { tool: "search_code", input: { a: 1 }, result_meta: { b: 2 } },
    ]);
  });
});

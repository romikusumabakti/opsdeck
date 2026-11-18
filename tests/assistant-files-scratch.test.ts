import { execFileSync, spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";

// Assistant uploads (lib/assistant/file-store.ts, insertTurn, loadTurn) against a real Postgres: the local
// menara-postgres container (postgres 18) through its published port, with
// the container's superuser password read from the container and never
// printed. It creates a scratch database, migrates it with `menara migrate`
// and drops it afterwards; no other database is touched.
//
//   ASSISTANT_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/assistant-files-scratch.test.ts
const enabled = process.env.ASSISTANT_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "assistant_files_scratch";

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

describe.skipIf(!enabled)("assistant uploads on a real Postgres", () => {
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

  it("attaches only the owner's unsent uploads, prunes stale ones and reads a chat's files", async () => {
    const d = drizzle({ client });
    const store = await import("@/lib/assistant/conversation-store");
    const files = await import("@/lib/assistant/file-store");
    const turns = await import("@/lib/assistant/turn-store");

    const [owner, other] = await d
      .insert(schema.users)
      .values([
        {
          id: "00000000-0000-7000-8000-00000000f001",
          name: "Wulan",
          email: "qa@example.com",
          role: "qa",
        },
        {
          id: "00000000-0000-7000-8000-00000000f002",
          name: "Bayu",
          email: "pm@example.com",
          role: "pm",
        },
      ])
      .returning();
    if (!owner || !other) throw new Error("users");
    const chat = await store.insertConversation({ userId: owner.id });
    const otherChat = await store.insertConversation({ userId: owner.id });

    const add = async (userId: string, n: number) => {
      const id = `00000000-0000-7000-8000-0000000a${String(n).padStart(4, "0")}`;
      await files.insertUpload({
        id,
        userId,
        storageKey: `assistant/${userId}/${id}`,
        filename: `f${n}.png`,
        mediaType: "image/png",
        size: 10 + n,
      });
      return id;
    };
    const mine = await add(owner.id, 1);
    const second = await add(owner.id, 2);
    const theirs = await add(other.id, 3);
    expect(await files.countUnsentUploads(owner.id)).toBe(2);

    const auto = { kind: "auto" } as const;
    const messageCount = async () =>
      Number(
        one(await client`select count(*)::int as n from assistant_messages`).n
      );

    // Another user's file: nothing written, the file stays unsent.
    expect(
      await store.insertTurn({
        conversationId: chat,
        text: "Look",
        attachmentIds: [],
        fileIds: [mine, theirs],
        context: auto,
      })
    ).toBe("files_gone");
    expect(await messageCount()).toBe(0);
    expect(await files.countUnsentUploads(owner.id)).toBe(2);

    const turn = await store.insertTurn({
      conversationId: chat,
      text: "Look",
      attachmentIds: [],
      fileIds: [mine],
      context: auto,
    });
    if (typeof turn === "string") throw new Error(`unexpected ${turn}`);
    const [attached] = await d
      .select()
      .from(schema.assistantFiles)
      .where(eq(schema.assistantFiles.id, mine));
    expect(attached).toMatchObject({
      messageId: turn.userMessageId,
      conversationId: chat,
    });

    // Sent already: not again, not into another chat, not removable.
    await d
      .update(schema.assistantMessages)
      .set({ status: "done" })
      .where(eq(schema.assistantMessages.id, turn.assistantMessageId));
    expect(
      await store.insertTurn({
        conversationId: otherChat,
        text: "Again",
        attachmentIds: [],
        fileIds: [mine],
        context: auto,
      })
    ).toBe("files_gone");
    expect(await files.deleteUnsentUpload(owner.id, mine)).toBeNull();
    // Another user's upload is not theirs to remove; the owner's is.
    expect(await files.deleteUnsentUpload(owner.id, theirs)).toBeNull();
    expect(await files.deleteUnsentUpload(owner.id, second)).toBe(
      `assistant/${owner.id}/${second}`
    );

    // The chat reads its files back, on the question that carried them.
    const detail = await store.loadConversationDetail(chat);
    expect(detail?.messages.map((m) => m.files)).toEqual([
      [{ id: mine, filename: "f1.png", mediaType: "image/png", size: 11 }],
      [],
    ]);
    // The turn may read the files of its chat's earlier questions only.
    const loaded = await turns.loadTurn(turn.assistantMessageId);
    expect(loaded?.uploads).toEqual([
      {
        id: mine,
        filename: "f1.png",
        mediaType: "image/png",
        size: 11,
        storageKey: `assistant/${owner.id}/${mine}`,
      },
    ]);
    expect(loaded?.history[0]?.files).toEqual([
      { id: mine, filename: "f1.png", mediaType: "image/png", size: 11 },
    ]);
    const otherTurn = await store.insertTurn({
      conversationId: otherChat,
      text: "Elsewhere",
      attachmentIds: [],
      context: auto,
    });
    if (typeof otherTurn === "string") throw new Error("unexpected");
    expect(
      (await turns.loadTurn(otherTurn.assistantMessageId))?.uploads
    ).toEqual([]);

    // The prune: unsent and older than 24 h only.
    const stale = await add(owner.id, 4);
    await add(owner.id, 5);
    await client`update assistant_files set created_at = now() - interval '25 hours' where id in (${stale}, ${mine}, ${theirs})`;
    expect((await files.deleteStaleUnsentUploads()).sort()).toEqual(
      [
        `assistant/${owner.id}/${stale}`,
        `assistant/${other.id}/${theirs}`,
      ].sort()
    );
    const left = await d
      .select({ id: schema.assistantFiles.id })
      .from(schema.assistantFiles);
    expect(left.map((f) => f.id).sort()).toEqual(
      [mine, "00000000-0000-7000-8000-0000000a0005"].sort()
    );
  });
});

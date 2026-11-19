import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The assistant-parity migration on real rows: a throwaway database in the
// local menara-postgres container (superuser password read from the
// container, never printed), dropped afterwards. Every migration before
// 20261201000000_assistant_parity runs first, the fixtures go in, then the
// real drizzle/ folder runs it.
//
//   ASSISTANT_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/assistant-parity-migration-scratch.test.ts
const enabled = process.env.ASSISTANT_SCRATCH_DB === "1";
const MIGRATION = "20261201000000_assistant_parity";

const dbName = `assistant_parity_${randomBytes(4).toString("hex")}`;
const password = enabled
  ? encodeURIComponent(
      execFileSync("podman", [
        "exec",
        "menara-postgres",
        "printenv",
        "POSTGRES_PASSWORD",
      ])
        .toString()
        .trim()
    )
  : "";
const base = `postgres://postgres:${password}@127.0.0.1:5432`;

const USER = "0196b000-0000-7000-8000-000000000001";
const FROM_FIRST = "0196b000-0000-7000-8000-0000000000a1";
const RENAMED = "0196b000-0000-7000-8000-0000000000a2";
const EMPTY = "0196b000-0000-7000-8000-0000000000a3";
const LONG = "0196b000-0000-7000-8000-0000000000a4";
const LONG_QUESTION = `Bagaimana ${"iuran ".repeat(30)}dihitung?`;

/** titleFrom (lib/assistant/conversation-store.ts) as of the migration. */
const titleFrom = (text: string) =>
  Array.from(text.trim().replace(/\s+/g, " ")).slice(0, 80).join("");

describe.skipIf(!enabled)(
  "assistant parity migration on a real Postgres",
  () => {
    const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
    let sql: ReturnType<typeof postgres>;
    let before: string | undefined;

    const sources = async () =>
      Object.fromEntries(
        (
          await sql`select id, title_source from assistant_conversations order by id`
        ).map((r) => [r.id, r.title_source])
      );

    beforeAll(async () => {
      await admin.unsafe(`create database ${dbName}`);
      sql = postgres(`${base}/${dbName}`, {
        max: 2,
        onnotice: () => {},
        connection: { TimeZone: "UTC" },
      });
      const db = drizzle({ client: sql });
      before = mkdtempSync(join(tmpdir(), "menara-assistant-parity-"));
      for (const entry of readdirSync("drizzle")) {
        if (entry === MIGRATION) continue;
        cpSync(join("drizzle", entry), join(before, entry), {
          recursive: true,
        });
      }
      await migrate(db, { migrationsFolder: before });

      await sql`insert into users (id, name, email, role)
      values (${USER}, 'Sekar', 'sekar@example.invalid', 'qa')`;
      const question = "  Bagaimana   iuran\n\ndihitung?  ";
      await sql`insert into assistant_conversations (id, user_id, title) values
      (${FROM_FIRST}, ${USER}, ${titleFrom(question)}),
      (${RENAMED}, ${USER}, 'Iuran tambahan'),
      (${EMPTY}, ${USER}, ''),
      (${LONG}, ${USER}, ${titleFrom(LONG_QUESTION)})`;
      await sql`insert into assistant_messages (conversation_id, role, status, content) values
      (${FROM_FIRST}, 'user', 'done', ${question}),
      (${FROM_FIRST}, 'assistant', 'done', 'Di IuranService.'),
      (${FROM_FIRST}, 'user', 'done', 'Lalu?'),
      (${RENAMED}, 'user', 'done', 'Bagaimana iuran tambahan dihitung?'),
      (${LONG}, 'user', 'done', ${LONG_QUESTION})`;

      await migrate(db, { migrationsFolder: "drizzle" });
    });

    afterAll(async () => {
      if (before) rmSync(before, { recursive: true, force: true });
      await sql?.end();
      await admin.unsafe(`drop database if exists ${dbName} with (force)`);
      await admin.end();
    });

    it("marks only renamed chats as the user's; the rest keep their first-message title", async () => {
      expect(await sources()).toEqual({
        [FROM_FIRST]: "first_message",
        [RENAMED]: "user",
        [EMPTY]: "first_message",
        [LONG]: "first_message",
      });
      expect(
        await sql`select distinct temporary, pinned_at from assistant_conversations`
      ).toEqual([{ temporary: false, pinned_at: null }]);
    });

    it("is rerunnable: the backfill changes nothing a second time", async () => {
      const backfill = readFileSync(
        join("drizzle", MIGRATION, "migration.sql"),
        "utf8"
      )
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .find((s) => s.includes("UPDATE"));
      if (!backfill) throw new Error("no backfill statement");
      const snapshot = await sources();
      await sql.unsafe(backfill);
      expect(await sources()).toEqual(snapshot);
    });

    it("refuses an unknown title source", async () => {
      await expect(
        sql`update assistant_conversations set title_source = 'model' where id = ${EMPTY}`
      ).rejects.toThrow(/assistant_conversations_title_source_check/);
    });

    it("adds the Assistant database access columns, off by default", async () => {
      const columns =
        await sql`select column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_name = 'environment_services' and column_name like 'assistant_db_%'
      order by column_name`;
      expect(columns).toEqual([
        {
          column_name: "assistant_db_enabled",
          data_type: "boolean",
          is_nullable: "NO",
          column_default: "false",
        },
        {
          column_name: "assistant_db_enabled_at",
          data_type: "timestamp without time zone",
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "assistant_db_enabled_by",
          data_type: "uuid",
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "assistant_db_login",
          data_type: "text",
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "assistant_db_password",
          data_type: "text",
          is_nullable: "YES",
          column_default: null,
        },
      ]);
    });
  }
);

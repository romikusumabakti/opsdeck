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

// The chats-and-files migration (preferred names, assistant_files). Its text
// rules always run; its effect on Stage 2b rows needs the local
// menara-postgres container (superuser password read from the container,
// never printed): a throwaway database gets every earlier migration, the
// fixtures go in, then the real drizzle/ folder runs it.
//
//   ASSISTANT_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/assistant-chats-files-migration-scratch.test.ts
const enabled = process.env.ASSISTANT_SCRATCH_DB === "1";
const MIGRATION = "20261124000000_assistant_chats_files";
const migrationSql = readFileSync(
  join("drizzle", MIGRATION, "migration.sql"),
  "utf8"
);

describe("assistant chats and files migration, as text", () => {
  it("follows the migrator rules and sorts right after the global assistant", () => {
    expect(migrationSql).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(
      migrationSql.startsWith(
        "SET LOCAL lock_timeout = '5s';--> statement-breakpoint"
      )
    ).toBe(true);
    const folders = readdirSync("drizzle").sort();
    expect(folders.indexOf(MIGRATION)).toBe(
      folders.indexOf("20261123000000_global_assistant") + 1
    );
  });

  it("is expand only: a nullable column and a new table", () => {
    expect(migrationSql).not.toMatch(
      /\b(DROP|RENAME|TRUNCATE|DELETE FROM|UPDATE)\b/
    );
    expect(migrationSql).toContain(
      'ALTER TABLE "users" ADD COLUMN "preferred_name" text;'
    );
    expect(migrationSql).toContain('CREATE TABLE "assistant_files"');
    expect(migrationSql).not.toMatch(/ADD COLUMN [^;]*NOT NULL/);
  });
});

function foldersBefore(folder: string): string {
  const dir = mkdtempSync(join(tmpdir(), "menara-chats-files-migration-"));
  for (const entry of readdirSync("drizzle")) {
    if (entry >= folder) continue;
    cpSync(join("drizzle", entry), join(dir, entry), { recursive: true });
  }
  return dir;
}

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
const dbName = `assistant_chats_files_${randomBytes(4).toString("hex")}`;

const id = (n: number) =>
  `019a0000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const USER = id(1);
const PROJECT = id(2);
const CHAT = id(11); // a Stage 2b chat (no project of its own)
const Q1 = id(21);
const A1 = id(22);
const USAGE = id(31);
const DRAFT = id(41);

describe.skipIf(!enabled)(
  "assistant chats and files migration on a real Postgres",
  () => {
    const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
    let sql: ReturnType<typeof postgres>;
    let before: string | undefined;

    beforeAll(async () => {
      await admin.unsafe(`create database ${dbName}`);
      sql = postgres(`${base}/${dbName}`, {
        max: 2,
        onnotice: () => {},
        connection: { TimeZone: "UTC" },
      });
      const db = drizzle({ client: sql });
      before = foldersBefore(MIGRATION);
      await migrate(db, { migrationsFolder: before });

      await sql`insert into users (id, name, email) values
        (${USER}, 'Ana Maria Lopez', 'engineer@example.invalid')`;
      await sql`insert into projects (id, name, key) values
        (${PROJECT}, 'Acme', 'ACME')`;
      await sql`insert into assistant_conversations (id, user_id, title)
        values (${CHAT}, ${USER}, 'Login flow')`;
      await sql`insert into assistant_messages
        (id, conversation_id, role, status, content, project_id, project_name)
        values
        (${Q1}, ${CHAT}, 'user', 'done', 'How does login work?', ${PROJECT}, 'Acme'),
        (${A1}, ${CHAT}, 'assistant', 'done', 'It checks…', null, null)`;
      await sql`insert into assistant_usage
        (id, message_id, user_id, model, cost_usd, day)
        values (${USAGE}, ${A1}, ${USER}, 'mock', 0.01, '2026-11-18')`;
      await sql`insert into assistant_drafts (id, conversation_id, kind, content, project_id)
        values (${DRAFT}, ${CHAT}, 'brd', '{}', ${PROJECT})`;

      await migrate(db, { migrationsFolder: "drizzle" });
    });

    afterAll(async () => {
      if (before) rmSync(before, { recursive: true, force: true });
      await sql?.end();
      await admin.unsafe(`drop database if exists ${dbName} with (force)`);
      await admin.end();
    });

    it("keeps the Stage 2b rows and gives users an empty preferred name", async () => {
      expect(await sql`select id, name, preferred_name from users`).toEqual([
        { id: USER, name: "Ana Maria Lopez", preferred_name: null },
      ]);
      expect(await sql`select id, title from assistant_conversations`).toEqual([
        { id: CHAT, title: "Login flow" },
      ]);
      expect(
        await sql`select id, project_name from assistant_messages order by id`
      ).toEqual([
        { id: Q1, project_name: "Acme" },
        { id: A1, project_name: null },
      ]);
      const [usage] =
        await sql`select message_id from assistant_usage where id = ${USAGE}`;
      expect(usage).toEqual({ message_id: A1 });
    });

    it("creates assistant_files with its columns and index", async () => {
      const columns = await sql`select column_name, data_type, is_nullable
        from information_schema.columns where table_name = 'assistant_files'
        order by ordinal_position`;
      expect(columns).toEqual([
        { column_name: "id", data_type: "uuid", is_nullable: "NO" },
        { column_name: "user_id", data_type: "uuid", is_nullable: "NO" },
        {
          column_name: "conversation_id",
          data_type: "uuid",
          is_nullable: "YES",
        },
        { column_name: "message_id", data_type: "uuid", is_nullable: "YES" },
        { column_name: "storage_key", data_type: "text", is_nullable: "NO" },
        { column_name: "filename", data_type: "text", is_nullable: "NO" },
        { column_name: "media_type", data_type: "text", is_nullable: "NO" },
        { column_name: "size", data_type: "integer", is_nullable: "NO" },
        {
          column_name: "created_at",
          data_type: "timestamp without time zone",
          is_nullable: "NO",
        },
      ]);
      const [index] = await sql`select indexdef from pg_indexes
        where tablename = 'assistant_files'
        and indexname = 'assistant_files_user_created_idx'`;
      expect(index?.indexdef).toMatch(/\(user_id, created_at\)/);
    });

    it("cascades files with their message, chat and user; usage survives with message_id null", async () => {
      const unsent = id(51); // uploaded, not sent yet: no message
      const sent = id(52);
      const [generated] = await sql`insert into assistant_files
        (user_id, conversation_id, storage_key, filename, media_type, size)
        values (${USER}, ${CHAT}, 'assistant/a', 'a.png', 'image/png', 10)
        returning id`;
      // uuidv7 default: version nibble 7.
      expect(String(generated?.id)[14]).toBe("7");
      await sql`insert into assistant_files
        (id, user_id, conversation_id, message_id, storage_key, filename, media_type, size)
        values
        (${unsent}, ${USER}, null, null, 'assistant/b', 'b.pdf', 'application/pdf', 20),
        (${sent}, ${USER}, ${CHAT}, ${Q1}, 'assistant/c', 'c.csv', 'text/csv', 30)`;

      await sql`delete from assistant_messages where id in (${Q1}, ${A1})`;
      const [usage] =
        await sql`select message_id from assistant_usage where id = ${USAGE}`;
      expect(usage).toEqual({ message_id: null });
      expect(
        (await sql`select id from assistant_files order by id`).map((r) => r.id)
      ).not.toContain(sent);

      await sql`delete from assistant_conversations where id = ${CHAT}`;
      expect(
        (await sql`select id from assistant_files`).map((r) => r.id)
      ).toEqual([unsent]);
      expect(
        await sql`select id from assistant_usage where id = ${USAGE}`
      ).toHaveLength(1);

      await sql`delete from users where id = ${USER}`;
      expect(await sql`select id from assistant_files`).toEqual([]);
    });
  }
);

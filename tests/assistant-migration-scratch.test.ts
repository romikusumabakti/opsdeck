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

// The assistant-providers migration. Its text rules always run; its effect on
// real rows needs the local menara-postgres container (superuser password
// read from the container, never printed): a throwaway database gets every
// migration before 20261122000000_assistant_providers, the fixtures go in,
// then the real drizzle/ folder runs the migration and its backfill.
//
//   ASSISTANT_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/assistant-migration-scratch.test.ts
const enabled = process.env.ASSISTANT_SCRATCH_DB === "1";
const MIGRATION = "20261122000000_assistant_providers";
const migrationSql = readFileSync(
  join("drizzle", MIGRATION, "migration.sql"),
  "utf8"
);
const statements = migrationSql
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim());

describe("assistant providers migration, as text", () => {
  it("follows the migrator rules", () => {
    expect(migrationSql).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(
      migrationSql.startsWith(
        "SET LOCAL lock_timeout = '5s';--> statement-breakpoint"
      )
    ).toBe(true);
  });

  it("is expand only: drops only a default and NOT NULLs, renames nothing", () => {
    // The relaxations and the FK action are the point; anything else that
    // drops, renames or deletes fails.
    const withoutRelaxing = migrationSql
      .replace(/\bDROP (DEFAULT|NOT NULL)\b/g, "")
      .replace(/\bON DELETE SET NULL\b/g, "");
    expect(withoutRelaxing).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE)\b/);
    expect(migrationSql).toContain(
      'ALTER TABLE "instance_settings" ALTER COLUMN "assistant_model" DROP DEFAULT'
    );
  });

  it("sorts right after the organisation context migration", () => {
    const folders = readdirSync("drizzle").sort();
    expect(folders.indexOf(MIGRATION)).toBe(
      folders.indexOf("20261121000000_assistant_org_context") + 1
    );
    expect(folders.at(-1)).toBe(MIGRATION);
  });
});

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
const dbName = `assistant_providers_${randomBytes(4).toString("hex")}`;

const id = (n: number) =>
  `019a0000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const USER = id(1);
const PROJECT = id(2);
const ENV = id(3);
const KEPT = id(11); // conversation whose environment still exists
const ORPHAN = id(12); // conversation whose environment was deleted
const Q1 = id(21);
const A1 = id(22);
const Q2 = id(23);
// Ciphertext is opaque to the migration: any string is copied as is.
const STORED_KEY = "enc:v1:fixture-ciphertext";

describe.skipIf(!enabled)(
  "assistant providers migration on a real Postgres",
  () => {
    const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
    let sql: ReturnType<typeof postgres>;
    let before: string | undefined;

    const settings = async () => {
      const [row] = await sql`select assistant_provider, assistant_api_key,
        assistant_base_url, assistant_model,
        assistant_price_input::float8 as input,
        assistant_price_output::float8 as output,
        assistant_price_cache_read::float8 as cache_read,
        assistant_price_cache_write::float8 as cache_write
        from instance_settings where id = 1`;
      if (!row) throw new Error("no settings row");
      return row;
    };
    const backfill = () => {
      const update = statements.find((s) =>
        s.startsWith('UPDATE "instance_settings"')
      );
      if (!update) throw new Error("no settings backfill in the migration");
      return sql.unsafe(update);
    };

    beforeAll(async () => {
      await admin.unsafe(`create database ${dbName}`);
      sql = postgres(`${base}/${dbName}`, {
        max: 2,
        onnotice: () => {},
        connection: { TimeZone: "UTC" },
      });
      const db = drizzle({ client: sql });

      before = mkdtempSync(join(tmpdir(), "menara-assistant-providers-"));
      for (const entry of readdirSync("drizzle")) {
        if (entry === MIGRATION) continue;
        cpSync(join("drizzle", entry), join(before, entry), {
          recursive: true,
        });
      }
      await migrate(db, { migrationsFolder: before });

      await sql`update instance_settings set assistant_enabled = true,
        anthropic_api_key = ${STORED_KEY}, assistant_model = 'claude-sonnet-5-5'
        where id = 1`;
      await sql`insert into users (id, name, email) values
        (${USER}, 'Engineer', 'engineer@example.invalid')`;
      await sql`insert into projects (id, name, key) values
        (${PROJECT}, 'Acme', 'ACME')`;
      await sql`insert into environments (id, project_id, name, slug)
        values (${ENV}, ${PROJECT}, 'Staging', 'staging')`;
      await sql`insert into assistant_conversations
        (id, user_id, project_id, environment_id, environment_name) values
        (${KEPT}, ${USER}, ${PROJECT}, ${ENV}, 'Staging'),
        (${ORPHAN}, ${USER}, ${PROJECT}, null, 'Deleted env')`;
      await sql`insert into assistant_messages
        (id, conversation_id, role, status) values
        (${Q1}, ${KEPT}, 'user', 'done'),
        (${A1}, ${KEPT}, 'assistant', 'done'),
        (${Q2}, ${ORPHAN}, 'user', 'done')`;

      await migrate(db, { migrationsFolder: "drizzle" });
    });

    afterAll(async () => {
      if (before) rmSync(before, { recursive: true, force: true });
      await sql?.end();
      await admin.unsafe(`drop database if exists ${dbName} with (force)`);
      await admin.end();
    });

    it("moves a configured Anthropic key to the provider settings", async () => {
      expect(await settings()).toEqual({
        assistant_provider: "anthropic",
        assistant_api_key: STORED_KEY,
        assistant_base_url: null,
        assistant_model: "claude-sonnet-5-5",
        input: 2,
        output: 10,
        cache_read: 0.1,
        cache_write: 2.5,
      });
      const [legacy] =
        await sql`select anthropic_api_key from instance_settings where id = 1`;
      expect(legacy?.anthropic_api_key).toBe(STORED_KEY);
    });

    it("gives each user message its conversation's environment", async () => {
      const rows = await sql`select id, environment_id, environment_name
        from assistant_messages order by id`;
      expect(rows).toEqual([
        { id: Q1, environment_id: ENV, environment_name: "Staging" },
        { id: A1, environment_id: null, environment_name: null },
        { id: Q2, environment_id: null, environment_name: "Deleted env" },
      ]);
    });

    it("prices Opus, and anything unknown as Sonnet", async () => {
      await sql`update instance_settings set assistant_provider = null,
        assistant_model = 'claude-opus-5-5' where id = 1`;
      await backfill();
      expect(await settings()).toMatchObject({
        assistant_provider: "anthropic",
        input: 4,
        output: 20,
        cache_read: 0.2,
        cache_write: 5,
      });

      await sql`update instance_settings set assistant_provider = null,
        assistant_model = 'claude-legacy' where id = 1`;
      await backfill();
      expect(await settings()).toMatchObject({
        assistant_provider: "anthropic",
        input: 2,
        output: 10,
        cache_read: 0.1,
        cache_write: 2.5,
      });
    });

    it("replaying the backfill never overwrites configured providers", async () => {
      await sql`update instance_settings set assistant_provider = 'openai',
        assistant_api_key = 'enc:v1:other', assistant_model = 'gpt-test',
        assistant_price_input = 1 where id = 1`;
      await backfill();
      expect(await settings()).toMatchObject({
        assistant_provider: "openai",
        assistant_api_key: "enc:v1:other",
        assistant_model: "gpt-test",
        input: 1,
      });
    });

    it("relaxes the model, conversation environment and adds the usage flag", async () => {
      const columns = await sql`select table_name, column_name, is_nullable,
        column_default from information_schema.columns
        where (table_name, column_name) in (
          ('instance_settings', 'assistant_model'),
          ('assistant_conversations', 'environment_name'),
          ('assistant_usage', 'estimated'))
        order by table_name, column_name`;
      expect(columns).toEqual([
        {
          table_name: "assistant_conversations",
          column_name: "environment_name",
          is_nullable: "YES",
          column_default: null,
        },
        {
          table_name: "assistant_usage",
          column_name: "estimated",
          is_nullable: "NO",
          column_default: "false",
        },
        {
          table_name: "instance_settings",
          column_name: "assistant_model",
          is_nullable: "YES",
          column_default: null,
        },
      ]);
      await expect(
        sql`update instance_settings set assistant_provider = 'mystery' where id = 1`
      ).rejects.toThrow(/check/i);
    });

    it("nulls a message's environment when the environment is deleted", async () => {
      await sql`delete from environments where id = ${ENV}`;
      const [row] = await sql`select environment_id, environment_name
        from assistant_messages where id = ${Q1}`;
      expect(row).toEqual({
        environment_id: null,
        environment_name: "Staging",
      });
    });
  }
);

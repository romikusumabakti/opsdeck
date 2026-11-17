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

// The assistant-providers and global-assistant migrations. Their text rules
// always run; their effect on real rows needs the local menara-postgres
// container (superuser password read from the container, never printed): a
// throwaway database gets every migration before the one under test, the
// fixtures go in, then the real drizzle/ folder runs it and its backfill.
//
//   ASSISTANT_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/assistant-migration-scratch.test.ts
const enabled = process.env.ASSISTANT_SCRATCH_DB === "1";
const MIGRATION = "20261122000000_assistant_providers";
const GLOBAL = "20261123000000_global_assistant";
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
  });
});

const globalSql = readFileSync(
  join("drizzle", GLOBAL, "migration.sql"),
  "utf8"
);

describe("global assistant migration, as text", () => {
  it("follows the migrator rules and sorts last, after the providers migration", () => {
    expect(globalSql).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(
      globalSql.startsWith(
        "SET LOCAL lock_timeout = '5s';--> statement-breakpoint"
      )
    ).toBe(true);
    const folders = readdirSync("drizzle").sort();
    expect(folders.indexOf(GLOBAL)).toBe(folders.indexOf(MIGRATION) + 1);
    expect(folders.at(-1)).toBe(GLOBAL);
  });

  it("is expand only: relaxes the conversation's project, adds nullable columns", () => {
    // The one allowed drop: the conversation's project FK is swapped from
    // CASCADE to SET NULL in a single statement.
    const swap =
      'ALTER TABLE "assistant_conversations" DROP CONSTRAINT "assistant_conversations_project_id_projects_id_fk", ADD CONSTRAINT "assistant_conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;';
    expect(globalSql.split(swap)).toHaveLength(2);
    const withoutRelaxing = globalSql
      .replace(swap, "")
      .replace(/\bDROP NOT NULL\b/g, "")
      .replace(/\bON DELETE SET NULL\b/g, "");
    expect(withoutRelaxing).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE)\b/);
    expect(globalSql).toContain(
      'ALTER TABLE "assistant_conversations" ALTER COLUMN "project_id" DROP NOT NULL'
    );
    expect(globalSql).not.toMatch(/ADD COLUMN [^;]*NOT NULL/);
  });
});

/** Every migration folder that sorts before `folder`, copied to a temp dir. */
function foldersBefore(folder: string): string {
  const dir = mkdtempSync(join(tmpdir(), "menara-assistant-migration-"));
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

      before = foldersBefore(MIGRATION);
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

const globalDbName = `global_assistant_${randomBytes(4).toString("hex")}`;
const STAGE2 = id(31); // a Stage 2 conversation, bound to PROJECT
const GONE_ENV = id(32); // its environment, deleted before the migration
const SQ1 = id(41); // question about the project branches
const SA1 = id(42);
const SQ2 = id(43); // question about ENV
const SQ3 = id(44); // question about the deleted environment
const DRAFT = id(51);

describe.skipIf(!enabled)(
  "global assistant migration on a real Postgres",
  () => {
    const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
    let sql: ReturnType<typeof postgres>;
    let before: string | undefined;

    beforeAll(async () => {
      await admin.unsafe(`create database ${globalDbName}`);
      sql = postgres(`${base}/${globalDbName}`, {
        max: 2,
        onnotice: () => {},
        connection: { TimeZone: "UTC" },
      });
      const db = drizzle({ client: sql });
      before = foldersBefore(GLOBAL);
      await migrate(db, { migrationsFolder: before });

      await sql`insert into users (id, name, email) values
        (${USER}, 'Engineer', 'engineer@example.invalid')`;
      await sql`insert into projects (id, name, key) values
        (${PROJECT}, 'Acme', 'ACME')`;
      await sql`insert into environments (id, project_id, name, slug) values
        (${ENV}, ${PROJECT}, 'Staging', 'staging'),
        (${GONE_ENV}, ${PROJECT}, 'Old', 'old')`;
      await sql`insert into assistant_conversations (id, user_id, project_id)
        values (${STAGE2}, ${USER}, ${PROJECT})`;
      await sql`insert into assistant_messages
        (id, conversation_id, role, status, environment_id, environment_name)
        values
        (${SQ1}, ${STAGE2}, 'user', 'done', null, null),
        (${SA1}, ${STAGE2}, 'assistant', 'done', null, null),
        (${SQ2}, ${STAGE2}, 'user', 'done', ${ENV}, 'Staging'),
        (${SQ3}, ${STAGE2}, 'user', 'done', ${GONE_ENV}, 'Old')`;
      await sql`delete from environments where id = ${GONE_ENV}`;
      await sql`insert into assistant_drafts (id, conversation_id, kind, content)
        values (${DRAFT}, ${STAGE2}, 'brd', '{}')`;

      await migrate(db, { migrationsFolder: "drizzle" });
    });

    afterAll(async () => {
      if (before) rmSync(before, { recursive: true, force: true });
      await sql?.end();
      await admin.unsafe(
        `drop database if exists ${globalDbName} with (force)`
      );
      await admin.end();
    });

    it("gives each Stage 2 question its conversation's project, answers none", async () => {
      const rows = await sql`select id, project_id, project_name,
        environment_id, environment_name from assistant_messages order by id`;
      expect(rows).toEqual([
        {
          id: SQ1,
          project_id: PROJECT,
          project_name: "Acme",
          environment_id: null,
          environment_name: null,
        },
        {
          id: SA1,
          project_id: null,
          project_name: null,
          environment_id: null,
          environment_name: null,
        },
        {
          id: SQ2,
          project_id: PROJECT,
          project_name: "Acme",
          environment_id: ENV,
          environment_name: "Staging",
        },
        {
          id: SQ3,
          project_id: PROJECT,
          project_name: "Acme",
          environment_id: null,
          environment_name: "Old",
        },
      ]);
    });

    it("keeps Stage 2 rows readable as pinned contexts", async () => {
      const { contextFromRow } = await import("@/lib/assistant/context");
      const rows = await sql`select project_id as "projectId",
        project_name as "projectName", environment_id as "environmentId",
        environment_name as "environmentName" from assistant_messages
        where role = 'user' order by id`;
      expect(
        rows.map((row) =>
          contextFromRow(row as unknown as Parameters<typeof contextFromRow>[0])
        )
      ).toEqual([
        { kind: "project", projectId: PROJECT, projectName: "Acme" },
        {
          kind: "environment",
          environmentId: ENV,
          environmentName: "Staging",
          projectId: PROJECT,
          projectName: "Acme",
        },
        { kind: "gone", of: "environment", label: "Old" },
      ]);
    });

    it("gives each draft its conversation's project", async () => {
      const [draft] =
        await sql`select project_id from assistant_drafts where id = ${DRAFT}`;
      expect(draft).toEqual({ project_id: PROJECT });
    });

    it("allows a conversation without a project, and keeps conversations when their project is deleted", async () => {
      const { contextFromRow } = await import("@/lib/assistant/context");
      const fresh = id(61);
      await sql`insert into assistant_conversations (id, user_id)
        values (${fresh}, ${USER})`;
      const q = id(62);
      await sql`insert into assistant_messages
        (id, conversation_id, role, status, project_id, project_name)
        values (${q}, ${fresh}, 'user', 'done', ${PROJECT}, 'Acme')`;
      await sql`delete from projects where id = ${PROJECT}`;
      // The Stage 2 conversation stays, its project nulled (SET NULL).
      expect(
        await sql`select id, project_id from assistant_conversations order by id`
      ).toEqual([
        { id: STAGE2, project_id: null },
        { id: fresh, project_id: null },
      ]);
      const [draft] =
        await sql`select project_id from assistant_drafts where id = ${DRAFT}`;
      expect(draft).toEqual({ project_id: null });
      // Every question keeps its name snapshot and reads as gone.
      const rows = await sql`select project_id as "projectId",
        project_name as "projectName", environment_id as "environmentId",
        environment_name as "environmentName" from assistant_messages
        where role = 'user' order by id`;
      expect(
        rows.map((row) =>
          contextFromRow(row as unknown as Parameters<typeof contextFromRow>[0])
        )
      ).toEqual([
        { kind: "gone", of: "project", label: "Acme" },
        { kind: "gone", of: "environment", label: "Staging" },
        { kind: "gone", of: "environment", label: "Old" },
        { kind: "gone", of: "project", label: "Acme" },
      ]);
    });
  }
);

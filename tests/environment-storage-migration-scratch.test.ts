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

// The environment-storage migration and its backup-destination backfill on
// real rows: two throwaway databases made in the local menara-postgres
// container (superuser password read from the container, never printed) and
// dropped afterwards. Every migration before 20261128000000_environment_storage
// runs first, the fixtures go in, then the real drizzle/ folder runs it.
//
//   ENVIRONMENT_STORAGE_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/environment-storage-migration-scratch.test.ts
const enabled = process.env.ENVIRONMENT_STORAGE_SCRATCH === "1";
const MIGRATION = "20261128000000_environment_storage";

const suffix = randomBytes(4).toString("hex");
const dbName = `environment_storage_${suffix}`;
const emptyDbName = `environment_storage_empty_${suffix}`;
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

// Fictional endpoints, buckets and credentials.
const DEST = "0196a000-0000-7000-8000-000000000001";
const OTHER = "0196a000-0000-7000-8000-000000000002";
const ARCHIVE = "0196a000-0000-7000-8000-000000000003";
const PROJECT = "0196a000-0000-7000-8000-000000000004";
const ENV = "0196a000-0000-7000-8000-000000000005";
const DEST_SECRET = "enc:v1:ZmljdGlvbmFsLWNpcGhlcnRleHQ=";

describe.skipIf(!enabled)(
  "environment storage migration on a real Postgres",
  () => {
    const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
    let sql: ReturnType<typeof postgres>;
    let before: string | undefined;

    const settings = async () => {
      const [row] = await sql`select backup_destination_id,
          backup_s3_endpoint, backup_s3_region, backup_s3_bucket,
          backup_s3_access_key_id, backup_s3_secret_key,
          backup_s3_force_path_style, backup_s3_key_prefix
        from instance_settings where id = 1`;
      return row;
    };

    beforeAll(async () => {
      await admin.unsafe(`create database ${dbName}`);
      await admin.unsafe(`create database ${emptyDbName}`);
      sql = postgres(`${base}/${dbName}`, {
        max: 2,
        onnotice: () => {},
        connection: { TimeZone: "UTC" },
      });
      const db = drizzle({ client: sql });

      before = mkdtempSync(join(tmpdir(), "menara-environment-storage-"));
      for (const entry of readdirSync("drizzle")) {
        if (entry === MIGRATION) continue;
        cpSync(join("drizzle", entry), join(before, entry), {
          recursive: true,
        });
      }
      await migrate(db, { migrationsFolder: before });

      await sql`insert into s3_connections
          (id, name, endpoint, region, bucket, access_key_id, secret_key, force_path_style)
        values
          (${DEST}, 'Backups', 'https://s3.example.test', 'eu-west-9',
           'menara-backups', 'AKFICTIONAL1', ${DEST_SECRET}, false),
          (${OTHER}, 'App files', 'https://garage.example.test', 'garage',
           'app-files', 'AKFICTIONAL2', 'legacy-plaintext', true)`;
      await sql`update instance_settings set backup_destination_id = ${DEST}
        where id = 1`;
      await sql`insert into environment_archives
          (id, environment_id, project_name, environment_name, environment_slug,
           expires_at, location, s3_connection_id, key_prefix)
        values (${ARCHIVE}, null, 'Demo', 'Staging', 'staging',
          now() + interval '30 days', 's3', ${DEST}, 'environment-archives/x/')`;
      await sql`insert into projects (id, name, key) values
          (${PROJECT}, 'Demo', 'DEMO')`;
      await sql`insert into environments (id, project_id, name, slug)
          values (${ENV}, ${PROJECT}, 'Staging', 'staging')`;

      await migrate(db, { migrationsFolder: "drizzle" });
    });

    afterAll(async () => {
      if (before) rmSync(before, { recursive: true, force: true });
      await sql?.end();
      await admin.unsafe(`drop database if exists ${dbName} with (force)`);
      await admin.unsafe(`drop database if exists ${emptyDbName} with (force)`);
      await admin.end();
    });

    it("copies the chosen connection into the backup destination", async () => {
      expect(await settings()).toEqual({
        backup_destination_id: DEST,
        backup_s3_endpoint: "https://s3.example.test",
        backup_s3_region: "eu-west-9",
        backup_s3_bucket: "menara-backups",
        backup_s3_access_key_id: "AKFICTIONAL1",
        // Copied as stored: the enc:v1 envelope (or legacy plaintext).
        backup_s3_secret_key: DEST_SECRET,
        backup_s3_force_path_style: false,
        backup_s3_key_prefix: null,
      });
    });

    it("keeps every connection, unassigned and without a prefix", async () => {
      const rows = await sql`select id, environment_id, key_prefix
        from s3_connections order by id`;
      expect(rows).toEqual([
        { id: DEST, environment_id: null, key_prefix: null },
        { id: OTHER, environment_id: null, key_prefix: null },
      ]);
    });

    it("leaves existing archives on their connection", async () => {
      const [row] = await sql`select location, s3_connection_id,
          in_backup_destination, s3_endpoint, s3_bucket
        from environment_archives where id = ${ARCHIVE}`;
      expect(row).toEqual({
        location: "s3",
        s3_connection_id: DEST,
        in_backup_destination: false,
        s3_endpoint: null,
        s3_bucket: null,
      });
    });

    it("is idempotent: re-running the backfill changes nothing", async () => {
      const statements = readFileSync(
        join("drizzle", MIGRATION, "migration.sql"),
        "utf8"
      ).split("--> statement-breakpoint");
      const backfill = statements.filter((s) =>
        /^\s*(--[^\n]*\n)*\s*UPDATE "instance_settings"/.test(s)
      );
      expect(backfill).toHaveLength(1);
      // An admin edits the destination after the migration; a re-run must
      // not overwrite it from the old connection.
      await sql`update instance_settings
        set backup_s3_bucket = 'menara-backups-2' where id = 1`;
      const first = JSON.stringify(await settings());
      for (const statement of backfill) await sql.unsafe(statement);
      expect(JSON.stringify(await settings())).toBe(first);
      await sql`update instance_settings
        set backup_s3_bucket = 'menara-backups' where id = 1`;
    });

    it("assigns a connection to an environment and unassigns it when the environment is deleted", async () => {
      await sql`update s3_connections
        set environment_id = ${ENV}, key_prefix = 'team-a/' where id = ${OTHER}`;
      await sql`delete from environments where id = ${ENV}`;
      const [row] = await sql`select environment_id, key_prefix
        from s3_connections where id = ${OTHER}`;
      expect(row).toEqual({ environment_id: null, key_prefix: "team-a/" });
    });

    it("rejects a key prefix that is not normalised", async () => {
      for (const prefix of ["", "/team-a/", "team-a"]) {
        await expect(
          sql`update s3_connections set key_prefix = ${prefix}
            where id = ${OTHER}`
        ).rejects.toThrow(/s3_connections_key_prefix_check/);
        await expect(
          sql`update instance_settings set backup_s3_key_prefix = ${prefix}
            where id = 1`
        ).rejects.toThrow(/instance_settings_backup_s3_key_prefix_check/);
      }
    });

    it("rejects a partly configured backup destination", async () => {
      await expect(
        sql`update instance_settings set backup_s3_secret_key = null
          where id = 1`
      ).rejects.toThrow(/instance_settings_backup_s3_complete_check/);
    });

    it("accepts a new archive in the backup destination without a connection", async () => {
      await sql`insert into environment_archives
          (environment_id, project_name, environment_name, environment_slug,
           expires_at, location, in_backup_destination, s3_endpoint, s3_bucket,
           key_prefix)
        values (null, 'Demo', 'Prod', 'prod', now() + interval '30 days', 's3',
          true, 'https://s3.example.test', 'menara-backups',
          'environment-archives/y/')`;
      await expect(
        sql`insert into environment_archives
            (environment_id, project_name, environment_name, environment_slug,
             expires_at, location, in_backup_destination, s3_connection_id,
             key_prefix)
          values (null, 'Demo', 'Prod', 'prod', now() + interval '30 days',
            's3', true, ${DEST}, 'environment-archives/z/')`
      ).rejects.toThrow(/environment_archives_backup_destination_check/);
    });

    it("is a no-op on an empty database", async () => {
      const empty = postgres(`${base}/${emptyDbName}`, {
        max: 1,
        onnotice: () => {},
      });
      try {
        await migrate(drizzle({ client: empty }), {
          migrationsFolder: "drizzle",
        });
        const [row] = await empty`select backup_destination_id,
            backup_s3_endpoint, backup_s3_force_path_style
          from instance_settings where id = 1`;
        expect(row).toEqual({
          backup_destination_id: null,
          backup_s3_endpoint: null,
          backup_s3_force_path_style: true,
        });
      } finally {
        await empty.end();
      }
    });
  }
);

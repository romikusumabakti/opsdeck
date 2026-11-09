import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "drizzle/20261113000000_environment_teardown/migration.sql",
  "utf8"
);

describe("environment teardown migration", () => {
  it("follows the migrator rules", () => {
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(sql.startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
  });

  it("is expand only", () => {
    expect(sql).not.toMatch(/\bDROP\b/);
  });

  it("creates the enums", () => {
    expect(sql).toContain(
      `CREATE TYPE "teardown_step_kind" AS ENUM('check_stack', 'archive_database', 'archive_deploy_dir', 'stack_down', 'drop_database', 'remove_tunnel_route', 'remove_access_app', 'remove_dns_record', 'remove_deploy_dir', 'delete_environment')`
    );
    expect(sql).toContain(
      `CREATE TYPE "teardown_step_status" AS ENUM('pending', 'running', 'done', 'failed')`
    );
    expect(sql).toContain(
      `CREATE TYPE "environment_archive_location" AS ENUM('local', 's3')`
    );
  });

  it("adds the teardown run kind", () => {
    expect(sql).toContain(
      `ALTER TYPE "run_kind" ADD VALUE IF NOT EXISTS 'teardown'`
    );
  });

  it("deletes teardown steps with their environment", () => {
    expect(sql).toContain('CREATE TABLE "teardown_steps"');
    expect(sql).toMatch(
      /"teardown_steps_environment_id_fkey" FOREIGN KEY \("environment_id"\) REFERENCES "environments"\("id"\) ON DELETE CASCADE/
    );
    expect(sql).toMatch(
      /"teardown_steps_last_run_id_fkey" FOREIGN KEY \("last_run_id"\) REFERENCES "runs"\("id"\) ON DELETE SET NULL/
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "teardown_steps_environment_position_idx" ON "teardown_steps" ("environment_id","position")'
    );
  });

  it("keeps archives after the environment is deleted", () => {
    const table = sql.slice(
      sql.indexOf('CREATE TABLE "environment_archives"'),
      sql.indexOf('CREATE TABLE "teardown_steps"')
    );
    expect(table).toContain('"environment_id" uuid,');
    for (const column of [
      "project_name",
      "environment_name",
      "environment_slug",
      "deleted_by",
      "expires_at",
      "location",
      "key_prefix",
      "files",
      "completed_at",
    ]) {
      expect(table).toContain(`"${column}"`);
    }
    expect(sql).not.toMatch(
      /"environment_archives"[^;]*REFERENCES "environments"/
    );
    expect(sql).toMatch(
      /"environment_archives_deleted_by_fkey" FOREIGN KEY \("deleted_by"\) REFERENCES "users"\("id"\) ON DELETE SET NULL/
    );
    expect(sql).toContain(
      'CREATE INDEX "environment_archives_environment_idx" ON "environment_archives" ("environment_id")'
    );
  });
});

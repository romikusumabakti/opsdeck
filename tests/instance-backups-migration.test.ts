import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "drizzle/20261110000000_instance_backups/migration.sql",
  "utf8"
);

describe("instance settings and backups migration", () => {
  it("follows the migrator rules", () => {
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(sql).toMatch(/^(--.*\n)*SET LOCAL lock_timeout = '5s';/);
  });

  it("creates both tables and the enums", () => {
    expect(sql).toContain('CREATE TABLE "instance_settings"');
    expect(sql).toContain('CREATE TABLE "instance_backups"');
    expect(sql).toContain(
      `CREATE TYPE "instance_backup_status" AS ENUM('running', 'succeeded', 'failed')`
    );
    expect(sql).toContain(
      `CREATE TYPE "instance_backup_trigger" AS ENUM('schedule', 'manual', 'update')`
    );
  });

  it("seeds the single settings row idempotently", () => {
    expect(sql).toContain(
      "INSERT INTO instance_settings (id) VALUES (1) ON CONFLICT DO NOTHING"
    );
  });
});

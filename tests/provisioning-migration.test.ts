import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "drizzle-legacy/20261105050000_provisioning/migration.sql",
  "utf8"
);

describe("provisioning migration", () => {
  it("adds the provision run kind before the transaction block", () => {
    const add = sql.indexOf(
      `ALTER TYPE "run_kind" ADD VALUE IF NOT EXISTS 'provision'`
    );
    expect(add).toBeGreaterThan(-1);
    expect(add).toBeLessThan(sql.indexOf("BEGIN;"));
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("sets a lock timeout right after BEGIN", () => {
    expect(sql).toMatch(/\nBEGIN;\n(?:--[^\n]*\n)*SET lock_timeout = '5s';\n/);
  });

  it("creates the three enums", () => {
    expect(sql).toMatch(
      /CREATE TYPE database_kind AS ENUM \('shared', 'container', 'external'\)/
    );
    expect(sql).toMatch(
      /CREATE TYPE provisioning_step_kind AS ENUM \(\s*'prepare_deploy_dir',\s*'create_database',\s*'deploy'\s*\)/
    );
    expect(sql).toMatch(
      /CREATE TYPE provisioning_step_status AS ENUM \(\s*'pending',\s*'running',\s*'done',\s*'failed'\s*\)/
    );
  });

  it("creates the two tables", () => {
    expect(sql).toContain("CREATE TABLE database_hosts");
    expect(sql).toContain("CREATE TABLE provisioning_steps");
    expect(sql).toMatch(
      /server_id uuid NOT NULL REFERENCES servers \(id\) ON DELETE RESTRICT/
    );
    expect(sql).toMatch(
      /environment_id uuid NOT NULL REFERENCES environments \(id\) ON DELETE CASCADE/
    );
    expect(sql).toMatch(
      /last_run_id uuid REFERENCES runs \(id\) ON DELETE SET NULL/
    );
    expect(sql).toContain("ON database_hosts (server_id, container_name)");
    expect(sql).toContain("ON provisioning_steps (environment_id, position)");
  });

  it("adds the four nullable service columns and their indexes", () => {
    expect(sql).toContain("ADD COLUMN db_kind database_kind,");
    expect(sql).toMatch(
      /ADD COLUMN database_host_id uuid REFERENCES database_hosts \(id\) ON DELETE RESTRICT,/
    );
    expect(sql).toContain("ADD COLUMN db_role text,");
    expect(sql).toContain("ADD COLUMN db_password_variable text;");
    expect(sql).toMatch(
      /ON environment_services \(database_host_id, db_name\)\s+WHERE database_host_id IS NOT NULL/
    );
  });

  it("adds entry_port with its range check", () => {
    expect(sql).toContain("ADD COLUMN entry_port integer,");
    expect(sql).toContain("CHECK (entry_port BETWEEN 1 AND 65535)");
  });

  it("adds the server preflight columns", () => {
    expect(sql).toContain("ADD COLUMN preflight jsonb,");
    expect(sql).toContain("ADD COLUMN preflight_at timestamp;");
  });

  it("is additive: no drop, no NOT NULL tightening, no rename", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/ALTER\s+COLUMN[^;]*SET\s+NOT\s+NULL/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
  });
});

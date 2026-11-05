import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "drizzle/20261105030000_deploy_locks/migration.sql",
  "utf8"
);

describe("deploy locks migration", () => {
  it("is one transaction", () => {
    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("adds the held status", () => {
    expect(sql).toContain("ALTER TYPE deployment_status ADD VALUE 'held'");
  });

  it("creates the lock table keyed by environment with cascade", () => {
    expect(sql).toContain("CREATE TABLE environment_deploy_locks");
    expect(sql).toMatch(
      /environment_id uuid PRIMARY KEY REFERENCES environments \(id\) ON DELETE CASCADE/
    );
    expect(sql).toMatch(
      /locked_by uuid REFERENCES users \(id\) ON DELETE SET NULL/
    );
    expect(sql).toContain("reason text NOT NULL");
    expect(sql).toContain("expires_at timestamp NOT NULL");
    expect(sql).toMatch(/created_at timestamp NOT NULL DEFAULT now\(\)/);
  });

  it("lets a held deployment have no run yet", () => {
    expect(sql).toContain(
      "ALTER TABLE deployments ALTER COLUMN run_id DROP NOT NULL"
    );
  });

  it("is additive: drops no table, column, type, index or constraint", () => {
    expect(sql).not.toMatch(
      /DROP\s+(TABLE|COLUMN|TYPE|INDEX|CONSTRAINT|SCHEMA|VIEW)\b/i
    );
    // The only DROP is the relaxing DROP NOT NULL.
    expect(sql.match(/DROP\s/gi)?.length).toBe(1);
  });
});

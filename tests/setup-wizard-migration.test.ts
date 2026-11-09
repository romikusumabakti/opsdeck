import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "drizzle-legacy/20261107000000_setup_wizard/migration.sql",
  "utf8"
);

describe("setup wizard migration", () => {
  it("sets the session lock timeout before any statement", () => {
    const set = sql.indexOf("SET lock_timeout = '5s';");
    expect(set).toBeGreaterThan(-1);
    expect(sql.match(/SET lock_timeout/g)).toHaveLength(1);
    expect(
      sql
        .slice(0, set)
        .split("\n")
        .every((line) => line === "" || line.startsWith("--"))
    ).toBe(true);
    expect(set).toBeLessThan(sql.indexOf("BEGIN;"));
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("adds a nullable, format-checked network to database hosts", () => {
    expect(sql).toMatch(
      /ALTER TABLE database_hosts\s+ADD COLUMN network text,/
    );
    expect(sql).toContain(
      "CHECK (network IS NULL OR network ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$')"
    );
  });

  it("adds deploy_next_build as a non-null boolean defaulting to false", () => {
    expect(sql).toContain(
      "ADD COLUMN deploy_next_build boolean NOT NULL DEFAULT false"
    );
  });

  it("is additive: no drop, no NOT NULL tightening, no rename", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/ALTER\s+COLUMN[^;]*SET\s+NOT\s+NULL/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
  });
});

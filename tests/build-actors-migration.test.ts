import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "drizzle-legacy/20261105040000_build_actors/migration.sql",
  "utf8"
);
// The statements only, without comments.
const statements = sql.replace(/--.*$/gm, "");

describe("build actors migration", () => {
  it("is one transaction", () => {
    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("adds the three nullable build columns and the run actor", () => {
    expect(sql).toMatch(/ALTER TABLE builds\s+ADD COLUMN pushed_by text,/);
    expect(sql).toMatch(/ADD COLUMN commit_author_email text,/);
    expect(sql).toMatch(/ADD COLUMN commit_message text;/);
    expect(sql).toMatch(/ALTER TABLE runs ADD COLUMN triggered_by text;/);
    expect(sql.match(/ADD COLUMN/g)?.length).toBe(4);
    expect(statements).not.toMatch(/NOT NULL|DEFAULT/i);
  });

  it("is additive: drops or rewrites nothing", () => {
    expect(statements).not.toMatch(
      /\bDROP\b|\bUPDATE\b|\bDELETE\b|\bRENAME\b/i
    );
  });
});

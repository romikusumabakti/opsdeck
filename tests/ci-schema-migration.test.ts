import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "drizzle/20261105010000_ci_connection_credentials/migration.sql",
  "utf8"
);

describe("CI connection credentials migration", () => {
  it("is one transaction", () => {
    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("creates the pipeline mode enum", () => {
    expect(sql).toContain(
      "CREATE TYPE pipeline_mode AS ENUM ('custom', 'generated')"
    );
  });

  it("defaults existing components to custom", () => {
    expect(sql).toMatch(
      /ADD COLUMN pipeline_mode pipeline_mode NOT NULL DEFAULT 'custom'/
    );
  });

  it("adds the credential and build spec columns", () => {
    for (const column of [
      "api_token",
      "forge_username",
      "forge_token",
      "extension_public_key",
      "extension_public_key_fetched_at",
      "build_spec",
      "fallback_committed_sha",
      "fallback_commit_error",
    ]) {
      expect(sql).toContain(`ADD COLUMN ${column} `);
    }
  });

  it("is additive only", () => {
    expect(sql).not.toMatch(/DROP/i);
    expect(sql).not.toMatch(/RENAME/i);
  });
});

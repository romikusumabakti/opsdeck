import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "drizzle/20261105020000_variables_and_access/migration.sql",
  "utf8"
);

describe("variables and access migration", () => {
  it("is one transaction", () => {
    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("creates both enums", () => {
    expect(sql).toContain(
      "CREATE TYPE variable_kind AS ENUM ('plain', 'secret', 'generated')"
    );
    expect(sql).toContain(
      "CREATE TYPE server_placement AS ENUM ('restricted', 'open')"
    );
  });

  it("creates both variable tables with unique names per parent", () => {
    expect(sql).toContain("CREATE TABLE app_variable_templates");
    expect(sql).toContain("CREATE TABLE environment_variables");
    expect(sql).toContain(
      "CREATE UNIQUE INDEX app_variable_templates_app_name_idx ON app_variable_templates (app_id, name);"
    );
    expect(sql).toContain(
      "CREATE UNIQUE INDEX environment_variables_environment_name_idx ON environment_variables (environment_id, name);"
    );
  });

  it("defaults environments to unmanaged .env", () => {
    expect(sql).toMatch(
      /ALTER TABLE environments\s+ADD COLUMN env_file_managed boolean NOT NULL DEFAULT false/
    );
  });

  it("defaults servers to restricted placement", () => {
    expect(sql).toMatch(
      /ALTER TABLE servers\s+ADD COLUMN placement server_placement NOT NULL DEFAULT 'restricted'/
    );
  });

  it("bounds the generated length", () => {
    expect(sql).toContain("generated_length BETWEEN 16 AND 128");
  });

  it("is additive only", () => {
    expect(sql).not.toMatch(/DROP/i);
    expect(sql).not.toMatch(/RENAME/i);
  });
});

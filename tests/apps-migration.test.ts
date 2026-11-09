import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "drizzle-legacy/20261105000000_apps_model/migration.sql",
  "utf8"
);

describe("apps model migration", () => {
  it("is one transaction", () => {
    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("renames instead of recreating, so FKs and rows survive", () => {
    expect(sql).toMatch(/ALTER TABLE deploy_apps RENAME TO app_components;/);
    expect(sql).toMatch(
      /ALTER TABLE builds RENAME COLUMN app_key TO component_key;/
    );
    expect(sql).toMatch(
      /ALTER TABLE deploy_targets RENAME COLUMN app_key TO component_key;/
    );
    expect(sql).not.toMatch(/DROP TABLE/i);
  });

  it("backfills the portal as one app with two components", () => {
    expect(sql).toContain("'dplk-customer-portal'");
    expect(sql).toMatch(
      /dplk-customer-portal-backend[\s\S]*dss-consulting\/dplk-customer-portal-backend/
    );
    expect(sql).toMatch(
      /dplk-customer-portal-frontend[\s\S]*dss-consulting\/customer-portal/
    );
  });

  it("fails loudly when a component is left without app or CI connection", () => {
    expect(sql).toMatch(/ALTER COLUMN app_id SET NOT NULL/);
    expect(sql).toMatch(/ALTER COLUMN ci_connection_id SET NOT NULL/);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The project-sources migration, as text: the migrator's rules and the
// expand-only shape the release split needs (the previous release still runs
// on the migrated schema). Its effect on real rows is
// tests/project-sources-migration-scratch.test.ts.
const sql = readFileSync(
  "drizzle/20261118000000_project_sources/migration.sql",
  "utf8"
);

describe("project sources migration", () => {
  it("follows the migrator rules", () => {
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(
      sql.startsWith("SET LOCAL lock_timeout = '5s';--> statement-breakpoint")
    ).toBe(true);
  });

  it("is expand only: creates two tables, drops and renames nothing", () => {
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/);
    // The FK actions ("ON DELETE CASCADE") are the point, not DML; strip them
    // so any other DELETE, UPDATE (incl. ON CONFLICT DO UPDATE) or TRUNCATE
    // fails.
    const dml = sql.replace(
      /\bON (DELETE|UPDATE) (CASCADE|RESTRICT|SET NULL|SET DEFAULT|NO ACTION)\b/g,
      ""
    );
    expect(dml).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE)\b/i);
    expect(sql).not.toMatch(
      /ALTER TABLE "(environments|deploy_targets|apps|app_components|projects)"/
    );
    expect(sql).toContain('CREATE TABLE "project_apps"');
    expect(sql).toContain('CREATE TABLE "project_component_branches"');
  });

  it("restricts app and component deletes, cascades project deletes", () => {
    expect(sql).toMatch(
      /"project_apps_app_id_apps_id_fk" FOREIGN KEY \("app_id"\) REFERENCES "apps"\("id"\) ON DELETE RESTRICT/
    );
    expect(sql).toMatch(
      /"project_component_branches_component_key_fk" FOREIGN KEY \("component_key"\) REFERENCES "app_components"\("component_key"\) ON DELETE RESTRICT/
    );
    expect(sql).toMatch(
      /"project_apps_project_id_projects_id_fk"[^;]*ON DELETE CASCADE/
    );
  });

  it("backfills with two replay-safe inserts after the DDL", () => {
    expect(sql.match(/ON CONFLICT DO NOTHING/g)).toHaveLength(2);
    expect(sql.indexOf('INSERT INTO "project_apps"')).toBeGreaterThan(
      sql.lastIndexOf("ADD CONSTRAINT")
    );
  });

  it("sorts after the global roles migration", () => {
    const folders = readdirSync("drizzle").sort();
    expect(folders.indexOf("20261118000000_project_sources")).toBe(
      folders.indexOf("20261117000000_global_roles") + 1
    );
  });
});

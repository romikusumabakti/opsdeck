import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The services-model migration, as text: the migrator's rules and the
// expand-only shape the release split needs (the previous release still runs
// on the migrated schema). Its effect on real rows is
// tests/services-model-migration-scratch.test.ts.
const MIGRATION = "20261130000000_services_model";
const sql = readFileSync(`drizzle/${MIGRATION}/migration.sql`, "utf8");

describe("services model migration", () => {
  it("follows the migrator rules", () => {
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(
      sql.startsWith("SET LOCAL lock_timeout = '5s';--> statement-breakpoint")
    ).toBe(true);
  });

  it("is expand only: two new tables and app_id made nullable", () => {
    // The one DROP allowed is relaxing app_components.app_id.
    const withoutRelax = sql.replace(
      'ALTER TABLE "app_components" ALTER COLUMN "app_id" DROP NOT NULL;',
      ""
    );
    expect(withoutRelax).not.toMatch(/\b(DROP|RENAME)\b/);
    const dml = sql.replace(
      /\bON (DELETE|UPDATE) (CASCADE|RESTRICT|SET NULL|SET DEFAULT|NO ACTION)\b/g,
      ""
    );
    expect(dml).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE)\b/i);
    expect(withoutRelax).not.toMatch(
      /ALTER TABLE "(environments|deploy_targets|apps|app_components|projects|project_apps|app_variable_templates)"/
    );
    expect(sql).toContain('CREATE TABLE "project_services"');
    expect(sql).toContain('CREATE TABLE "service_variable_templates"');
  });

  it("restricts service deletes for projects, cascades templates", () => {
    expect(sql).toMatch(
      /"project_services_component_key_fk" FOREIGN KEY \("component_key"\) REFERENCES "app_components"\("component_key"\) ON DELETE RESTRICT/
    );
    expect(sql).toMatch(
      /"project_services_project_id_projects_id_fk"[^;]*ON DELETE CASCADE/
    );
    expect(sql).toMatch(
      /"service_variable_templates_component_key_fkey" FOREIGN KEY \("component_key"\) REFERENCES "app_components"\("component_key"\) ON DELETE CASCADE/
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "service_variable_templates_component_name_idx" ON "service_variable_templates" \("component_key","name"\)/
    );
  });

  it("backfills with two replay-safe inserts after the DDL", () => {
    expect(sql.match(/ON CONFLICT DO NOTHING/g)).toHaveLength(2);
    expect(sql.indexOf('INSERT INTO "project_services"')).toBeGreaterThan(
      sql.lastIndexOf("ADD CONSTRAINT")
    );
    expect(
      sql.indexOf('INSERT INTO "service_variable_templates"')
    ).toBeGreaterThan(sql.lastIndexOf("ADD CONSTRAINT"));
  });

  it("sorts right after the environment slug aliases migration", () => {
    const folders = readdirSync("drizzle").sort();
    expect(folders.indexOf(MIGRATION)).toBe(
      folders.indexOf("20261129000000_environment_slug_aliases") + 1
    );
  });

  it("chains its snapshot to the previous one", () => {
    const snapshot = (folder: string) =>
      JSON.parse(readFileSync(`drizzle/${folder}/snapshot.json`, "utf8")) as {
        id: string;
        prevIds: string[];
      };
    expect(snapshot(MIGRATION).prevIds).toEqual([
      snapshot("20261129000000_environment_slug_aliases").id,
    ]);
  });
});

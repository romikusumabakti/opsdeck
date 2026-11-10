import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = readdirSync("drizzle").find((d) =>
  d.endsWith("_legacy_artifact_targets")
);
const sql = dir ? readFileSync(`drizzle/${dir}/migration.sql`, "utf8") : "";

describe("legacy artifact targets migration", () => {
  it("follows the migrator rules", () => {
    expect(dir).toBeDefined();
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(sql.startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
  });

  it("creates the target kind enum and column", () => {
    expect(sql).toContain(
      `CREATE TYPE "deploy_target_kind" AS ENUM('compose', 'jar', 'static')`
    );
    expect(sql).toContain(
      `ALTER TABLE "deploy_targets" ADD COLUMN "kind" "deploy_target_kind" DEFAULT 'compose' NOT NULL`
    );
    expect(sql).toContain(`ADD COLUMN "jar_name" text`);
    expect(sql).toContain(`ADD COLUMN "systemd_unit" text`);
  });

  it("checks the jar fields against the kind", () => {
    expect(sql).toContain(`"deploy_targets_kind_fields_check"`);
    expect(sql).toMatch(
      /CHECK \(\(?"kind" = 'jar' and "jar_name" is not null and "systemd_unit" is not null\)? or \("kind" <> 'jar' and "jar_name" is null and "systemd_unit" is null\)\)/i
    );
  });

  it("adds the per-component notify secret name", () => {
    expect(sql).toContain(
      `ADD COLUMN "notify_secret_name" text DEFAULT 'opsdeck_notify' NOT NULL`
    );
  });

  it("lets several components share a repository", () => {
    expect(sql).toContain('DROP INDEX "app_components_ci_repo_idx"');
    expect(sql).toContain(
      'CREATE INDEX "app_components_ci_repo_lookup_idx" ON "app_components" ("ci_connection_id","ci_repo_id")'
    );
  });
});

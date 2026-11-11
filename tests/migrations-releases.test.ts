import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = readdirSync("drizzle").find((d) => d.endsWith("_releases"));
const sql = dir ? readFileSync(`drizzle/${dir}/migration.sql`, "utf8") : "";

describe("releases migration", () => {
  it("follows the migrator rules", () => {
    expect(dir).toBeDefined();
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(sql.startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
    expect(dir! > "20261114000000_legacy_artifact_targets").toBe(true);
  });

  it("creates the release status enum and the run kind", () => {
    expect(sql).toContain(`CREATE TYPE "release_status"`);
    expect(sql).toContain(
      `ALTER TYPE "run_kind" ADD VALUE IF NOT EXISTS 'release'`
    );
  });

  it("creates the releases table", () => {
    expect(sql).toContain(`CREATE TABLE "releases"`);
  });

  it("never cascades a project delete to its releases (their files live in Garage)", () => {
    expect(sql).toMatch(
      /"releases_project_id_projects_id_fk" FOREIGN KEY \("project_id"\) REFERENCES "projects"\("id"\) ON DELETE RESTRICT;/
    );
  });

  it("keeps the version unique among non-failed releases", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "releases_version_idx"[^;]*WHERE[^;]*'failed'/
    );
    expect(sql).toContain(`CREATE INDEX "releases_project_idx"`);
  });
});

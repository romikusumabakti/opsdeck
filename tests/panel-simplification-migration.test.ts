import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "drizzle/20261108000000_panel_simplification/migration.sql",
  "utf8"
);

describe("panel simplification migration", () => {
  it("sets the session lock timeout before the transaction and commits", () => {
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

  it("renames the project roles", () => {
    expect(sql).toContain(
      "ALTER TYPE project_role RENAME VALUE 'contributor' TO 'qa';"
    );
    expect(sql).toContain(
      "ALTER TYPE project_role RENAME VALUE 'maintainer' TO 'engineer';"
    );
  });

  it("adds the nullable project default server", () => {
    expect(sql).toContain(
      "ADD COLUMN default_server_id uuid REFERENCES servers(id) ON DELETE SET NULL"
    );
  });

  it("folds host into url before dropping host, and drops owner", () => {
    const update = sql.indexOf(
      "UPDATE environments SET url = 'http://' || host WHERE url IS NULL AND host IS NOT NULL;"
    );
    expect(update).toBeGreaterThan(-1);
    const drop = sql.indexOf("DROP COLUMN host");
    expect(drop).toBeGreaterThan(update);
    expect(sql).toContain("DROP COLUMN owner");
  });

  it("sets every domain-bound environment's url to the domain, after the host copy", () => {
    const host = sql.indexOf("UPDATE environments SET url = 'http://' || host");
    const backfill = sql.indexOf(
      "UPDATE environments e SET url = 'https://' || d.hostname\n  FROM environment_domains d\n  WHERE d.environment_id = e.id AND e.url IS DISTINCT FROM 'https://' || d.hostname;"
    );
    expect(backfill).toBeGreaterThan(host);
    expect(backfill).toBeLessThan(sql.indexOf("COMMIT;"));
  });

  it("makes the Cloudflare zone API token optional", () => {
    expect(sql).toContain(
      "ALTER TABLE cloudflare_zones ALTER COLUMN api_token DROP NOT NULL"
    );
  });
});

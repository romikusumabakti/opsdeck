import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "drizzle/20261116000000_infra_only_servers/migration.sql",
  "utf8"
);

describe("infra-only servers migration", () => {
  it("follows the migrator rules", () => {
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(sql.startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
  });

  it("is expand only", () => {
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/);
  });

  // NOT NULL with a default: existing rows read as false, and an old build
  // that never names the column keeps inserting.
  it("adds servers.infra_only off by default", () => {
    expect(sql).toContain(
      'ALTER TABLE "servers" ADD COLUMN "infra_only" boolean DEFAULT false NOT NULL;'
    );
  });
});

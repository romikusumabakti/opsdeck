import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The global-roles migration, as text: the migrator's rules and the
// expand-only shape the release split needs (the previous release still runs
// on the migrated schema). Its effect on real rows is
// tests/global-roles-migration-scratch.test.ts.
const sql = readFileSync(
  "drizzle/20261117000000_global_roles/migration.sql",
  "utf8"
);

describe("global roles migration", () => {
  it("follows the migrator rules", () => {
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(sql.startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
  });

  it("is expand only: drops and renames nothing", () => {
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/);
    expect(sql).not.toMatch(/DELETE FROM "project_members"/);
  });

  it("maps users, and gives the membership role a default for role-less inserts", () => {
    expect(sql.indexOf('UPDATE "users"')).toBeGreaterThan(0);
    expect(sql).toContain(
      `ALTER TABLE "project_members" ALTER COLUMN "role" SET DEFAULT 'viewer'::"project_role";`
    );
  });

  it("defaults new users and invitations to qa", () => {
    expect(sql).toContain(
      `ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'qa';`
    );
    expect(sql).toContain(
      `ALTER TABLE "invitations" ALTER COLUMN "role" SET DEFAULT 'qa';`
    );
  });
});

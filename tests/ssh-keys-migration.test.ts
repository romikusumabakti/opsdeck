import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "drizzle/20261111000000_ssh_keys/migration.sql",
  "utf8"
);

describe("ssh keys migration", () => {
  it("follows the migrator rules", () => {
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(sql).toMatch(/^(--.*\n)*SET LOCAL lock_timeout = '5s';/);
  });

  it("is expand only", () => {
    expect(sql).not.toMatch(/\bDROP\b(?! NOT NULL)/);
  });

  it("creates the ssh_keys table and both enums", () => {
    expect(sql).toContain('CREATE TABLE "ssh_keys"');
    expect(sql).toContain(
      `CREATE TYPE "ssh_key_status" AS ENUM('current', 'previous', 'retired')`
    );
    expect(sql).toContain(
      `CREATE TYPE "server_auth" AS ENUM('password', 'key')`
    );
  });

  it("allows one current key at most", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "ssh_keys_one_current_idx" ON "ssh_keys" \("status"\) WHERE status = 'current'/
    );
  });

  it("makes the password optional and adds the key columns", () => {
    expect(sql).toContain('ALTER COLUMN "password" DROP NOT NULL');
    for (const column of [
      "auth",
      "host_key_type",
      "host_key",
      "host_key_fingerprint",
      "host_key_pinned_at",
      "host_key_offered_type",
      "host_key_offered",
      "host_key_offered_fingerprint",
      "ssh_key_id",
      "ssh_from",
      "key_error",
    ]) {
      expect(sql).toContain(`ADD COLUMN "${column}"`);
    }
  });
});

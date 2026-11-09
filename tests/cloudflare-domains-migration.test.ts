import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "drizzle-legacy/20261106000000_cloudflare_domains/migration.sql",
  "utf8"
);

describe("cloudflare domains migration", () => {
  it("adds the three step kinds before the transaction block", () => {
    const begin = sql.indexOf("BEGIN;");
    for (const kind of ["tunnel_route", "access_app", "dns_record"]) {
      const add = sql.indexOf(
        `ALTER TYPE "provisioning_step_kind" ADD VALUE IF NOT EXISTS '${kind}'`
      );
      expect(add).toBeGreaterThan(-1);
      expect(add).toBeLessThan(begin);
    }
    expect(sql.match(/ADD VALUE IF NOT EXISTS/g)).toHaveLength(3);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("sets the session lock timeout before any statement", () => {
    const set = sql.indexOf("SET lock_timeout = '5s';");
    expect(set).toBeGreaterThan(-1);
    expect(sql.match(/SET lock_timeout/g)).toHaveLength(1);
    // Only comments come before it.
    expect(
      sql
        .slice(0, set)
        .split("\n")
        .every((line) => line === "" || line.startsWith("--"))
    ).toBe(true);
    expect(set).toBeLessThan(
      sql.indexOf('ALTER TYPE "provisioning_step_kind"')
    );
  });

  it("creates the domain_kind enum and the three tables", () => {
    expect(sql).toContain(
      "CREATE TYPE domain_kind AS ENUM ('tunnel', 'external')"
    );
    expect(sql).toContain("CREATE TABLE cloudflare_accounts");
    expect(sql).toContain("CREATE TABLE remote_tunnels");
    expect(sql).toContain("CREATE TABLE environment_domains");
  });

  it("keys the account by its Cloudflare id and encrypts nothing in SQL", () => {
    expect(sql).toContain("account_id text NOT NULL UNIQUE");
    expect(sql).toContain("api_token text NOT NULL");
    expect(sql).toContain("access_idp_id text,");
  });

  it("allows one remote tunnel per server and one registration per tunnel", () => {
    expect(sql).toContain("ON remote_tunnels (account_id, tunnel_id)");
    expect(sql).toContain("ON remote_tunnels (server_id)");
    expect(sql).toMatch(
      /account_id uuid NOT NULL REFERENCES cloudflare_accounts \(id\) ON DELETE RESTRICT/
    );
    expect(sql).toMatch(
      /server_id uuid NOT NULL REFERENCES servers \(id\) ON DELETE RESTRICT/
    );
  });

  it("gives an environment at most one domain, with a unique hostname", () => {
    expect(sql).toMatch(
      /environment_id uuid PRIMARY KEY REFERENCES environments \(id\) ON DELETE CASCADE/
    );
    expect(sql).toContain("hostname text NOT NULL UNIQUE");
    expect(sql).toMatch(
      /zone_id uuid REFERENCES cloudflare_zones \(id\) ON DELETE RESTRICT/
    );
    expect(sql).toMatch(
      /remote_tunnel_id uuid REFERENCES remote_tunnels \(id\) ON DELETE RESTRICT/
    );
  });

  it("requires a zone and a tunnel for tunnel domains", () => {
    expect(sql).toContain(
      "CHECK (kind <> 'tunnel' OR (zone_id IS NOT NULL AND remote_tunnel_id IS NOT NULL))"
    );
  });

  it("is additive: no drop, no NOT NULL tightening, no rename", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/ALTER\s+COLUMN[^;]*SET\s+NOT\s+NULL/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
  });
});

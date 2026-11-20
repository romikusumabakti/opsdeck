import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// The instance branding boot seed against a real Postgres (a throwaway
// database in the local menara-postgres container, migrated and dropped):
// seeded once from env, never twice, never over a row an admin cleared, and
// the migration only adds nullable columns and the logo table with its checks.
//
//   BRANDING_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/branding-scratch.test.ts
const enabled = process.env.BRANDING_SCRATCH === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = `branding_${randomBytes(4).toString("hex")}`;
process.env.SECRETS_KEY ??= randomBytes(32).toString("base64");

const password = () =>
  encodeURIComponent(
    execFileSync("podman", ["exec", CONTAINER, "printenv", "POSTGRES_PASSWORD"])
      .toString()
      .trim()
  );

describe.skipIf(!enabled)("instance branding on Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let previousUrl: string | undefined;
  let seed: typeof import("@/lib/instance-branding")["seedBrandingFromEnv"];

  const row = async () => {
    const [r] = await sql<Record<string, unknown>[]>`
      select brand_name, brand_company, brand_accent, brand_updated_at
      from instance_settings where id = 1`;
    return r;
  };

  beforeAll(async () => {
    const base = `postgres://postgres:${password()}@127.0.0.1:5432`;
    const root = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
    await root.unsafe(`create database ${DB_NAME}`);
    await root.end();
    const url = `${base}/${DB_NAME}`;
    const result = spawnSync("bun", ["scripts/cli.ts", "migrate"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: url,
      },
    });
    if (result.status !== 0)
      throw new Error(`migrate failed: ${result.stderr}`);
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 1, onnotice: () => {} });
    ({ seedBrandingFromEnv: seed } = await import("@/lib/instance-branding"));
  });

  afterAll(async () => {
    await sql?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (!enabled) return;
    const root = postgres(
      `postgres://postgres:${password()}@127.0.0.1:5432/postgres`,
      { max: 1, onnotice: () => {} }
    );
    await root.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await root.end();
  });

  beforeEach(async () => {
    await sql`delete from instance_brand_logos`;
    await sql`update instance_settings set brand_name = null,
      brand_company = null, brand_accent = null, brand_updated_at = null`;
  });

  it("seeds name and company from env into an empty row", async () => {
    const wrote = await seed({
      APP_NAME: "Acme Ops",
      COMPANY_NAME: "PT Acme",
    });
    expect(wrote).toBe(true);
    const r = await row();
    expect(r).toMatchObject({
      brand_name: "Acme Ops",
      brand_company: "PT Acme",
      brand_accent: null,
    });
    expect(r?.brand_updated_at).not.toBeNull();
  });

  it("a second boot changes nothing", async () => {
    await seed({ APP_NAME: "Acme Ops", COMPANY_NAME: "PT Acme" });
    const before = await row();
    expect(await seed({ APP_NAME: "BETA Ops" })).toBe(false);
    expect(await row()).toEqual(before);
  });

  it("BRAND=acme seeds blue; any other value seeds no accent", async () => {
    expect(await seed({ BRAND: "acme" })).toBe(true);
    expect((await row())?.brand_accent).toBe("blue");
    await sql`update instance_settings set brand_accent = null,
      brand_updated_at = null`;
    expect(await seed({ BRAND: "default" })).toBe(false);
    expect((await row())?.brand_updated_at).toBeNull();
  });

  it("does not re-seed a row an admin cleared", async () => {
    await sql`update instance_settings set brand_updated_at = now()`;
    expect(await seed({ APP_NAME: "Acme Ops" })).toBe(false);
    expect((await row())?.brand_name).toBeNull();
  });

  it("does not seed over an uploaded logo", async () => {
    await sql`insert into instance_brand_logos (theme, bytes, content_type)
      values ('light', ${Buffer.from("<svg/>")}, 'image/svg+xml')`;
    expect(await seed({ APP_NAME: "Acme Ops" })).toBe(false);
  });

  it("the migration adds only nullable columns and the new table", async () => {
    const cols = await sql<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
      where table_name = 'instance_settings'
        and column_name in ('brand_name', 'brand_company', 'brand_accent',
          'brand_updated_at')`;
    expect(cols).toHaveLength(4);
    expect(cols.every((c) => c.is_nullable === "YES")).toBe(true);
    await expect(
      sql`insert into instance_brand_logos (theme, bytes, content_type)
        values ('x', ${Buffer.from("a")}, 'image/png')`
    ).rejects.toThrow(/theme_check/);
    await expect(
      sql`insert into instance_brand_logos (theme, bytes, content_type)
        values ('light', ${Buffer.from("a")}, 'text/html')`
    ).rejects.toThrow(/content_type_check/);
  });
});

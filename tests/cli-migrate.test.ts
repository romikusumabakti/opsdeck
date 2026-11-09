import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it, vi } from "vitest";
import {
  adoptBaseline,
  BASELINE,
  diffSchemaDumps,
  type MigrationRow,
  type MigrationsTable,
  normaliseSchemaDump,
} from "@/scripts/cli/migrate";

function fakeTable(recorded: (string | null)[] = []) {
  const inserted: MigrationRow[] = [];
  const table: MigrationsTable = {
    recorded: vi.fn(async () => recorded),
    insert: vi.fn(async (row: MigrationRow) => {
      inserted.push(row);
    }),
  };
  return { table, inserted };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
  };
}

describe("opsdeck migrate --adopt", () => {
  it("adopt refuses on schema difference", async () => {
    const { table, inserted } = fakeTable();
    const diff = Array.from({ length: 25 }, (_, i) => `+ STATEMENT ${i};`);
    const { err, io } = capture();

    const code = await adoptBaseline({
      table,
      schemaDiff: async () => diff,
      ...io,
    });

    expect(code).toBe(2);
    expect(inserted).toEqual([]);
    expect(table.insert).not.toHaveBeenCalled();
    const text = err.join("\n");
    expect(text).toContain("25");
    for (const line of diff.slice(0, 20)) expect(text).toContain(line);
    for (const line of diff.slice(20)) expect(text).not.toContain(line);
  });

  it("adopt records baseline", async () => {
    const { table, inserted } = fakeTable();
    const schemaDiff = vi.fn(async () => []);
    const { io } = capture();

    const code = await adoptBaseline({ table, schemaDiff, ...io });

    expect(code).toBe(0);
    expect(schemaDiff).toHaveBeenCalledOnce();
    // Exactly the row drizzle's migrator writes after running the folder, so a
    // later migrate() treats the baseline as applied.
    const baseline = readMigrationFiles({ migrationsFolder: "drizzle" }).find(
      (m) => m.name === BASELINE
    );
    expect(baseline).toBeDefined();
    const sha = createHash("sha256")
      .update(readFileSync(`drizzle/${BASELINE}/migration.sql`))
      .digest("hex");
    expect(baseline?.hash).toBe(sha);
    expect(inserted).toEqual([
      {
        hash: sha,
        created_at: baseline?.folderMillis,
        name: BASELINE,
      },
    ]);
  });

  it("adopt is a no-op when already recorded", async () => {
    const { table, inserted } = fakeTable([BASELINE]);
    const schemaDiff = vi.fn(async () => ["+ anything;"]);
    const { out, io } = capture();

    const code = await adoptBaseline({ table, schemaDiff, ...io });

    expect(code).toBe(0);
    expect(schemaDiff).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
    expect(out.join("\n")).toContain("already recorded");
  });

  it("refuses a database that already has other migrations recorded", async () => {
    const { table, inserted } = fakeTable(["20990101000000_other", null]);
    const schemaDiff = vi.fn(async () => []);
    const { io } = capture();

    const code = await adoptBaseline({ table, schemaDiff, ...io });

    expect(code).toBe(1);
    expect(schemaDiff).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });
});

describe("schema dump normalisation", () => {
  const dump = (body: string) =>
    [
      "--",
      "-- PostgreSQL database dump",
      "--",
      "\\restrict abc123",
      "SET statement_timeout = 0;",
      "SELECT pg_catalog.set_config('search_path', '', false);",
      "",
      body,
      "\\unrestrict abc123",
    ].join("\n");

  it("drops comments, SET lines and restrict keys and sorts statements", () => {
    const a = dump(
      "CREATE TABLE public.b (\n    id uuid NOT NULL\n);\n\n-- Name: a\nCREATE TABLE public.a (\n    id uuid\n);"
    );
    expect(normaliseSchemaDump(a)).toEqual([
      "CREATE TABLE public.a ( id uuid );",
      "CREATE TABLE public.b ( id uuid NOT NULL );",
    ]);
  });

  it("keeps column order significant", () => {
    const a = dump("CREATE TABLE public.t (\n    a int,\n    b int\n);");
    const b = dump("CREATE TABLE public.t (\n    b int,\n    a int\n);");
    expect(diffSchemaDumps(a, b)).toEqual([
      "+ CREATE TABLE public.t ( a int, b int );",
      "- CREATE TABLE public.t ( b int, a int );",
    ]);
  });

  it("keeps dollar-quoted bodies whole", () => {
    const a = dump(
      [
        "CREATE FUNCTION public.f() RETURNS trigger",
        "    LANGUAGE plpgsql",
        "    AS $_$",
        "BEGIN",
        "-- a comment inside the body",
        "SET x = 1;",
        "RETURN NEW;",
        "END;",
        "$_$;",
      ].join("\n")
    );
    expect(normaliseSchemaDump(a)).toEqual([
      "CREATE FUNCTION public.f() RETURNS trigger LANGUAGE plpgsql AS $_$ BEGIN -- a comment inside the body SET x = 1; RETURN NEW; END; $_$;",
    ]);
  });

  it("reports nothing for equal schemas", () => {
    const a = dump("CREATE INDEX i ON public.t USING btree (a);");
    expect(diffSchemaDumps(a, a)).toEqual([]);
  });
});

describe("opsdeck CLI", () => {
  const run = (...args: string[]) =>
    spawnSync("bun", ["scripts/cli.ts", ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });

  it("prints usage on --help without a database", () => {
    const result = run("--help");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("migrate");
  });

  it("rejects an unknown command and an unknown migrate option", () => {
    expect(run("nope").status).toBe(1);
    expect(run("migrate", "--bogus").status).toBe(1);
  });

  it("fails without leaking the URL when the database is unreachable", () => {
    const result = spawnSync("bun", ["scripts/cli.ts", "migrate"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: "postgres://u:hunter2@127.0.0.1:1/none",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Migration failed");
    expect(result.stderr + result.stdout).not.toContain("hunter2");
  }, 30_000);
});

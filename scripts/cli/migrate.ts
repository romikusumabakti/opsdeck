// `opsdeck migrate`: applies pending migrations in drizzle/ with Drizzle's
// migrator. `opsdeck migrate --adopt` takes over a database built by the
// legacy migrations (drizzle-legacy/): it checks that the live schema equals
// the baseline's, then records the baseline as applied without running it.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const MIGRATIONS_FOLDER = "drizzle";
export const BASELINE = "00000000000000_baseline";

export const MIGRATE_USAGE = `Usage: opsdeck migrate [--adopt]
  (in the image: bun dist/cli.js migrate [--adopt])

Applies pending migrations in ${MIGRATIONS_FOLDER}/ to DATABASE_URL.
--adopt  For a database built by the legacy migrations: checks that its schema
         equals the baseline's and records the baseline as applied without
         running it. Refuses (exit 2) when the schemas differ.`;

/** A row of drizzle.__drizzle_migrations, as Drizzle's migrator writes it. */
export interface MigrationRow {
  hash: string;
  created_at: number;
  name: string;
}

export interface MigrationsTable {
  /** Names of the recorded migrations (null for unnamed rows); empty when the table is missing. */
  recorded(): Promise<(string | null)[]>;
  /** Records a migration, creating the table the way the migrator does when missing. */
  insert(row: MigrationRow): Promise<void>;
}

interface Io {
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const SHOWN_DIFF_LINES = 20;

export async function adoptBaseline({
  table,
  schemaDiff,
  migrationsFolder = MIGRATIONS_FOLDER,
  out = console.log,
  err = console.error,
}: {
  table: MigrationsTable;
  /** Differences between the live schema and the baseline's; empty when equal. */
  schemaDiff: () => Promise<string[]>;
  migrationsFolder?: string;
} & Io): Promise<number> {
  const baseline = readMigrationFiles({ migrationsFolder }).find(
    (m) => m.name === BASELINE
  );
  if (!baseline) {
    err(`Baseline ${BASELINE} not found in ${migrationsFolder}/`);
    return 1;
  }

  const recorded = await table.recorded();
  if (recorded.includes(BASELINE)) {
    out(`Baseline ${BASELINE} is already recorded; nothing to adopt.`);
    return 0;
  }
  if (recorded.length > 0) {
    err(
      `drizzle.__drizzle_migrations already has ${recorded.length} rows but not the baseline; refusing to adopt.`
    );
    return 1;
  }

  const diff = await schemaDiff();
  if (diff.length > 0) {
    err(
      `The database schema differs from the baseline (${diff.length} differing statements; - baseline only, + database only). First ${Math.min(diff.length, SHOWN_DIFF_LINES)}:`
    );
    for (const line of diff.slice(0, SHOWN_DIFF_LINES)) err(line);
    return 2;
  }

  await table.insert({
    hash: baseline.hash,
    created_at: baseline.folderMillis,
    name: BASELINE,
  });
  out(`Baseline ${BASELINE} recorded as applied.`);
  return 0;
}

/**
 * A `pg_dump --schema-only` as sorted statements: comments, SET lines, the
 * per-dump \restrict keys and blank lines removed, each statement on one line.
 * Statement order is not significant (pg_dump orders by dependency and name);
 * the order inside a statement (e.g. columns) is. Inside a dollar-quoted body
 * ($$ … $$ or $tag$ … $tag$, e.g. a function) nothing is dropped and a line
 * ending in ";" does not end the statement.
 */
export function normaliseSchemaDump(dump: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  let openTag: string | null = null;
  for (const raw of dump.split("\n")) {
    const line = raw.trim();
    if (
      openTag === null &&
      (line === "" ||
        line.startsWith("--") ||
        line.startsWith("SET ") ||
        line.startsWith("SELECT pg_catalog.set_config(") ||
        line.startsWith("\\"))
    ) {
      continue;
    }
    for (const [tag] of line.matchAll(/\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$/g)) {
      if (openTag === null) openTag = tag;
      else if (tag === openTag) openTag = null;
    }
    current.push(line);
    if (openTag === null && line.endsWith(";")) {
      statements.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) statements.push(current.join(" "));
  return statements.sort();
}

/** Statements only in `baseline` ("- …") or only in `live` ("+ …"), sorted. */
export function diffSchemaDumps(live: string, baseline: string): string[] {
  const remaining = new Map<string, number>();
  for (const s of normaliseSchemaDump(live)) {
    remaining.set(s, (remaining.get(s) ?? 0) + 1);
  }
  const lines: { statement: string; line: string }[] = [];
  for (const s of normaliseSchemaDump(baseline)) {
    const n = remaining.get(s) ?? 0;
    if (n > 0) remaining.set(s, n - 1);
    else lines.push({ statement: s, line: `- ${s}` });
  }
  for (const [s, n] of remaining) {
    for (let i = 0; i < n; i++) lines.push({ statement: s, line: `+ ${s}` });
  }
  return lines
    .sort((a, b) =>
      a.statement === b.statement
        ? a.line.localeCompare(b.line)
        : a.statement < b.statement
          ? -1
          : 1
    )
    .map((l) => l.line);
}

/** Runs pg_dump against `url`; credentials go through PG* env, not argv. */
export async function pgDumpSchema(url: string): Promise<string> {
  const u = new URL(url);
  const { stdout } = await promisify(execFile)(
    "pg_dump",
    [
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--exclude-schema=drizzle",
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "",
        PGHOST: decodeURIComponent(u.hostname),
        PGPORT: u.port || "5432",
        PGUSER: decodeURIComponent(u.username),
        PGPASSWORD: decodeURIComponent(u.password),
        PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
        ...(u.searchParams.get("sslmode")
          ? { PGSSLMODE: u.searchParams.get("sslmode") ?? "" }
          : {}),
      },
    }
  );
  return stdout;
}

/**
 * Compares the live database with the baseline: runs the baseline in a
 * throwaway database on the same server (as the migrator would: one
 * transaction, one statement per breakpoint), dumps both schemas and diffs
 * them. The throwaway database is always dropped.
 */
export async function baselineSchemaDiff({
  client,
  url,
  dump = pgDumpSchema,
  migrationsFolder = MIGRATIONS_FOLDER,
}: {
  client: postgres.Sql;
  url: string;
  dump?: (url: string) => Promise<string>;
  migrationsFolder?: string;
}): Promise<string[]> {
  const baseline = readMigrationFiles({ migrationsFolder }).find(
    (m) => m.name === BASELINE
  );
  if (!baseline) throw new Error(`Baseline ${BASELINE} not found`);

  const live = new URL(url);
  const liveDb = decodeURIComponent(live.pathname.slice(1));
  // Only [a-z0-9_] and within the 63-byte identifier limit.
  const scratchDb = `${liveDb
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 40)}_adopt_${randomBytes(4).toString("hex")}`;
  const scratch = new URL(url);
  scratch.pathname = `/${encodeURIComponent(scratchDb)}`;

  // From template0 with the live database's encoding and locale, so neither
  // template1's extras nor a different default collation leak into the diff.
  const [create] = await client`
    select format(
      'CREATE DATABASE %I TEMPLATE template0 ENCODING %L LC_COLLATE %L LC_CTYPE %L',
      ${scratchDb}::text, pg_encoding_to_char(encoding), datcollate, datctype
    ) || case datlocprovider
      when 'i' then format(' LOCALE_PROVIDER icu ICU_LOCALE %L', datlocale)
      when 'b' then format(' LOCALE_PROVIDER builtin BUILTIN_LOCALE %L', datlocale)
      else ' LOCALE_PROVIDER libc'
    end as statement
    from pg_database where datname = current_database()`;
  if (!create) throw new Error("Current database not found in pg_database");
  await client.unsafe(create.statement as string);
  try {
    const scratchClient = postgres(scratch.toString(), {
      max: 1,
      onnotice: () => {},
    });
    try {
      await scratchClient.begin(async (tx) => {
        for (const statement of baseline.sql) await tx.unsafe(statement);
      });
    } finally {
      await scratchClient.end();
    }
    return diffSchemaDumps(await dump(url), await dump(scratch.toString()));
  } finally {
    await client.unsafe(`DROP DATABASE IF EXISTS "${scratchDb}" WITH (FORCE)`);
  }
}

/** drizzle.__drizzle_migrations through postgres.js, as the migrator shapes it. */
export function postgresMigrationsTable(client: postgres.Sql): MigrationsTable {
  return {
    async recorded() {
      const [exists] = await client`
        select to_regclass('drizzle.__drizzle_migrations') is not null as present`;
      if (!exists?.present) return [];
      const [hasName] = await client`
        select count(*)::int as n from information_schema.columns
        where table_schema = 'drizzle' and table_name = '__drizzle_migrations'
          and column_name = 'name'`;
      const rows = hasName?.n
        ? await client`select name from drizzle.__drizzle_migrations`
        : await client`select null as name from drizzle.__drizzle_migrations`;
      return rows.map((r) => (r.name as string | null) ?? null);
    },
    async insert(row) {
      await client.begin(async (tx) => {
        // The migrator's own DDL (drizzle-orm pg-core migrate) and its
        // upgrade of an older, name-less table.
        await tx`CREATE SCHEMA IF NOT EXISTS drizzle`;
        await tx`
          CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
            id SERIAL PRIMARY KEY,
            hash text NOT NULL,
            created_at bigint,
            name text,
            applied_at timestamp with time zone DEFAULT now()
          )`;
        await tx`ALTER TABLE drizzle.__drizzle_migrations ADD COLUMN IF NOT EXISTS name text`;
        await tx`ALTER TABLE drizzle.__drizzle_migrations ADD COLUMN IF NOT EXISTS applied_at timestamp with time zone DEFAULT now()`;
        await tx`
          insert into drizzle.__drizzle_migrations ("hash", "created_at", "name")
          values (${row.hash}, ${row.created_at}, ${row.name})`;
      });
    },
  };
}

/** A safe error label: the SQLSTATE or system code and, from the server, its message. */
function describeError(error: unknown): string {
  const e = error as { code?: unknown; cause?: unknown; message?: unknown };
  const pg = (
    e?.cause && typeof e.cause === "object" ? e.cause : e
  ) as typeof e & { severity?: unknown };
  const code =
    typeof pg?.code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(pg.code)
      ? pg.code
      : error instanceof Error
        ? error.constructor.name
        : "UnknownError";
  // Only PostgreSQL's own message (it has a severity); a driver message may
  // carry the query or connection details.
  return typeof pg?.severity === "string" && typeof pg.message === "string"
    ? `${code}: ${pg.message}`
    : code;
}

export async function runMigrate(args: string[]): Promise<number> {
  if (args.includes("--help")) {
    console.log(MIGRATE_USAGE);
    return 0;
  }
  if (args.some((a) => a !== "--adopt")) {
    console.error(MIGRATE_USAGE);
    return 1;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    return 1;
  }

  const client = postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { TimeZone: "UTC" },
  });
  try {
    if (args.includes("--adopt")) {
      return await adoptBaseline({
        table: postgresMigrationsTable(client),
        schemaDiff: () => baselineSchemaDiff({ client, url }),
      });
    }
    await migrate(drizzle({ client }), {
      migrationsFolder: MIGRATIONS_FOLDER,
    });
    console.log("Migrations applied.");
    return 0;
  } catch (error) {
    console.error(`Migration failed (${describeError(error)})`);
    return 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

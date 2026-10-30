import { spawnSync } from "node:child_process";
import postgres from "postgres";

/**
 * Resets the database to a freshly migrated, empty schema before the suite.
 *
 * Destructive by design, so it refuses to touch anything whose name does not
 * end in `_e2e`. That check runs before any connection is opened.
 */
export default async function globalSetup() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL must point at an *_e2e database");
  }
  const parsed = new URL(url);
  // A query-string database name could override the path, so the path would
  // no longer be what the connection actually uses.
  for (const key of ["database", "dbname"]) {
    if (parsed.searchParams.has(key)) {
      throw new Error(`Refusing to run: DATABASE_URL must not set "${key}"`);
    }
  }
  const dbName = decodeURIComponent(parsed.pathname.slice(1));
  if (!dbName.endsWith("_e2e")) {
    throw new Error(
      `Refusing to reset database "${dbName}": the e2e suite only runs against a database whose name ends in "_e2e"`
    );
  }
  // CI service containers are on localhost too, so a loopback host is always
  // required: never reset a database on another machine.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(
      `Refusing to reset a database on "${host}": the e2e suite only runs against a loopback host`
    );
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // `drizzle` holds the migration journal; leaving it would make migrate
    // skip everything against the emptied schema.
    await sql.unsafe("drop schema if exists drizzle cascade");
    await sql.unsafe("drop schema public cascade");
    await sql.unsafe("create schema public");
  } finally {
    await sql.end();
  }

  // drizzle.config.ts loads .env.local, but a variable that is already set
  // wins over the file, so the explicit DATABASE_URL below is the one used.
  const result = spawnSync("bunx", ["drizzle-kit", "migrate"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
  if (result.status !== 0) {
    throw new Error("drizzle-kit migrate failed");
  }
}

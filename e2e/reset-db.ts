import { spawnSync } from "node:child_process";
import postgres from "postgres";

/**
 * Resets the database to a freshly migrated, empty schema before the suite.
 *
 * Run as the first step of playwright.config.ts's `webServer.command`, so it
 * finishes before the server (and its job worker) connects: Playwright starts
 * `webServer` before `globalSetup`, which would drop the schema under a
 * running server. Started with `--no-env-file`, so only the environment the
 * config hands over counts, never a developer's .env.local.
 *
 * Destructive by design, so it refuses to touch anything whose name does not
 * end in `_e2e`. That check runs before any connection is opened.
 */
async function resetDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL must point at an *_e2e database");
  }
  const parsed = new URL(url);
  // Fail closed: postgres.js lets query parameters (`host`, `hostaddr`,
  // `database`, `options`, ...) override the URL's own host and path, which
  // would defeat the checks below. A plain URL has none.
  if (parsed.search !== "") {
    throw new Error(
      "Refusing to run: DATABASE_URL must not carry a query string"
    );
  }
  const dbName = decodeURIComponent(parsed.pathname.slice(1));
  if (!dbName.endsWith("_e2e")) {
    throw new Error(
      `Refusing to reset database "${dbName}": the e2e suite only runs against a database whose name ends in "_e2e"`
    );
  }
  // CI service containers are on localhost too, so a loopback host is always
  // required: never reset a database on another machine.
  const isLoopback = (h: string) =>
    ["localhost", "127.0.0.1", "::1"].includes(
      h
        .toLowerCase()
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "")
    );
  if (!isLoopback(parsed.hostname)) {
    throw new Error(
      `Refusing to reset a database on "${parsed.hostname}": the e2e suite only runs against a loopback host`
    );
  }
  // The URL's host wins over these today; check anyway so a client change
  // cannot silently redirect the reset.
  for (const name of ["PGHOST", "PGHOSTADDR"]) {
    const value = process.env[name];
    if (value && !isLoopback(value)) {
      throw new Error(`Refusing to run: ${name} is set to "${value}"`);
    }
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

try {
  await resetDatabase();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

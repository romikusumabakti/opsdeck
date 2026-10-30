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
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!dbName.endsWith("_e2e")) {
    throw new Error(
      `Refusing to reset database "${dbName}": the e2e suite only runs against a database whose name ends in "_e2e"`
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

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { relations } from "./relations";

function createDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }

  const client = postgres(process.env.DATABASE_URL, {
    // A small pool: the app runs a handful of concurrent server actions and
    // SSE streams. `max: 1` serialized everything head-of-line; 10 is plenty
    // for an internal ops panel and stays well under Postgres' default 100.
    max: 10,
    // Timestamp columns are `timestamp` (no time zone) holding UTC wall-clock
    // time, which is what drizzle writes from JS Dates. DB-side `now()` and
    // column defaults follow the session time zone, so pin it to UTC; the
    // production server default is Asia/Jakarta, which stored those values
    // 7 hours ahead.
    connection: { TimeZone: "UTC" },
  });

  return drizzle({ client, relations });
}

let dbInstance: ReturnType<typeof createDb> | undefined;

function getDb() {
  if (!dbInstance) dbInstance = createDb();
  return dbInstance;
}

// Lazy proxy: the connection (and the DATABASE_URL check) is deferred to first
// use rather than module evaluation, so the CLI, the build and tests can import
// modules that reach `db` without a DATABASE_URL. This still throws at runtime
// if the env var is genuinely missing when a query runs.
export const db = new Proxy({} as ReturnType<typeof createDb>, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

/**
 * The postgres.js client behind `db`, for what drizzle does not cover (a
 * reserved connection for a session-level advisory lock). Not through the
 * proxy, which binds functions and so hides the client's own methods.
 */
export function pgClient() {
  return getDb().$client;
}

/**
 * A connection of its own for one session-level advisory lock, outside `db`'s
 * pool: a lock held for a whole SSH run must never take a query slot from the
 * app (its holder still needs the pool, so held locks would starve or
 * deadlock it). It never idles out or recycles, which would end the session
 * and so drop the lock mid-run; the holder ends it. `onclose` runs when the
 * session is gone, for whatever reason.
 */
export function lockConnection(onclose: () => void) {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  return postgres(process.env.DATABASE_URL, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    connect_timeout: 5,
    connection: { TimeZone: "UTC" },
    onclose,
  });
}

/** The pool or a transaction handle: what a query helper can run against. */
export type DbExecutor = Pick<typeof db, "select" | "update" | "insert">;

/** The handle `db.transaction` passes to its callback. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

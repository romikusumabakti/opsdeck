import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { relations } from "./relations";

// Cache the postgres.js client on globalThis so Next.js dev hot-reload (which
// re-evaluates this module on every change) reuses one pool instead of leaking
// a new one per reload until the database refuses connections.
const globalForDb = globalThis as unknown as {
  __pgClient?: ReturnType<typeof postgres>;
};

function createDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }

  const client =
    globalForDb.__pgClient ??
    postgres(process.env.DATABASE_URL, {
      // A small pool: the app runs a handful of concurrent server actions and
      // SSE streams. `max: 1` serialized everything head-of-line; 10 is plenty
      // for an internal ops panel and stays well under Postgres' default 100.
      max: 10,
    });

  if (process.env.NODE_ENV !== "production") {
    globalForDb.__pgClient = client;
  }

  return drizzle({ client, relations });
}

let dbInstance: ReturnType<typeof createDb> | undefined;

function getDb() {
  if (!dbInstance) dbInstance = createDb();
  return dbInstance;
}

// Lazy proxy: the connection (and the DATABASE_URL check) is deferred to first
// use rather than module evaluation. `next build` collects page data by
// evaluating route modules with no DATABASE_URL in the environment; throwing at
// import time there broke the build. This still throws at runtime if the env
// var is genuinely missing when a query runs.
export const db = new Proxy({} as ReturnType<typeof createDb>, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { relations } from "./relations";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// Cache the postgres.js client on globalThis so Next.js dev hot-reload (which
// re-evaluates this module on every change) reuses one pool instead of leaking
// a new one per reload until the database refuses connections.
const globalForDb = globalThis as unknown as {
  __pgClient?: ReturnType<typeof postgres>;
};

const client =
  globalForDb.__pgClient ??
  postgres(process.env.DATABASE_URL, {
    // A small pool: the app runs a handful of concurrent server actions and SSE
    // streams. `max: 1` serialized everything head-of-line; 10 is plenty for an
    // internal ops panel and stays well under Postgres' default 100.
    max: 10,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__pgClient = client;
}

export const db = drizzle({
  client,
  relations,
});

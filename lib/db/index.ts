import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { relations } from "./relations";

const client = postgres(process.env.DATABASE_URL!, {
  max: 1,
});

export const db = drizzle({
  client,
  schema,
  relations,
});

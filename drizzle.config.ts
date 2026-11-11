import { existsSync } from "node:fs";
import type { Config } from "drizzle-kit";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export default {
  schema: "./lib/db/schema.ts",
  // The migrator runs every folder in here: the baseline and newer migrations.
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config;

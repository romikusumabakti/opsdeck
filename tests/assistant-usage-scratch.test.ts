import { execFileSync, spawnSync } from "node:child_process";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";

vi.mock("@/lib/authz", () => ({
  requireOrgPermission: vi.fn(async () => ({})),
}));

// getAssistantUsage against a real Postgres: the local menara-postgres
// container (postgres 18) through its published port, with the superuser
// password read from the container and never printed. It creates a scratch
// database, migrates it with `menara migrate` and drops it afterwards.
//
//   ASSISTANT_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/assistant-usage-scratch.test.ts
const enabled = process.env.ASSISTANT_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "assistant_usage_scratch";

function psql(db: string, args: string[]) {
  return execFileSync(
    "podman",
    [
      "exec",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      db,
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("expected a row");
  return row;
}

describe.skipIf(!enabled)("getAssistantUsage on a real Postgres", () => {
  let client: ReturnType<typeof postgres>;
  let previousUrl: string | undefined;

  beforeAll(() => {
    const password = encodeURIComponent(
      execFileSync("podman", [
        "exec",
        CONTAINER,
        "printenv",
        "POSTGRES_PASSWORD",
      ])
        .toString()
        .trim()
    );
    const url = `postgres://postgres:${password}@127.0.0.1:5432/${DB_NAME}`;
    psql("postgres", [
      "-c",
      `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`,
      "-c",
      `CREATE DATABASE ${DB_NAME}`,
    ]);
    const result = spawnSync("bun", ["scripts/cli.ts", "migrate"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: url,
      },
    });
    if (result.status !== 0)
      throw new Error(`migrate failed: ${result.stderr}`);
    // lib/db reads DATABASE_URL lazily, on the first query.
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    client = postgres(url, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await client?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
  });

  it("aggregates per day and user, counts a message once, and bounds the range", async () => {
    const d = drizzle({ client });
    const { getAssistantUsage } = await import(
      "@/server/services/assistant-settings"
    );
    const [ana, budi] = await d
      .insert(schema.users)
      .values([
        { id: crypto.randomUUID(), name: "Ana", email: "ana@example.com" },
        { id: crypto.randomUUID(), name: "Budi", email: "budi@example.com" },
      ])
      .returning();
    if (!ana || !budi) throw new Error("users not seeded");
    const project = one(
      await d
        .insert(schema.projects)
        .values({ name: "P", key: "p" })
        .returning()
    );
    const conversation = one(
      await d
        .insert(schema.assistantConversations)
        .values({
          userId: ana.id,
          projectId: project.id,
          environmentName: "Dev",
        })
        .returning()
    );
    const message = async () =>
      one(
        await d
          .insert(schema.assistantMessages)
          .values({
            conversationId: conversation.id,
            role: "assistant",
            status: "done",
          })
          .returning()
      ).id;
    const [m1, m2, m3] = [await message(), await message(), await message()];

    const usage = (
      userId: string,
      day: string,
      messageId: string | null,
      costUsd: string
    ) => ({ userId, day, messageId, costUsd, model: "acme-max" });
    await d.insert(schema.assistantUsage).values([
      // Ana, 2026-11-16: one message metered in two iterations, plus another.
      usage(ana.id, "2026-11-16", m1, "0.100000"),
      usage(ana.id, "2026-11-16", m1, "0.200000"),
      usage(ana.id, "2026-11-16", m2, "0.050000"),
      // Budi, same day, and the day before.
      usage(budi.id, "2026-11-16", m3, "0.300000"),
      usage(budi.id, "2026-11-15", null, "0.010000"),
      // Out of the requested range, but this month.
      usage(ana.id, "2026-11-02", m1, "1.000000"),
      // Previous month: in neither total.
      usage(ana.id, "2026-10-31", m1, "5.000000"),
    ]);

    const now = new Date("2026-11-16T05:00:00Z");
    const result = await getAssistantUsage(
      { from: "2026-11-10", to: "2026-11-16" },
      now
    );
    expect(result.rows).toEqual([
      {
        day: "2026-11-16",
        userId: ana.id,
        userName: "Ana",
        turns: 2,
        costUsd: 0.35,
      },
      {
        day: "2026-11-16",
        userId: budi.id,
        userName: "Budi",
        turns: 1,
        costUsd: 0.3,
      },
      {
        day: "2026-11-15",
        userId: budi.id,
        userName: "Budi",
        turns: 0,
        costUsd: 0.01,
      },
    ]);
    expect(result.totalUsd).toBeCloseTo(0.66, 6);
    // 11-02 .. 11-16 of November: 1.00 + 0.66.
    expect(result.monthToDateUsd).toBeCloseTo(1.66, 6);
  });
});

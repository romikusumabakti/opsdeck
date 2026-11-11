import { afterEach, describe, expect, it, vi } from "vitest";

const postgresCalls: { url: string; options: Record<string, unknown> }[] = [];

vi.mock("postgres", () => ({
  default: (url: string, options: Record<string, unknown>) => {
    postgresCalls.push({ url, options });
    return {};
  },
}));
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: () => ({ marker: true }),
}));

afterEach(() => {
  postgresCalls.length = 0;
});

describe("database connection", () => {
  it("runs every session in UTC so DB-side now() matches the app's UTC timestamps", async () => {
    const { db } = await import("@/lib/db");
    expect((db as unknown as { marker: boolean }).marker).toBe(true);
    expect(postgresCalls).toHaveLength(1);
    expect(postgresCalls[0]?.options.connection).toEqual({ TimeZone: "UTC" });
  });
});

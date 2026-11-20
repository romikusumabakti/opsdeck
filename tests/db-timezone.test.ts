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

describe("zoned days", () => {
  it("zonedDayStart gives local midnight in UTC", async () => {
    const { zonedDayStart } = await import("@/lib/timezone");
    expect(zonedDayStart("2026-11-20", "Asia/Jakarta").toISOString()).toBe(
      "2026-11-19T17:00:00.000Z"
    );
    // The day the clocks spring forward: midnight is still EST (UTC-5).
    expect(zonedDayStart("2026-03-08", "America/New_York").toISOString()).toBe(
      "2026-03-08T05:00:00.000Z"
    );
    expect(zonedDayStart("2026-03-09", "America/New_York").toISOString()).toBe(
      "2026-03-09T04:00:00.000Z"
    );
  });

  it("zonedToday", async () => {
    const { zonedToday } = await import("@/lib/timezone");
    expect(zonedToday(new Date("2026-11-20T18:00:00Z"), "Asia/Jakarta")).toBe(
      "2026-11-21"
    );
  });
});

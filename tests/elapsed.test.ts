import { describe, expect, it } from "bun:test";
import { formatElapsed } from "@/lib/elapsed";

describe("formatElapsed", () => {
  const start = new Date("2026-10-03T10:00:00Z");
  it("shows seconds under a minute", () => {
    expect(formatElapsed(start, start.getTime() + 42_000)).toBe("42s");
  });
  it("shows minutes and seconds", () => {
    expect(formatElapsed(start, start.getTime() + 125_000)).toBe("2m 5s");
  });
  it("accepts the ISO string a server action delivers", () => {
    expect(formatElapsed(start.toISOString(), start.getTime() + 1000)).toBe(
      "1s"
    );
  });
  it("never goes negative on clock skew", () => {
    expect(formatElapsed(start, start.getTime() - 5000)).toBe("0s");
  });
});

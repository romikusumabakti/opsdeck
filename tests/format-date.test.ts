import { describe, expect, it } from "vitest";
import { DATE_ONLY, DATE_TIME, DATE_TIME_SECONDS } from "@/lib/format-date";

const instant = new Date("2026-10-31T06:00:00Z");

function fmt(options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-US", {
    ...options,
    timeZone: "Asia/Jakarta",
  }).format(instant);
}

describe("format-date", () => {
  it("DATE_ONLY is a medium date", () => {
    expect(fmt(DATE_ONLY)).toBe("Oct 31, 2026");
  });
  it("DATE_TIME adds a short time", () => {
    expect(fmt(DATE_TIME)).toMatch(/^Oct 31, 2026,? 1:00\sPM$/);
  });
  it("DATE_TIME_SECONDS adds seconds", () => {
    expect(fmt(DATE_TIME_SECONDS)).toMatch(/^Oct 31, 2026,? 1:00:00\sPM$/);
  });
});

import { describe, expect, it } from "vitest";
import {
  DATE_ONLY,
  DATE_TIME,
  DATE_TIME_SECONDS,
  formatAuditInstant,
} from "@/lib/format-date";

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

describe("formatAuditInstant", () => {
  it("renders yyyy-MM-dd HH:mm in the given zone with its short name", () => {
    expect(
      formatAuditInstant(new Date("2026-11-10T03:00:00.000Z"), "Asia/Jakarta")
    ).toBe("2026-11-10 10:00 GMT+7");
  });
  it("zero-pads and uses a 24-hour clock at midnight", () => {
    expect(
      formatAuditInstant(new Date("2026-01-02T17:00:00.000Z"), "Asia/Jakarta")
    ).toBe("2026-01-03 00:00 GMT+7");
  });
});

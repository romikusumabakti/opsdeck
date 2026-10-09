import { describe, expect, it } from "bun:test";
import {
  APP_TIMEZONE,
  effectiveTimeZone,
  isValidTimeZone,
} from "@/lib/timezone";
import {
  profileInputSchema,
  statusEmojiSchema,
  statusInputSchema,
  timeZoneSchema,
  workingHoursSchema,
} from "@/lib/validation";

describe("timeZoneSchema", () => {
  it.each([
    "Asia/Jakarta",
    "Asia/Makassar",
    "UTC",
    "Asia/Calcutta",
    "Etc/GMT+7",
    "America/Argentina/Buenos_Aires",
  ])("accepts %s", (tz) =>
    expect(timeZoneSchema.safeParse(tz).success).toBe(true)
  );
  it.each(["", "+07:00", "Mars/Olympus", "asia jakarta", "GMT+7:00"])(
    "rejects %s",
    (tz) => expect(timeZoneSchema.safeParse(tz).success).toBe(false)
  );
});

describe("effectiveTimeZone", () => {
  it("uses the user's zone when valid", () => {
    expect(effectiveTimeZone({ timezone: "Asia/Makassar" })).toBe(
      "Asia/Makassar"
    );
  });
  it.each([null, undefined, { timezone: null }, { timezone: "Not/AZone" }])(
    "falls back to APP_TIMEZONE for %p",
    (u) => expect(effectiveTimeZone(u)).toBe(APP_TIMEZONE)
  );
  it("isValidTimeZone rejects offsets", () => {
    expect(isValidTimeZone("+07:00")).toBe(false);
  });
});

describe("workingHoursSchema", () => {
  const ok = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
  it("accepts a normal week", () => {
    expect(workingHoursSchema.safeParse(ok).success).toBe(true);
  });
  it.each([
    ["no days", { ...ok, days: [] }],
    ["duplicate days", { ...ok, days: [1, 1] }],
    ["day 0", { ...ok, days: [0] }],
    ["day 8", { ...ok, days: [8] }],
    ["start == end", { ...ok, end: "09:00" }],
    ["overnight", { ...ok, start: "22:00", end: "06:00" }],
    ["bad time", { ...ok, start: "9:00" }],
    ["24:00", { ...ok, end: "24:00" }],
  ])("rejects %s", (_label, value) => {
    expect(workingHoursSchema.safeParse(value).success).toBe(false);
  });
});

describe("statusEmojiSchema", () => {
  it.each(["🌴", "🎯", "🇮🇩", "👨‍👩‍👧‍👦", "🧑🏽‍💻", "☕"])("accepts %s", (e) =>
    expect(statusEmojiSchema.safeParse(e).success).toBe(true)
  );
  it.each(["", "a", "🌴🌴", ":)", "🌴 "])("rejects %p", (e) =>
    expect(statusEmojiSchema.safeParse(e).success).toBe(false)
  );
});

describe("profileInputSchema", () => {
  const base = {
    name: "Budi",
    title: "",
    bio: "",
    timezone: null,
    workingHours: null,
  };
  it("trims and turns blanks into null", () => {
    const r = profileInputSchema.parse({
      ...base,
      name: "  Budi  ",
      title: "  ",
    });
    expect(r).toEqual({
      name: "Budi",
      title: null,
      bio: null,
      timezone: null,
      workingHours: null,
    });
  });
  it("rejects an empty name", () => {
    expect(profileInputSchema.safeParse({ ...base, name: "  " }).success).toBe(
      false
    );
  });
  it("enforces limits", () => {
    expect(
      profileInputSchema.safeParse({ ...base, title: "x".repeat(81) }).success
    ).toBe(false);
    expect(
      profileInputSchema.safeParse({ ...base, bio: "x".repeat(281) }).success
    ).toBe(false);
    expect(
      profileInputSchema.safeParse({ ...base, bio: "x".repeat(280) }).success
    ).toBe(true);
  });
});

describe("statusInputSchema", () => {
  it("needs an emoji or text", () => {
    expect(
      statusInputSchema.safeParse({ emoji: null, text: "", expiresAt: null })
        .success
    ).toBe(false);
    expect(
      statusInputSchema.safeParse({ emoji: "🌴", text: "", expiresAt: null })
        .success
    ).toBe(true);
  });
  it("requires an ISO instant with offset", () => {
    expect(
      statusInputSchema.safeParse({
        emoji: "🌴",
        text: null,
        expiresAt: "2026-10-10",
      }).success
    ).toBe(false);
    expect(
      statusInputSchema.safeParse({
        emoji: "🌴",
        text: null,
        expiresAt: "2026-10-10T00:00:00Z",
      }).success
    ).toBe(true);
  });
});

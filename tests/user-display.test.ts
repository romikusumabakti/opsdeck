import { describe, expect, it } from "bun:test";
import {
  AVATAR_COLOR_COUNT,
  activeStatus,
  avatarColorIndex,
  expiryFromPreset,
  getInitials,
  initialStatusExpiry,
  isWithinWorkingHours,
  liveCardStatus,
  nextWorkingStart,
  resolveStatusExpiry,
  zonedClock,
} from "@/lib/user-display";

describe("getInitials", () => {
  it.each([
    ["Romi Kusuma Bakti", "RK"],
    ["budi", "B"],
    ["  ana   maria ", "AM"],
    ["Élodie Ørsted", "ÉØ"],
    ["𝒜lpha Beta", "𝒜B"],
  ])("%s -> %s", (name, expected) => {
    expect(getInitials(name)).toBe(expected);
  });

  it("falls back to the fallback (email) when the name is blank", () => {
    expect(getInitials("   ", "dev@x.id")).toBe("D");
  });

  it("returns an empty string when both are blank", () => {
    expect(getInitials("", "")).toBe("");
  });
});

describe("avatarColorIndex", () => {
  it("is deterministic and in range", () => {
    const id = "0199a1b2-0000-7000-8000-000000000001";
    expect(avatarColorIndex(id)).toBe(avatarColorIndex(id));
    expect(avatarColorIndex(id)).toBeGreaterThanOrEqual(0);
    expect(avatarColorIndex(id)).toBeLessThan(AVATAR_COLOR_COUNT);
  });

  it("spreads ids over more than one colour", () => {
    const seen = new Set(
      Array.from({ length: 50 }, (_, i) => avatarColorIndex(`user-${i}`))
    );
    expect(seen.size).toBeGreaterThan(4);
  });
});

describe("activeStatus", () => {
  const now = new Date("2026-10-09T10:00:00Z");
  const base = {
    statusEmoji: "🌴",
    statusText: "Leave",
    statusExpiresAt: null,
  };

  it("returns null when nothing is set", () => {
    expect(
      activeStatus(
        { statusEmoji: null, statusText: null, statusExpiresAt: null },
        now
      )
    ).toBeNull();
  });

  it("returns the status with no expiry", () => {
    expect(activeStatus(base, now)).toEqual({
      emoji: "🌴",
      text: "Leave",
      expiresAt: null,
    });
  });

  it("keeps a status that expires in the future (string or Date)", () => {
    expect(
      activeStatus({ ...base, statusExpiresAt: "2026-10-09T10:00:01Z" }, now)
    ).not.toBeNull();
  });

  it("drops a status at exactly its expiry", () => {
    expect(
      activeStatus({ ...base, statusExpiresAt: new Date(now) }, now)
    ).toBeNull();
  });
});

describe("working hours", () => {
  const wh = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
  // 2026-10-09 is a Friday.
  it("reads the wall clock in the given zone", () => {
    expect(
      zonedClock("Asia/Jakarta", new Date("2026-10-09T02:30:00Z"))
    ).toEqual({
      weekday: 5,
      minutes: 9 * 60 + 30,
    });
    // Same instant is still Thursday evening in New York.
    expect(
      zonedClock("America/New_York", new Date("2026-10-09T02:30:00Z")).weekday
    ).toBe(4);
  });

  it("is inside at start, outside at end", () => {
    expect(
      isWithinWorkingHours(wh, "Asia/Jakarta", new Date("2026-10-09T02:00:00Z"))
    ).toBe(true); // 09:00 WIB
    expect(
      isWithinWorkingHours(wh, "Asia/Jakarta", new Date("2026-10-09T10:00:00Z"))
    ).toBe(false); // 17:00 WIB
  });

  it("is outside on a non-working day", () => {
    expect(
      isWithinWorkingHours(wh, "Asia/Jakarta", new Date("2026-10-10T03:00:00Z"))
    ).toBe(false); // Sat 10:00
  });

  it("next start: later today, tomorrow, after the weekend, none while inside", () => {
    expect(
      nextWorkingStart(wh, "Asia/Jakarta", new Date("2026-10-09T00:00:00Z"))
    ).toEqual({ daysAhead: 0, start: "09:00" }); // Fri 07:00
    expect(
      nextWorkingStart(wh, "Asia/Jakarta", new Date("2026-10-08T12:00:00Z"))
    ).toEqual({ daysAhead: 1, start: "09:00" }); // Thu 19:00
    expect(
      nextWorkingStart(wh, "Asia/Jakarta", new Date("2026-10-09T12:00:00Z"))
    ).toEqual({ daysAhead: 3, start: "09:00" }); // Fri 19:00 -> Mon
    expect(
      nextWorkingStart(wh, "Asia/Jakarta", new Date("2026-10-09T03:00:00Z"))
    ).toBeNull();
  });

  it("wraps a full week when the only working day has passed", () => {
    const fridays = { days: [5], start: "09:00", end: "10:00" };
    expect(
      nextWorkingStart(fridays, "UTC", new Date("2026-10-09T11:00:00Z"))
    ).toEqual({ daysAhead: 7, start: "09:00" });
  });
});

describe("liveCardStatus", () => {
  const now = new Date("2026-01-01T10:00:00Z");
  const base = { emoji: "x", text: "Away" };

  it("keeps a status with no expiry or a future expiry", () => {
    expect(liveCardStatus({ ...base, expiresAt: null }, now)).not.toBeNull();
    expect(
      liveCardStatus({ ...base, expiresAt: "2026-01-01T10:00:01Z" }, now)
    ).not.toBeNull();
  });
  it("drops a status that expired, including exactly now", () => {
    expect(
      liveCardStatus({ ...base, expiresAt: "2026-01-01T10:00:00Z" }, now)
    ).toBeNull();
    expect(
      liveCardStatus({ ...base, expiresAt: "2025-12-31T00:00:00Z" }, now)
    ).toBeNull();
  });
  it("passes null through", () => {
    expect(liveCardStatus(null, now)).toBeNull();
  });
});

describe("status expiry choice", () => {
  const now = new Date("2026-10-09T03:00:00Z");
  const kept = "2026-10-09T09:00:00.000Z";
  it("defaults to keeping whatever the current status has", () => {
    expect(initialStatusExpiry(null)).toBe("today");
    expect(initialStatusExpiry({ expiresAt: kept })).toBe("keep");
    expect(initialStatusExpiry({ expiresAt: null })).toBe("never");
  });
  it("keep sends the current expiry unchanged", () => {
    expect(resolveStatusExpiry("keep", kept, now, "Asia/Jakarta")).toBe(kept);
    expect(resolveStatusExpiry("keep", null, now, "Asia/Jakarta")).toBeNull();
  });
  it("a preset is computed from now", () => {
    expect(resolveStatusExpiry("1h", kept, now, "Asia/Jakarta")).toBe(
      "2026-10-09T04:00:00.000Z"
    );
    expect(resolveStatusExpiry("never", kept, now, "UTC")).toBeNull();
  });
});

describe("expiryFromPreset", () => {
  const now = new Date("2026-10-09T03:00:00Z"); // Fri 10:00 WIB
  it("adds durations", () => {
    expect(expiryFromPreset("30m", now, "Asia/Jakarta")?.toISOString()).toBe(
      "2026-10-09T03:30:00.000Z"
    );
    expect(expiryFromPreset("1h", now, "Asia/Jakarta")?.toISOString()).toBe(
      "2026-10-09T04:00:00.000Z"
    );
    expect(expiryFromPreset("4h", now, "Asia/Jakarta")?.toISOString()).toBe(
      "2026-10-09T07:00:00.000Z"
    );
  });
  it("ends today at local midnight", () => {
    expect(expiryFromPreset("today", now, "Asia/Jakarta")?.toISOString()).toBe(
      "2026-10-09T17:00:00.000Z"
    );
  });
  it("ends the week at local Monday 00:00", () => {
    expect(expiryFromPreset("week", now, "Asia/Jakarta")?.toISOString()).toBe(
      "2026-10-11T17:00:00.000Z"
    );
  });
  it("never", () => {
    expect(expiryFromPreset("never", now, "Asia/Jakarta")).toBeNull();
  });
  it("handles negative-offset zones", () => {
    // Fri 2026-10-09 23:30 in New York (EDT, UTC-4) -> local midnight is 04:00Z next day
    const ny = new Date("2026-10-10T03:30:00Z");
    expect(
      expiryFromPreset("today", ny, "America/New_York")?.toISOString()
    ).toBe("2026-10-10T04:00:00.000Z");
    expect(
      expiryFromPreset("week", ny, "America/New_York")?.toISOString()
    ).toBe("2026-10-12T04:00:00.000Z");
  });
  it("ends the week on the next Monday when today is Sunday or Monday", () => {
    const sun = new Date("2026-10-11T03:00:00Z"); // Sun 10:00 WIB
    expect(expiryFromPreset("week", sun, "Asia/Jakarta")?.toISOString()).toBe(
      "2026-10-11T17:00:00.000Z"
    );
    const mon = new Date("2026-10-12T03:00:00Z"); // Mon 10:00 WIB
    expect(expiryFromPreset("week", mon, "Asia/Jakarta")?.toISOString()).toBe(
      "2026-10-18T17:00:00.000Z"
    );
  });
});

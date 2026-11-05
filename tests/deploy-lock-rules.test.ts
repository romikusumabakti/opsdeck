import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canLock,
  canUnlock,
  defaultLockExpiry,
  isLockActive,
  lockExpirySchema,
} from "@/lib/deploy/lock";

// Asia/Jakarta is UTC+7 without DST.
const wib = (day: number, h: number, m = 0) =>
  new Date(Date.UTC(2026, 10, day, h - 7, m));

describe("defaultLockExpiry", () => {
  it("is 17:00 WIB today in the morning", () => {
    expect(defaultLockExpiry(wib(5, 9))).toEqual(wib(5, 17));
  });
  it("is now + 2 h after 16:00 WIB", () => {
    expect(defaultLockExpiry(wib(5, 16, 30))).toEqual(wib(5, 18, 30));
  });
  it("crosses midnight", () => {
    expect(defaultLockExpiry(wib(5, 23))).toEqual(wib(6, 1));
  });
  it("uses the WIB day, not the UTC day", () => {
    // 02:00 WIB on the 6th is still the 5th in UTC.
    expect(defaultLockExpiry(wib(6, 2))).toEqual(wib(6, 17));
  });
});

describe("lockExpirySchema", () => {
  afterEach(() => vi.useRealTimers());
  const at = (now: Date) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  };

  it("accepts an expiry within 7 days", () => {
    const now = wib(5, 9);
    at(now);
    expect(
      lockExpirySchema.safeParse(new Date(now.getTime() + 3600_000)).success
    ).toBe(true);
    expect(
      lockExpirySchema.safeParse(new Date(now.getTime() + 7 * 86_400_000))
        .success
    ).toBe(true);
  });
  it("rejects past and more than 7 days ahead", () => {
    const now = wib(5, 9);
    at(now);
    expect(lockExpirySchema.safeParse(now).success).toBe(false);
    expect(
      lockExpirySchema.safeParse(new Date(now.getTime() + 8 * 86_400_000))
        .success
    ).toBe(false);
  });
});

describe("isLockActive", () => {
  const now = wib(5, 9);
  it("is false without a lock", () => {
    expect(isLockActive(null, now)).toBe(false);
  });
  it("is true before expiry, false at and after", () => {
    expect(isLockActive({ expiresAt: new Date(now.getTime() + 1) }, now)).toBe(
      true
    );
    expect(isLockActive({ expiresAt: now }, now)).toBe(false);
    expect(isLockActive({ expiresAt: new Date(now.getTime() - 1) }, now)).toBe(
      false
    );
  });
});

describe("permissions", () => {
  it("canLock", () => {
    expect(canLock("viewer", false)).toBe(false);
    expect(canLock("viewer", true)).toBe(true);
    expect(canLock("contributor", false)).toBe(false);
    expect(canLock("maintainer", false)).toBe(true);
    expect(canLock(null, false)).toBe(false);
  });
  it("canUnlock is owner or locker only", () => {
    expect(canUnlock(true, false)).toBe(true);
    expect(canUnlock(false, true)).toBe(true);
    expect(canUnlock(false, false)).toBe(false);
  });
});

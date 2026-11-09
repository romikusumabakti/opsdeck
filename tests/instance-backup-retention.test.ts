import { describe, expect, it } from "vitest";
import {
  selectByCount,
  selectForDeletion,
  selectStaleIncomplete,
} from "@/lib/instance-backup/retention";

const DAY = 24 * 60 * 60 * 1000;
// 2026-11-09 is a Monday.
const NEWEST = Date.UTC(2026, 10, 9, 19, 30);

function dailyKeys(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const createdAt = new Date(NEWEST - i * DAY);
    return { key: createdAt.toISOString().slice(0, 10), createdAt };
  });
}

describe("selectForDeletion", () => {
  it("keeps 14 dailies plus up to 8 weekly representatives of 40 daily keys", () => {
    const keys = dailyKeys(40);
    const deleted = selectForDeletion(keys, 14, 8);
    const kept = keys.map((k) => k.key).filter((k) => !deleted.includes(k));

    // The 14 newest days, 2026-11-09 back to 2026-10-27 (a Tuesday), then the
    // newest of each older ISO week that has no kept daily: Oct 26 shares its
    // week with the kept Oct 27..Nov 1 and goes.
    expect(kept).toEqual([
      ...keys.slice(0, 14).map((k) => k.key),
      "2026-10-25",
      "2026-10-18",
      "2026-10-11",
      "2026-10-04",
    ]);
    expect(deleted).toHaveLength(40 - 18);
  });

  it("stops at keepWeekly weeks", () => {
    const keys = dailyKeys(200);
    const deleted = selectForDeletion(keys, 14, 8);
    expect(keys.length - deleted.length).toBe(14 + 8);
  });

  it("keeps the newest of several keys on one day", () => {
    const a = { key: "a", createdAt: new Date(NEWEST) };
    const b = { key: "b", createdAt: new Date(NEWEST - 60_000) };
    expect(selectForDeletion([b, a], 1, 0)).toEqual(["b"]);
  });
  it.each([
    [0, 0],
    [0, 1],
  ])("always keeps the newest key with (%i, %i)", (keepDaily, keepWeekly) => {
    const keys = dailyKeys(10);
    const deleted = selectForDeletion(keys, keepDaily, keepWeekly);
    expect(deleted).not.toContain(keys[0]?.key);
    expect(deleted).toHaveLength(9);
  });
});

describe("selectStaleIncomplete", () => {
  it("returns incomplete backups older than 24 hours", () => {
    const keys = dailyKeys(3);
    const now = new Date(NEWEST + 60_000);
    expect(selectStaleIncomplete(keys, now)).toEqual([
      keys[1]?.key,
      keys[2]?.key,
    ]);
  });
});

describe("selectByCount", () => {
  it("keeps the newest n", () => {
    const keys = dailyKeys(5);
    expect(selectByCount([...keys].reverse(), 3)).toEqual([
      keys[3]?.key,
      keys[4]?.key,
    ]);
  });
});

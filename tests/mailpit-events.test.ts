import { describe, expect, it } from "bun:test";
import { mailEventType } from "@/lib/mailpit/events";

describe("mailEventType", () => {
  it.each(["new", "update", "delete", "truncate", "prune"])(
    "relays %s frames",
    (type) => {
      expect(mailEventType(JSON.stringify({ Type: type, Data: {} }))).toBe(type);
    }
  );

  it.each([
    JSON.stringify({ Type: "stats", Data: { Total: 3 } }),
    JSON.stringify({ Type: "error", Data: {} }),
    "not json",
    JSON.stringify({ nope: 1 }),
  ])("ignores %s", (raw) => {
    expect(mailEventType(raw)).toBeNull();
  });

  it("ignores binary frames", () => {
    expect(mailEventType(new ArrayBuffer(4))).toBeNull();
  });
});

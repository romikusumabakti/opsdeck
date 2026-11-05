import { describe, expect, it } from "vitest";
import { pickFreePort } from "@/lib/provisioning/ports";

describe("pickFreePort", () => {
  it("returns the lowest free port in the default range", () => {
    expect(pickFreePort([8100, 8101, 8103])).toBe(8102);
    expect(pickFreePort([])).toBe(8100);
  });

  it("returns null when the range is fully taken", () => {
    expect(pickFreePort([1, 2, 3], { from: 1, to: 3 })).toBeNull();
  });
});

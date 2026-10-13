import { describe, expect, it } from "bun:test";
import { nextAccentState } from "@/lib/accent-state";

describe("nextAccentState", () => {
  it("applies the requested accent optimistically", () => {
    expect(nextAccentState("blue", "rose", "pending")).toEqual({
      apply: "rose",
      rollbackTo: "blue",
    });
  });

  it("keeps the new accent when the save succeeds", () => {
    expect(nextAccentState("blue", "rose", "saved")).toEqual({
      apply: "rose",
      rollbackTo: null,
    });
  });

  it("rolls back to the previous accent when the save fails", () => {
    expect(nextAccentState("blue", "rose", "failed")).toEqual({
      apply: "blue",
      rollbackTo: null,
    });
  });

  it("does nothing when the accent is unchanged", () => {
    expect(nextAccentState("blue", "blue", "pending")).toBeNull();
  });
});

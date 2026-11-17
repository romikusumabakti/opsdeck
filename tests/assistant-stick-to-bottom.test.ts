import { describe, expect, it } from "vitest";
import { isNearBottom } from "@/web/components/assistant/stick-to-bottom";

describe("isNearBottom", () => {
  const at = (scrollTop: number) => ({
    scrollTop,
    scrollHeight: 1000,
    clientHeight: 400,
  });

  it("is true at the bottom", () => {
    expect(isNearBottom(at(600))).toBe(true);
  });

  it("is true within 48px of the bottom", () => {
    expect(isNearBottom(at(552))).toBe(true);
  });

  it("is false 200px up", () => {
    expect(isNearBottom(at(400))).toBe(false);
  });

  it("is true when the content fits without scrolling", () => {
    expect(
      isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })
    ).toBe(true);
  });
});

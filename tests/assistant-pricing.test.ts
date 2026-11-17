import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN,
  costUsd,
  estimateUsage,
} from "@/lib/assistant/pricing";
import type { Prices } from "@/lib/assistant/providers";

const PRICES: Prices = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const zero = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

describe("costUsd", () => {
  it("prices input tokens at the configured price", () => {
    expect(costUsd(PRICES, { ...zero, input: 1_000_000 })).toBe(4);
    expect(
      costUsd({ ...PRICES, input: 0.1 }, { ...zero, input: 1_000_000 })
    ).toBeCloseTo(0.1, 10);
  });

  it("prices cache reads, cache writes and output separately", () => {
    expect(
      costUsd(PRICES, {
        input: 0,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      })
    ).toBeCloseTo(25.2, 10);
  });

  it("is zero for no tokens", () => {
    expect(costUsd(PRICES, zero)).toBe(0);
  });
});

describe("estimateUsage", () => {
  it("rounds characters up to tokens, with no cache tokens", () => {
    expect(
      estimateUsage(CHARS_PER_TOKEN * 100 + 1, CHARS_PER_TOKEN * 3)
    ).toEqual({
      input: 101,
      cacheRead: 0,
      cacheWrite: 0,
      output: 3,
    });
  });

  it("is zero for no characters and never negative", () => {
    expect(estimateUsage(0, 0)).toEqual(zero);
    expect(estimateUsage(-5, -1)).toEqual(zero);
  });

  it("gives a priced estimate above zero for a real prompt", () => {
    expect(costUsd(PRICES, estimateUsage(20_000, 400))).toBeGreaterThan(0);
  });
});

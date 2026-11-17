import { describe, expect, it } from "vitest";
import {
  costUsd,
  MODEL_PRICES,
  UnknownModelPriceError,
} from "@/lib/assistant/pricing";

const zero = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

describe("costUsd", () => {
  it("prices input tokens", () => {
    expect(costUsd("claude-opus-5-5", { ...zero, input: 1_000_000 })).toBe(4);
  });

  it("prices cache reads, cache writes and output separately", () => {
    expect(
      costUsd("claude-opus-5-5", {
        input: 0,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      })
    ).toBeCloseTo(25.2, 10);
  });

  it("knows every model the settings and the refusal fallbacks can use", () => {
    expect(Object.keys(MODEL_PRICES).sort()).toEqual([
      "claude-opus-4-8",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
    ]);
    const all = { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 };
    expect(costUsd("claude-opus-4-8", all)).toBeCloseTo(36.75, 10);
    expect(costUsd("claude-sonnet-5", all)).toBeCloseTo(14.7, 10);
    expect(costUsd("claude-sonnet-5-5", all)).toBeCloseTo(14.6, 10);
  });

  it("throws for a model without a price", () => {
    expect(() => costUsd("claude-nope", zero)).toThrow(UnknownModelPriceError);
    expect(() => costUsd("toString", zero)).toThrow(UnknownModelPriceError);
  });
});

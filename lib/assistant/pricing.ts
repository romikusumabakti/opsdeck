import type { Prices } from "./providers";

/** Tokens of one model response, split the way providers bill them. */
export type TokenUsage = {
  /** Input tokens not served from (or written to) the prompt cache. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

/**
 * A rough characters-per-token ratio for a response whose provider reported
 * no usage. It errs towards more tokens for code and non-English text, so the
 * daily cap is reached early rather than late.
 */
export const CHARS_PER_TOKEN = 3;

/** The cost in USD of `usage` at `prices` (USD per million tokens). */
export function costUsd(prices: Prices, usage: TokenUsage): number {
  return (
    (usage.input * prices.input +
      usage.cacheRead * prices.cacheRead +
      usage.cacheWrite * prices.cacheWrite +
      usage.output * prices.output) /
    1_000_000
  );
}

/** Token usage estimated from the characters sent and received. */
export function estimateUsage(
  inputChars: number,
  outputChars: number
): TokenUsage {
  const tokens = (chars: number) =>
    Math.max(0, Math.ceil(chars / CHARS_PER_TOKEN));
  return {
    input: tokens(inputChars),
    cacheRead: 0,
    cacheWrite: 0,
    output: tokens(outputChars),
  };
}

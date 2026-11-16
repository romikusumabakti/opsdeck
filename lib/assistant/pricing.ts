// USD per million tokens. One table, so a price change is a one-line edit.
// `cacheWrite` is the 5-minute cache write price. The fallback models
// (claude-opus-4-8, claude-sonnet-5) are here because a refused request is
// re-run on one of them and the response reports the model that served it.
export const MODEL_PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
  },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
} as const;

export type TokenUsage = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

export class UnknownModelPriceError extends Error {
  constructor(model: string) {
    super(`No price known for model "${model}"`);
    this.name = "UnknownModelPriceError";
  }
}

export function costUsd(model: string, usage: TokenUsage): number {
  const price = Object.hasOwn(MODEL_PRICES, model)
    ? MODEL_PRICES[model as keyof typeof MODEL_PRICES]
    : undefined;
  if (!price) throw new UnknownModelPriceError(model);
  return (
    (usage.input * price.input +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite * price.cacheWrite +
      usage.output * price.output) /
    1_000_000
  );
}

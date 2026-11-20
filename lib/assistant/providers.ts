import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";

export type { ProviderOptions };

export const ASSISTANT_EFFORTS = ["low", "medium", "high"] as const;
export type AssistantEffort = (typeof ASSISTANT_EFFORTS)[number];

export const PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openai-compatible",
] as const;
export type Provider = (typeof PROVIDERS)[number];

/** The provider picker's label, in the `assistantSettings` messages. */
export const PROVIDER_LABEL_KEYS = {
  anthropic: "providerAnthropic",
  openai: "providerOpenai",
  google: "providerGoogle",
  "openai-compatible": "providerOpenaiCompatible",
} as const satisfies Record<Provider, string>;

/** USD per million tokens. */
export type Prices = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type KnownModel = { provider: Provider; id: string; prices: Prices };

// Suggestions for the settings form, with list prices as of 2026-11-17 (the
// admin can edit the prices; the stored ones are what usage is charged at).
// Anthropic: `cacheWrite` is the 5-minute cache write. OpenAI: the 30-minute
// cache write, standard tier, prompts up to 272K tokens. Google: implicit
// caching only, no write charge, so a cache write costs an input token;
// gemini-4-carbon at the list price from 2026-12-01 (the lower introductory
// price ends 2026-11-30).
export const KNOWN_MODELS: KnownModel[] = [
  {
    provider: "anthropic",
    id: "claude-opus-5-5",
    prices: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-5-5",
    prices: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  },
  {
    provider: "openai",
    id: "gpt-6.1-sol",
    prices: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  },
  {
    provider: "openai",
    id: "gpt-6-luna",
    prices: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  },
  {
    provider: "google",
    id: "gemini-4-carbon",
    prices: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 4 },
  },
  {
    provider: "google",
    id: "gemini-4-hydrogen",
    prices: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 1.5 },
  },
];

export function suggestedModels(provider: Provider): KnownModel[] {
  return KNOWN_MODELS.filter((model) => model.provider === provider);
}

export type ProviderConfig = {
  provider: Provider;
  apiKey: string;
  /** Required for openai-compatible; overrides the endpoint for the others. */
  baseUrl: string | null;
  model: string;
};

/** Builds the model client. No network call happens until it is used. */
export function createLanguageModel(config: ProviderConfig): LanguageModel {
  const { apiKey, model } = config;
  const baseURL = config.baseUrl ?? undefined;
  switch (config.provider) {
    case "anthropic":
      return createAnthropic({ apiKey, baseURL })(model);
    case "openai":
      return createOpenAI({ apiKey, baseURL })(model);
    case "google":
      return createGoogle({ apiKey, baseURL })(model);
    case "openai-compatible":
      if (!baseURL)
        throw new Error("An OpenAI-compatible model needs a base URL");
      return createOpenAICompatible({
        name: "openai-compatible",
        apiKey,
        baseURL,
        includeUsage: true,
      })(model);
  }
}

/**
 * OpenAI's Responses API stores every generation unless told not to. With
 * `store: false` the SDK asks a known reasoning model for its encrypted
 * reasoning and replays it in the next tool step, so tool loops keep working
 * without anything kept at OpenAI.
 */
const OPENAI_NO_STORE = { store: false } as const;

/** Per-call options that turn on reasoning at the configured effort. */
export function providerOptionsFor(
  provider: Provider,
  effort: AssistantEffort
): ProviderOptions {
  switch (provider) {
    case "anthropic":
      return { anthropic: { thinking: { type: "adaptive" }, effort } };
    case "openai":
      return { openai: { reasoningEffort: effort, ...OPENAI_NO_STORE } };
    case "google":
      return { google: { thinkingConfig: { thinkingLevel: effort } } };
    case "openai-compatible":
      return {};
  }
}

/**
 * Message-level options that mark a prompt-cache breakpoint. Only Anthropic
 * needs one; the others cache prompt prefixes on their own.
 */
export function cacheControlFor(
  provider: Provider
): ProviderOptions | undefined {
  return provider === "anthropic"
    ? { anthropic: { cacheControl: { type: "ephemeral" } } }
    : undefined;
}

/**
 * The most tools one request may mark strict, or null when the provider sets
 * no such cap. Anthropic refuses a request with more than 20 ("Too many strict
 * tools (23). The maximum number of strict tools supported is 20.").
 */
export function strictToolLimitFor(provider: Provider): number | null {
  return provider === "anthropic" ? 20 : null;
}

/**
 * The output token limit sent with every request. Only Anthropic requires
 * one; the others default to the model's maximum, and a fixed one can exceed
 * what a smaller model accepts.
 */
export function outputTokenLimitFor(provider: Provider): number | undefined {
  return provider === "anthropic" ? 32_000 : undefined;
}

/**
 * The lowest reasoning, for the connection test's probes. None for Anthropic:
 * thinking conflicts with the forced tool choice. None for an
 * OpenAI-compatible endpoint.
 */
export function probeOptionsFor(
  provider: Provider
): ProviderOptions | undefined {
  switch (provider) {
    case "openai":
      return { openai: { reasoningEffort: "low", ...OPENAI_NO_STORE } };
    case "google":
      return { google: { thinkingConfig: { thinkingLevel: "low" } } };
    case "anthropic":
    case "openai-compatible":
      return undefined;
  }
}

/**
 * Whether the provider's models read images and PDFs sent as file parts. An
 * OpenAI-compatible endpoint may front any model, so it gets text instead
 * (lib/assistant/tools/uploads.ts).
 */
export function readsFilesNatively(provider: Provider): boolean {
  return provider !== "openai-compatible";
}

/**
 * The model the title is asked of: the provider's cheapest KNOWN_MODELS entry
 * when it is cheaper (input + output price) than the configured model, else
 * the configured model. As of the 2026-11-17 list:
 *
 *   anthropic          claude-opus-5-5   → claude-sonnet-5-5
 *   openai             gpt-6.1-sol       → gpt-6-luna
 *   google             gemini-4-carbon   → gemini-4-hydrogen
 *   openai-compatible  configured model (it may front any model)
 *
 * A custom endpoint (baseUrl set) keeps the configured model too: it may not
 * serve the sibling. A sibling is charged at its list prices, the configured
 * model at the stored ones.
 */
export function titleModelFor(config: {
  provider: Provider;
  modelId: string;
  prices: Prices;
  baseUrl: string | null;
}): { modelId: string; prices: Prices } {
  const configured = { modelId: config.modelId, prices: config.prices };
  if (config.provider === "openai-compatible" || config.baseUrl) {
    return configured;
  }
  const weight = (prices: Prices) => prices.input + prices.output;
  const cheapest = suggestedModels(config.provider).reduce<
    (typeof configured & { weight: number }) | null
  >((best, model) => {
    const w = weight(model.prices);
    return !best || w < best.weight
      ? { modelId: model.id, prices: model.prices, weight: w }
      : best;
  }, null);
  if (!cheapest || cheapest.weight >= weight(config.prices)) return configured;
  return { modelId: cheapest.modelId, prices: cheapest.prices };
}

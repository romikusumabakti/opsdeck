import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import type { AssistantEffort } from "@/lib/assistant/client";

export type { ProviderOptions };

export const PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openai-compatible",
] as const;
export type Provider = (typeof PROVIDERS)[number];

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

/** Per-call options that turn on reasoning at the configured effort. */
export function providerOptionsFor(
  provider: Provider,
  effort: AssistantEffort
): ProviderOptions {
  switch (provider) {
    case "anthropic":
      return { anthropic: { thinking: { type: "adaptive" }, effort } };
    case "openai":
      return { openai: { reasoningEffort: effort } };
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

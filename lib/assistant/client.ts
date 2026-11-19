import type { LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import {
  ASSISTANT_EFFORTS,
  type AssistantEffort,
  createLanguageModel,
  type Prices,
  type Provider,
} from "@/lib/assistant/providers";
import { db } from "@/lib/db";
import { instanceSettings } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/secrets";

export type AssistantRuntime = {
  model: LanguageModel;
  provider: Provider;
  modelId: string;
  effort: AssistantEffort;
  /** USD per million tokens, as configured. */
  prices: Prices;
  dailyCapUsd: number;
  /** Admin → Assistant organisation context; null = the generic one. */
  orgContext: string | null;
};

/** The stored assistant settings, the key decrypted; no model built yet. */
export type AssistantConfig = Omit<AssistantRuntime, "model"> & {
  apiKey: string;
  baseUrl: string | null;
};

/**
 * The configured provider, key, model, prices and limits, or null unless the
 * assistant is enabled and fully configured (provider, key, model, all four
 * prices, and a base URL for an OpenAI-compatible endpoint). Throws when the
 * key no longer decrypts.
 */
export async function loadAssistantConfig(): Promise<AssistantConfig | null> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  if (!row?.assistantEnabled) return null;
  const {
    assistantProvider: provider,
    assistantApiKey: apiKey,
    assistantModel: modelId,
    assistantBaseUrl: baseUrl,
  } = row;
  if (!provider || !apiKey || !modelId) return null;
  if (provider === "openai-compatible" && !baseUrl) return null;
  const prices = pricesOf(row);
  if (!prices) return null;
  return {
    provider,
    apiKey: decryptSecret(apiKey),
    baseUrl,
    modelId,
    effort: asEffort(row.assistantEffort),
    prices,
    dailyCapUsd: Number(row.assistantDailyCapUsd),
    orgContext: row.assistantOrgContext,
  };
}

/**
 * The configured model, prices and limits, or null unless the assistant is
 * enabled and fully configured (loadAssistantConfig). No permission check:
 * the worker calls it, and the caller has already authorized the turn.
 */
export async function loadAssistantRuntime(): Promise<AssistantRuntime | null> {
  const config = await loadAssistantConfig();
  if (!config) return null;
  const { apiKey, baseUrl, ...runtime } = config;
  return {
    ...runtime,
    model: createLanguageModel({
      provider: config.provider,
      apiKey,
      baseUrl,
      model: config.modelId,
    }),
  };
}

function asEffort(value: string): AssistantEffort {
  return (ASSISTANT_EFFORTS as readonly string[]).includes(value)
    ? (value as AssistantEffort)
    : "medium";
}

type PriceColumns = Pick<
  typeof instanceSettings.$inferSelect,
  | "assistantPriceInput"
  | "assistantPriceOutput"
  | "assistantPriceCacheRead"
  | "assistantPriceCacheWrite"
>;

/** The four stored prices, or null unless all are set. */
function pricesOf(row: PriceColumns): Prices | null {
  const input = row.assistantPriceInput;
  const output = row.assistantPriceOutput;
  const cacheRead = row.assistantPriceCacheRead;
  const cacheWrite = row.assistantPriceCacheWrite;
  if (
    input == null ||
    output == null ||
    cacheRead == null ||
    cacheWrite == null
  )
    return null;
  return {
    input: Number(input),
    output: Number(output),
    cacheRead: Number(cacheRead),
    cacheWrite: Number(cacheWrite),
  };
}

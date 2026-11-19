import { generateText, type LanguageModel } from "ai";
import { loadAssistantConfig } from "./client";
import {
  loadTitleInput,
  saveGeneratedTitle,
  TITLE_MAX_CHARS,
} from "./conversation-store";
import { estimateUsage } from "./pricing";
import {
  createLanguageModel,
  type Prices,
  type Provider,
  probeOptionsFor,
  suggestedModels,
} from "./providers";
import { reportedUsage } from "./run-turn";
import { recordUsage, spentTodayUsd } from "./usage";

/**
 * The auto title of a new chat (Stage 9 spec B.5): after the first answer is
 * done, one small request names the chat in at most six words, in the
 * question's language. Never for a temporary chat or one the user renamed
 * (conversation-store loadTitleInput / saveGeneratedTitle); a failure keeps
 * the title taken from the first question. Metered like every call.
 */

export const TITLE_MAX_WORDS = 6;

/** How much of the question and of the answer the request carries. */
const QUESTION_CHARS = 2000;
const ANSWER_CHARS = 1000;
const TITLE_TIMEOUT_MS = 30_000;

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

/**
 * The model's reply as a title: its first line, without a "Title:" label,
 * markdown, quotes or a final stop, at most TITLE_MAX_WORDS words and
 * TITLE_MAX_CHARS characters; null when nothing is left.
 */
export function cleanTitle(raw: string): string | null {
  const line =
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  const bare = line
    .replace(/^title\s*:\s*/i, "")
    .replace(/[*_`#]+/g, "")
    .replace(/^["'“”‘’«»「」『』]+|["'“”‘’«»「」『』]+$/gu, "")
    .trim()
    .replace(/[.!?。！？:;,，、]+$/u, "")
    .trim();
  const words = bare.split(/\s+/).filter(Boolean).slice(0, TITLE_MAX_WORDS);
  const title = Array.from(words.join(" "))
    .slice(0, TITLE_MAX_CHARS)
    .join("")
    .trim();
  return title === "" ? null : title;
}

export type TitleRuntime = {
  model: LanguageModel;
  provider: Provider;
  modelId: string;
  prices: Prices;
  dailyCapUsd: number;
};

/** The configured assistant with its title model; null when not usable. */
export async function loadTitleRuntime(): Promise<TitleRuntime | null> {
  const config = await loadAssistantConfig();
  if (!config) return null;
  const { modelId, prices } = titleModelFor(config);
  return {
    model: createLanguageModel({
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: modelId,
    }),
    provider: config.provider,
    modelId,
    prices,
    dailyCapUsd: config.dailyCapUsd,
  };
}

export type GenerateTitleDeps = {
  loadRuntime?: () => Promise<TitleRuntime | null>;
  now?: () => Date;
};

const INSTRUCTIONS = [
  "You name chat conversations.",
  `Reply with only a title of at most ${TITLE_MAX_WORDS} words that says what the conversation below is about.`,
  "Write it in the same language as the user's question.",
  "No quotes, no label, no final punctuation.",
].join(" ");

/**
 * Names the conversation from its first question and the start of its
 * answer. "skipped" when there is no title to make (temporary, renamed,
 * titled already, not the first answer, the assistant not usable, or the
 * day's cap spent), "failed" when the request failed or gave nothing usable
 * (the title stays), "generated" once saved. Never throws.
 */
export async function generateConversationTitle(
  conversationId: string,
  deps: GenerateTitleDeps = {}
): Promise<"generated" | "skipped" | "failed"> {
  const now = deps.now ?? (() => new Date());
  try {
    const input = await loadTitleInput(conversationId);
    if (!input) return "skipped";
    const runtime = await (deps.loadRuntime ?? loadTitleRuntime)();
    if (!runtime) return "skipped";
    if ((await spentTodayUsd(input.userId, now())) >= runtime.dailyCapUsd) {
      return "skipped";
    }

    const prompt = [
      "Question:",
      Array.from(input.question).slice(0, QUESTION_CHARS).join(""),
      "",
      "Answer (start):",
      Array.from(input.answer).slice(0, ANSWER_CHARS).join(""),
    ].join("\n");
    const result = await generateText({
      model: runtime.model,
      instructions: INSTRUCTIONS,
      prompt,
      // Room for a reasoning model to think a little before it answers, as
      // in the connection test (lowest reasoning, none for Anthropic).
      maxOutputTokens: 512,
      maxRetries: 0,
      providerOptions: probeOptionsFor(runtime.provider),
      abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
    });
    const reported = reportedUsage(result.usage);
    await recordUsage({
      messageId: null,
      userId: input.userId,
      modelId: runtime.modelId,
      prices: runtime.prices,
      usage:
        reported ??
        estimateUsage(INSTRUCTIONS.length + prompt.length, result.text.length),
      estimated: !reported,
      now: now(),
    });

    const title = cleanTitle(result.text);
    if (!title) return "failed";
    return (await saveGeneratedTitle(conversationId, title))
      ? "generated"
      : "skipped";
  } catch (error) {
    // The name only: provider text can echo request details.
    console.warn(
      `[assistant] no auto title for ${conversationId}: ${(error as Error)?.name ?? "unknown"}`
    );
    return "failed";
  }
}

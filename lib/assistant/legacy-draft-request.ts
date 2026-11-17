import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageParam,
  BetaOutputConfig,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  ASSISTANT_EFFORTS,
  type AssistantEffort,
  type LegacyDraftRuntime,
} from "./client";
import type { TokenUsage } from "./pricing";
import { type AssistantErrorCode, classifyError } from "./run-turn";

/**
 * Transitional: the one-shot Anthropic Messages request drafts still use,
 * moved here from the turn loop (without its tool options) when turns moved
 * to the AI SDK.
 * Deleted when drafts move to the AI SDK as well.
 */

const MAX_TOKENS = 32_000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The usage fields of one Messages API response that cost money. */
export type ResponseUsage = Pick<
  BetaUsage,
  | "input_tokens"
  | "output_tokens"
  | "cache_read_input_tokens"
  | "cache_creation_input_tokens"
> & { iterations?: BetaUsage["iterations"] };

/**
 * The billed tokens of one response. After a server-side refusal fallback the
 * top-level usage covers only the attempt that produced the message, while
 * `usage.iterations` lists every attempt (the declined one included), so
 * those are summed.
 */
export function legacyTokenUsage(usage: ResponseUsage): TokenUsage {
  const iterations = usage.iterations ?? [];
  if (iterations.some((i) => i.type === "fallback_message")) {
    const billed = iterations.filter(
      (i) => i.type === "message" || i.type === "fallback_message"
    );
    const sum = (pick: (i: (typeof billed)[number]) => number | null) =>
      billed.reduce((total, i) => total + (pick(i) ?? 0), 0);
    return {
      input: sum((i) => i.input_tokens),
      cacheRead: sum((i) => i.cache_read_input_tokens),
      cacheWrite: sum((i) => i.cache_creation_input_tokens),
      output: sum((i) => i.output_tokens),
    };
  }
  return {
    input: usage.input_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    output: usage.output_tokens,
  };
}

/** Anthropic SDK errors first, then the turn loop's mapping. */
export function classifyLegacyDraftError(error: unknown): AssistantErrorCode {
  // Connection failures and timeouts are APIError subclasses without a status.
  if (error instanceof Anthropic.APIConnectionError) {
    return "assistant.unavailable";
  }
  if (error instanceof Anthropic.APIError) {
    const message = `${error.apiMessage ?? ""} ${error.message}`;
    if (
      error.type === "billing_error" ||
      error.status === 402 ||
      ((error.status === 400 || error.type === "invalid_request_error") &&
        /credit balance/i.test(message))
    ) {
      return "assistant.credit_exhausted";
    }
    if (
      error.status === 401 ||
      error.status === 403 ||
      error.type === "authentication_error" ||
      error.type === "permission_error"
    ) {
      return "assistant.not_configured";
    }
    if (
      error.status === 429 ||
      (error.status !== undefined && error.status >= 500) ||
      error.type === "rate_limit_error" ||
      error.type === "overloaded_error" ||
      error.type === "api_error" ||
      error.type === "timeout_error"
    ) {
      return "assistant.unavailable";
    }
    return "assistant.failed";
  }
  return classifyError(error);
}

function effortOf(
  runtime: LegacyDraftRuntime
): BetaOutputConfig["effort"] | undefined {
  if ((ASSISTANT_EFFORTS as readonly string[]).includes(runtime.effort)) {
    return runtime.effort as AssistantEffort;
  }
  console.warn(
    `[assistant] unknown effort ${runtime.effort}; using the model default`
  );
  return undefined;
}

export type RequestBody = {
  system: Array<{
    type: "text";
    text: string;
    cache_control?: { type: "ephemeral" };
  }>;
  /** Structured output (`output_config.format`), parsed by the caller. */
  format?: BetaJSONOutputFormat;
  messages: BetaMessageParam[];
};

/**
 * One streamed Messages request with the assistant's fixed settings (model,
 * effort, refusal fallback, adaptive thinking, max_tokens). If the stream
 * fails, the usage it reported so far is metered before the error is
 * rethrown (those tokens are billed).
 */
export async function streamRequest(
  runtime: LegacyDraftRuntime,
  body: RequestBody,
  meter: (model: string, usage: ResponseUsage) => Promise<number>
): Promise<BetaMessage> {
  const effort = effortOf(runtime);
  const outputConfig = {
    ...(effort ? { effort } : {}),
    ...(body.format ? { format: body.format } : {}),
  };
  const stream = runtime.client.beta.messages.stream({
    model: runtime.model,
    max_tokens: MAX_TOKENS,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    ...(Object.keys(outputConfig).length > 0
      ? { output_config: outputConfig }
      : {}),
    system: body.system,
    messages: [...body.messages],
  });
  try {
    for await (const _event of stream) {
      // Drafts are not streamed to the user; only the final message counts.
    }
    return await stream.finalMessage();
  } catch (error) {
    const partial = stream.currentMessage;
    if (partial?.usage) {
      await meter(partial.model, partial.usage).catch((meterError) => {
        console.error("[assistant] failed to record partial usage", meterError);
      });
    }
    throw error;
  }
}

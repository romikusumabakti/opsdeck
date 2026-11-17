import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { instanceSettings } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/secrets";

export const ASSISTANT_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
] as const;
export const ASSISTANT_EFFORTS = ["low", "medium", "high"] as const;

export type AssistantModel = (typeof ASSISTANT_MODELS)[number];
export type AssistantEffort = (typeof ASSISTANT_EFFORTS)[number];

export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

export type AssistantRuntime = {
  client: Anthropic;
  model: string;
  effort: string;
  dailyCapUsd: number;
  /** Admin → Assistant organisation context; null = the generic one. */
  orgContext: string | null;
};

/**
 * The configured client and limits, or null when the assistant is disabled or
 * has no key. No permission check: the worker calls it, and the caller has
 * already authorized the turn.
 */
export async function loadAssistantRuntime(): Promise<AssistantRuntime | null> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  if (!row?.assistantEnabled || !row.anthropicApiKey) return null;
  return {
    client: createAnthropicClient(decryptSecret(row.anthropicApiKey)),
    model: row.assistantModel,
    effort: row.assistantEffort,
    dailyCapUsd: Number(row.assistantDailyCapUsd),
    orgContext: row.assistantOrgContext,
  };
}

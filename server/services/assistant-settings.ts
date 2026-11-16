import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import {
  ASSISTANT_EFFORTS,
  ASSISTANT_MODELS,
  type AssistantEffort,
  type AssistantModel,
  createAnthropicClient,
} from "@/lib/assistant/client";
import { requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { instanceSettings } from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import type { ActionResponse } from "@/lib/types";

/**
 * Admin settings of the code assistant. The Anthropic API key is write-only:
 * stored encrypted, reduced to `hasApiKey` on read, never returned or logged.
 * Every exported function checks org assistant:manage itself.
 */
export type AssistantSettings = {
  enabled: boolean;
  hasApiKey: boolean;
  model: AssistantModel;
  effort: AssistantEffort;
  dailyCapUsd: number;
};

// Omitted fields stay as they are; `apiKey: null` clears the key; a blank key
// keeps the stored one.
export const assistantSettingsInputSchema = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.string().trim().max(2048).nullable().optional(),
  model: z.enum(ASSISTANT_MODELS).optional(),
  effort: z.enum(ASSISTANT_EFFORTS).optional(),
  dailyCapUsd: z.number().min(0).max(1000).optional(),
});

export type AssistantSettingsInput = z.infer<
  typeof assistantSettingsInputSchema
>;

async function loadRow() {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  if (!row) throw new Error("instance_settings row 1 is missing");
  return row;
}

export async function getAssistantSettings(): Promise<AssistantSettings> {
  await requireOrgPermission({ assistant: ["manage"] });
  const row = await loadRow();
  return {
    enabled: row.assistantEnabled,
    hasApiKey: !!row.anthropicApiKey,
    model: row.assistantModel as AssistantModel,
    effort: row.assistantEffort as AssistantEffort,
    dailyCapUsd: Number(row.assistantDailyCapUsd),
  };
}

export async function saveAssistantSettings(
  input: AssistantSettingsInput
): Promise<ActionResponse> {
  const session = await requireOrgPermission({ assistant: ["manage"] });
  const parsed = assistantSettingsInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, message: "Invalid assistant settings" };
  }
  const { enabled, apiKey, model, effort, dailyCapUsd } = parsed.data;
  const patch: Partial<typeof instanceSettings.$inferInsert> = {};
  if (enabled !== undefined) patch.assistantEnabled = enabled;
  if (model !== undefined) patch.assistantModel = model;
  if (effort !== undefined) patch.assistantEffort = effort;
  if (dailyCapUsd !== undefined) {
    patch.assistantDailyCapUsd = dailyCapUsd.toFixed(2);
  }
  if (apiKey === null) patch.anthropicApiKey = null;
  else if (apiKey) patch.anthropicApiKey = encryptSecret(apiKey);

  if (Object.keys(patch).length > 0) {
    try {
      await db
        .update(instanceSettings)
        .set(patch)
        .where(eq(instanceSettings.id, 1));
    } catch (error) {
      console.error("Failed to save assistant settings:", error);
      return { success: false, message: "Failed to save assistant settings" };
    }
    const row = await loadRow();
    // No key material here: only whether the key changed.
    await recordActivity({
      actorId: session.user.id,
      action: "assistant.configured",
      entityType: "instance",
      data: {
        enabled: String(row.assistantEnabled),
        model: row.assistantModel,
        effort: row.assistantEffort,
        dailyCapUsd: Number(row.assistantDailyCapUsd),
        keyChanged: String(apiKey !== undefined && apiKey !== ""),
      },
    });
  }
  return { success: true, message: "Assistant settings saved" };
}

/** One `models.retrieve` call with the stored key and model. */
export async function testAssistantConnection(): Promise<ActionResponse> {
  await requireOrgPermission({ assistant: ["manage"] });
  const row = await loadRow();
  if (!row.anthropicApiKey) {
    return { success: false, message: "Save an API key first" };
  }
  try {
    const client = createAnthropicClient(decryptSecret(row.anthropicApiKey));
    await client.models.retrieve(row.assistantModel);
    return { success: true, message: "Connection works" };
  } catch (error) {
    // The SDK's message carries the API's error text, never the key.
    const status =
      typeof error === "object" && error && "status" in error
        ? ` (HTTP ${String(error.status)})`
        : "";
    return { success: false, message: `Connection failed${status}` };
  }
}

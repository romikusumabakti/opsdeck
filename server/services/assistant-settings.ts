import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import {
  ASSISTANT_EFFORTS,
  ASSISTANT_MODELS,
  type AssistantEffort,
  type AssistantModel,
  createAnthropicClient,
} from "@/lib/assistant/client";
import { quotaDay } from "@/lib/assistant/usage";
import { requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { assistantUsage, instanceSettings, users } from "@/lib/db/schema";
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

const MAX_USAGE_DAYS = 92;
const DAY_MS = 86_400_000;
const isoDay = z.iso.date();

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

// Days are APP_TIMEZONE calendar dates, like assistant_usage.day. Default: the
// last 30 days up to today; at most 92 days.
export const assistantUsageQuerySchema = z
  .object({ from: isoDay.optional(), to: isoDay.optional() })
  .transform(({ from, to }, ctx) => {
    const end = to ?? quotaDay();
    const start =
      from ?? quotaDay(new Date(Date.parse(`${end}T12:00:00Z`) - 29 * DAY_MS));
    const span = dayNumber(end) - dayNumber(start);
    if (span < 0 || span >= MAX_USAGE_DAYS) {
      ctx.addIssue({
        code: "custom",
        message: `Range must be 1 to ${MAX_USAGE_DAYS} days`,
      });
      return z.NEVER;
    }
    return { from: start, to: end };
  });

export type AssistantUsageQuery = z.input<typeof assistantUsageQuerySchema>;

export type AssistantUsage = {
  /** One row per day and user. `turns` = distinct assistant answers with
   * usage; `drafts` = usage rows of Jira draft generations (no message). */
  rows: {
    day: string;
    userId: string;
    userName: string;
    turns: number;
    drafts: number;
    costUsd: number;
  }[];
  totalUsd: number;
  monthToDateUsd: number;
};

export async function getAssistantUsage(
  input: AssistantUsageQuery
): Promise<AssistantUsage> {
  await requireOrgPermission({ assistant: ["manage"] });
  const { from, to } = assistantUsageQuerySchema.parse(input);
  const rows = await db
    .select({
      day: assistantUsage.day,
      userId: assistantUsage.userId,
      userName: users.name,
      turns: sql<number>`count(distinct ${assistantUsage.messageId})::int`,
      drafts: sql<number>`(count(*) filter (where ${assistantUsage.messageId} is null))::int`,
      costUsd: sql<string>`sum(${assistantUsage.costUsd})`,
    })
    .from(assistantUsage)
    .innerJoin(users, eq(users.id, assistantUsage.userId))
    .where(and(gte(assistantUsage.day, from), lte(assistantUsage.day, to)))
    .groupBy(assistantUsage.day, assistantUsage.userId, users.name)
    .orderBy(desc(assistantUsage.day), asc(users.name));

  const today = quotaDay();
  const [month] = await db
    .select({
      total: sql<string>`coalesce(sum(${assistantUsage.costUsd}), 0)`,
    })
    .from(assistantUsage)
    .where(
      and(
        gte(assistantUsage.day, `${today.slice(0, 8)}01`),
        lte(assistantUsage.day, today)
      )
    );

  const mapped = rows.map((r) => ({
    day: r.day,
    userId: r.userId,
    userName: r.userName,
    turns: r.turns,
    drafts: r.drafts,
    costUsd: Number(r.costUsd),
  }));
  return {
    rows: mapped,
    totalUsd: Number(mapped.reduce((sum, r) => sum + r.costUsd, 0).toFixed(6)),
    monthToDateUsd: Number(month?.total ?? 0),
  };
}

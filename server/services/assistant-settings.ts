import {
  APICallError,
  generateText,
  LoadAPIKeyError,
  NoSuchModelError,
  Output,
  RetryError,
  tool,
} from "ai";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import {
  ASSISTANT_EFFORTS,
  type AssistantEffort,
  createLanguageModel,
  PROVIDERS,
  type Prices,
  type Provider,
  probeOptionsFor,
} from "@/lib/assistant/providers";
import { quotaDay } from "@/lib/assistant/usage";
import { requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { assistantUsage, instanceSettings, users } from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import type { ActionResponse } from "@/lib/types";
import { CodedHTTPException } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";

/**
 * Admin settings of the code assistant: provider, API key, base URL, model,
 * prices and limits. The API key is write-only: stored encrypted, reduced to
 * `hasApiKey` on read, never returned or logged. Every exported function
 * checks org assistant:manage itself.
 */
export type AssistantSettings = {
  enabled: boolean;
  provider: Provider | null;
  hasApiKey: boolean;
  /** Required for openai-compatible; an endpoint override for the others. */
  baseUrl: string | null;
  model: string | null;
  effort: AssistantEffort;
  /** USD per million tokens; null until all four are set. */
  prices: Prices | null;
  dailyCapUsd: number;
  /** What the assistant is told about the organisation; null = generic. */
  orgContext: string | null;
};

/** Longest organisation context the prompt takes, in characters. */
export const ORG_CONTEXT_MAX = 4000;

const price = z.number().min(0).max(1000);

// Omitted fields stay as they are; `apiKey: null` clears the key; a blank key
// keeps the stored one. A blank or null orgContext clears it. Prices go
// together, all four at once.
export const assistantSettingsInputSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(PROVIDERS).optional(),
  apiKey: z.string().trim().max(2048).nullable().optional(),
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .nullable()
    .optional(),
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.enum(ASSISTANT_EFFORTS).optional(),
  prices: z
    .object({
      input: price,
      output: price,
      cacheRead: price,
      cacheWrite: price,
    })
    .optional(),
  dailyCapUsd: z.number().min(0).max(1000).optional(),
  orgContext: z.string().trim().max(ORG_CONTEXT_MAX).nullable().optional(),
});

export type AssistantSettingsInput = z.infer<
  typeof assistantSettingsInputSchema
>;

type SettingsRow = typeof instanceSettings.$inferSelect;

async function loadRow(): Promise<SettingsRow> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  if (!row) throw new Error("instance_settings row 1 is missing");
  return row;
}

function storedPrices(row: SettingsRow): Prices | null {
  const {
    assistantPriceInput: input,
    assistantPriceOutput: output,
    assistantPriceCacheRead: cacheRead,
    assistantPriceCacheWrite: cacheWrite,
  } = row;
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

async function incompleteSettings(): Promise<CodedHTTPException> {
  const t = await getServerTranslator("assistantSettings");
  return new CodedHTTPException(
    400,
    "assistant.incomplete_settings",
    t("incompleteSettings")
  );
}

export async function getAssistantSettings(): Promise<AssistantSettings> {
  await requireOrgPermission({ assistant: ["manage"] });
  const row = await loadRow();
  return {
    enabled: row.assistantEnabled,
    provider: row.assistantProvider,
    hasApiKey: !!row.assistantApiKey,
    baseUrl: row.assistantBaseUrl,
    model: row.assistantModel,
    effort: row.assistantEffort as AssistantEffort,
    prices: storedPrices(row),
    dailyCapUsd: Number(row.assistantDailyCapUsd),
    orgContext: row.assistantOrgContext,
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
  const {
    enabled,
    provider,
    apiKey,
    baseUrl,
    model,
    effort,
    prices,
    dailyCapUsd,
    orgContext,
  } = parsed.data;
  const before = await loadRow();
  const patch: Partial<typeof instanceSettings.$inferInsert> = {};
  if (enabled !== undefined) patch.assistantEnabled = enabled;
  if (provider !== undefined && provider !== before.assistantProvider) {
    patch.assistantProvider = provider;
    // A base URL and a key belong to their provider: never send one vendor's
    // key to another, or the new key to the old endpoint.
    patch.assistantBaseUrl = null;
    if (before.assistantProvider !== null) patch.assistantApiKey = null;
  }
  if (baseUrl !== undefined) patch.assistantBaseUrl = baseUrl;
  if (model !== undefined) patch.assistantModel = model;
  if (effort !== undefined) patch.assistantEffort = effort;
  if (prices !== undefined) {
    patch.assistantPriceInput = prices.input.toFixed(6);
    patch.assistantPriceOutput = prices.output.toFixed(6);
    patch.assistantPriceCacheRead = prices.cacheRead.toFixed(6);
    patch.assistantPriceCacheWrite = prices.cacheWrite.toFixed(6);
  }
  if (dailyCapUsd !== undefined) {
    patch.assistantDailyCapUsd = dailyCapUsd.toFixed(2);
  }
  if (apiKey === null) patch.assistantApiKey = null;
  else if (apiKey) patch.assistantApiKey = encryptSecret(apiKey);
  if (orgContext !== undefined) patch.assistantOrgContext = orgContext || null;

  if (Object.keys(patch).length === 0) {
    return { success: true, message: "Assistant settings saved" };
  }
  const next = { ...before, ...patch } as SettingsRow;
  const incomplete =
    (next.assistantProvider === "openai-compatible" &&
      !next.assistantBaseUrl) ||
    (next.assistantEnabled &&
      (!next.assistantProvider ||
        !next.assistantApiKey ||
        !next.assistantModel ||
        !storedPrices(next)));
  if (incomplete) throw await incompleteSettings();

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
  const changed = (a: unknown, b: unknown) => String(a !== b);
  const priceKey = (r: SettingsRow) => JSON.stringify(storedPrices(r));
  // Which fields changed, never the key, base URL, prices or context text.
  await recordActivity({
    actorId: session.user.id,
    action: "assistant.configured",
    entityType: "instance",
    data: {
      enabled: String(row.assistantEnabled),
      model: row.assistantModel ?? "",
      effort: row.assistantEffort,
      dailyCapUsd: Number(row.assistantDailyCapUsd),
      providerChanged: changed(before.assistantProvider, row.assistantProvider),
      // Encryption is randomised, so a newly saved key always differs.
      keyChanged: changed(before.assistantApiKey, row.assistantApiKey),
      baseUrlChanged: changed(before.assistantBaseUrl, row.assistantBaseUrl),
      modelChanged: changed(before.assistantModel, row.assistantModel),
      pricesChanged: changed(priceKey(before), priceKey(row)),
      orgContextChanged: changed(
        before.assistantOrgContext,
        row.assistantOrgContext
      ),
    },
  });
  return { success: true, message: "Assistant settings saved" };
}

/** What "Test connection" found; `error` is the class of the first failure. */
export type ConnectionTest = {
  ok: boolean;
  tools: boolean;
  structuredOutput: boolean;
  error?: "auth" | "quota" | "unreachable" | "model_not_found" | "failed";
};

type ConnectionError = NonNullable<ConnectionTest["error"]>;

const TEST_TIMEOUT_MS = 30_000;

/**
 * The class of a failed probe. Only the status and, for a credit refusal sent
 * as a 400, the body's wording are read; nothing of the provider's message
 * (which may echo the key) leaves this function.
 */
function connectionError(error: unknown): ConnectionError {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode;
    if (status === undefined) return "unreachable";
    if (status === 401 || status === 403) return "auth";
    if (status === 402 || status === 429) return "quota";
    if (status === 404) return "model_not_found";
    const body = cause.responseBody ?? "";
    if (status === 400 && /credit balance|billing|quota/i.test(body))
      return "quota";
    // Google answers an invalid key with a 400.
    if (status === 400 && /api[_ ]?key/i.test(body)) return "auth";
    return "failed";
  }
  if (LoadAPIKeyError.isInstance(cause)) return "auth";
  if (NoSuchModelError.isInstance(cause)) return "model_not_found";
  if (
    cause instanceof Error &&
    (cause.name === "TimeoutError" || cause.name === "AbortError")
  )
    return "unreachable";
  return "failed";
}

/** true, or the failure's class. */
async function probe(
  run: () => Promise<boolean>
): Promise<true | ConnectionError> {
  try {
    return (await run()) || "failed";
  } catch (error) {
    return connectionError(error);
  }
}

const okSchema = z.object({ ok: z.boolean() });

/**
 * Two tiny calls with the stored settings: one forcing a `ping` tool call, one
 * structured (JSON) answer, each capped at 512 output tokens at the lowest
 * reasoning. A failure that says the provider can't be used at all (auth,
 * quota, unreachable, unknown model) ends the test; any other failure only
 * marks that capability missing.
 */
export async function testAssistantConnection(
  deps: { createModel?: typeof createLanguageModel } = {}
): Promise<ConnectionTest> {
  await requireOrgPermission({ assistant: ["manage"] });
  const row = await loadRow();
  const {
    assistantProvider: provider,
    assistantApiKey: apiKey,
    assistantModel: modelId,
    assistantBaseUrl: baseUrl,
  } = row;
  if (
    !provider ||
    !apiKey ||
    !modelId ||
    (provider === "openai-compatible" && !baseUrl)
  )
    throw await incompleteSettings();

  const failed = (error: ConnectionError, tools = false): ConnectionTest => ({
    ok: false,
    tools,
    structuredOutput: false,
    error,
  });
  let model: ReturnType<typeof createLanguageModel>;
  try {
    model = (deps.createModel ?? createLanguageModel)({
      provider,
      apiKey: decryptSecret(apiKey),
      baseUrl,
      model: modelId,
    });
  } catch {
    return failed("failed");
  }
  const common = {
    model,
    // Room for a reasoning model to think a little before it answers.
    maxOutputTokens: 512,
    maxRetries: 0,
    providerOptions: probeOptionsFor(provider),
  } as const;

  const tools = await probe(async () => {
    const result = await generateText({
      ...common,
      abortSignal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      prompt: "Call the ping tool with ok set to true.",
      tools: {
        ping: tool({
          description: "Connection check. Call it with ok set to true.",
          inputSchema: okSchema,
        }),
      },
      toolChoice: { type: "tool", toolName: "ping" },
    });
    return result.toolCalls.some((call) => call.toolName === "ping");
  });
  if (tools !== true && tools !== "failed") return failed(tools);

  const structured = await probe(async () => {
    const result = await generateText({
      ...common,
      abortSignal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      prompt: 'Answer with the JSON object {"ok": true}.',
      output: Output.object({ schema: okSchema }),
    });
    return typeof result.output.ok === "boolean";
  });
  if (structured !== true && structured !== "failed") {
    return failed(structured, tools === true);
  }
  if (tools !== true && structured !== true) return failed("failed");
  return {
    ok: true,
    tools: tools === true,
    structuredOutput: structured === true,
  };
}

const MAX_USAGE_DAYS = 92;
const DAY_MS = 86_400_000;
const isoDay = z.iso.date();

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

// Days are APP_TIMEZONE calendar dates, like assistant_usage.day. Default: the
// last 30 days up to today; at most 92 days.
const usageRangeSchema = z.object({
  from: isoDay.optional(),
  to: isoDay.optional(),
});

function resolveRange(
  { from, to }: z.infer<typeof usageRangeSchema>,
  now: Date,
  ctx: z.RefinementCtx
) {
  {
    const end = to ?? quotaDay(now);
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
  }
}

export const assistantUsageQuerySchema = usageRangeSchema.transform(
  (range, ctx) => resolveRange(range, new Date(), ctx)
);

function parseUsageQuery(input: AssistantUsageQuery, now: Date) {
  return usageRangeSchema
    .transform((range, ctx) => resolveRange(range, now, ctx))
    .parse(input);
}

export type AssistantUsageQuery = z.input<typeof assistantUsageQuerySchema>;

export type AssistantUsage = {
  /** One row per day and user. `turns` = distinct assistant answers with
   * usage. */
  rows: {
    day: string;
    userId: string;
    userName: string;
    turns: number;
    costUsd: number;
  }[];
  totalUsd: number;
  monthToDateUsd: number;
  /** Usage rows in the range whose tokens were estimated (no usage reported). */
  estimatedRows: number;
};

export async function getAssistantUsage(
  input: AssistantUsageQuery,
  now: Date = new Date()
): Promise<AssistantUsage> {
  await requireOrgPermission({ assistant: ["manage"] });
  const { from, to } = parseUsageQuery(input, now);
  const rows = await db
    .select({
      day: assistantUsage.day,
      userId: assistantUsage.userId,
      userName: users.name,
      turns: sql<number>`count(distinct ${assistantUsage.messageId})::int`,
      costUsd: sql<string>`sum(${assistantUsage.costUsd})`,
      estimated: sql<number>`(count(*) filter (where ${assistantUsage.estimated}))::int`,
    })
    .from(assistantUsage)
    // Turns of deleted conversations are not counted (their message id is
    // nulled), though their cost still is.
    .innerJoin(users, eq(users.id, assistantUsage.userId))
    .where(and(gte(assistantUsage.day, from), lte(assistantUsage.day, to)))
    .groupBy(assistantUsage.day, assistantUsage.userId, users.name)
    .orderBy(desc(assistantUsage.day), asc(users.name));

  const today = quotaDay(now);
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
    costUsd: Number(r.costUsd),
  }));
  return {
    rows: mapped,
    totalUsd: Number(mapped.reduce((sum, r) => sum + r.costUsd, 0).toFixed(6)),
    monthToDateUsd: Number(month?.total ?? 0),
    estimatedRows: rows.reduce((sum, r) => sum + Number(r.estimated ?? 0), 0),
  };
}

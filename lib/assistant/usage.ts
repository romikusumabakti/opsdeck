import type { BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { assistantUsage } from "@/lib/db/schema";
import { APP_TIMEZONE } from "@/lib/timezone";
import { costUsd, type TokenUsage, UnknownModelPriceError } from "./pricing";

/** The usage fields of one Messages API response that cost money. */
export type ResponseUsage = Pick<
  BetaUsage,
  | "input_tokens"
  | "output_tokens"
  | "cache_read_input_tokens"
  | "cache_creation_input_tokens"
> & { iterations?: BetaUsage["iterations"] };

/** The quota day (YYYY-MM-DD) `now` falls on in APP_TIMEZONE. */
export function quotaDay(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** How far APP_TIMEZONE's wall clock is ahead of UTC at `at`, in ms. */
function zoneOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second")
  );
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** When the quota day `now` falls on ends: the next APP_TIMEZONE midnight. */
export function quotaDayResetsAt(now: Date = new Date()): Date {
  const [year, month, day] = quotaDay(now).split("-").map(Number);
  const midnightAsUtc = Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1);
  // The offset at that instant, corrected once for a DST change on the way.
  let at = midnightAsUtc - zoneOffsetMs(new Date(midnightAsUtc));
  at = midnightAsUtc - zoneOffsetMs(new Date(at));
  return new Date(at);
}

type PricedAttempt = { model: string; tokens: TokenUsage };

/**
 * The billed attempts of one response. Normally the top-level usage. After a
 * server-side refusal fallback the top-level usage covers only the attempt that
 * produced the message, while `usage.iterations` lists every attempt (the
 * declined one included) with the model that ran it, so those are priced
 * one by one.
 */
function attemptsOf(model: string, usage: ResponseUsage): PricedAttempt[] {
  const iterations = usage.iterations ?? [];
  if (iterations.some((i) => i.type === "fallback_message")) {
    return iterations.flatMap((i) =>
      i.type === "message" || i.type === "fallback_message"
        ? [
            {
              model: i.model ?? model,
              tokens: {
                input: i.input_tokens,
                cacheRead: i.cache_read_input_tokens,
                cacheWrite: i.cache_creation_input_tokens,
                output: i.output_tokens,
              },
            },
          ]
        : []
    );
  }
  return [
    {
      model,
      tokens: {
        input: usage.input_tokens,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        output: usage.output_tokens,
      },
    },
  ];
}

function priceAttempt(attempt: PricedAttempt, priceModel?: string): number {
  try {
    return costUsd(attempt.model, attempt.tokens);
  } catch (error) {
    if (!(error instanceof UnknownModelPriceError) || !priceModel) throw error;
    // A model missing from the price table (a new fallback target) must not
    // lose the row or the cap; price it like the configured model and say so.
    console.warn(
      `[assistant] no price for model ${attempt.model}; using ${priceModel} prices`
    );
    return costUsd(priceModel, attempt.tokens);
  }
}

/**
 * Records one API response's usage and returns its cost in USD.
 * `model` is the model the response reports (a fallback may have switched it);
 * `priceModel` is the configured model, whose prices are used for any model
 * the price table does not know.
 */
export async function recordUsage(params: {
  messageId: string | null;
  userId: string;
  model: string;
  usage: ResponseUsage;
  priceModel?: string;
  now?: Date;
}): Promise<number> {
  const attempts = attemptsOf(params.model, params.usage);
  const cost = attempts.reduce(
    (sum, a) => sum + priceAttempt(a, params.priceModel),
    0
  );
  const total = (key: keyof TokenUsage) =>
    attempts.reduce((sum, a) => sum + a.tokens[key], 0);
  await db.insert(assistantUsage).values({
    messageId: params.messageId,
    userId: params.userId,
    model: params.model,
    inputTokens: total("input"),
    cacheReadTokens: total("cacheRead"),
    cacheWriteTokens: total("cacheWrite"),
    outputTokens: total("output"),
    costUsd: cost.toFixed(6),
    day: quotaDay(params.now),
  });
  return cost;
}

/** What the user has spent on the assistant on the current APP_TIMEZONE day. */
export async function spentTodayUsd(
  userId: string,
  now: Date = new Date()
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${assistantUsage.costUsd}), 0)`,
    })
    .from(assistantUsage)
    .where(
      and(
        eq(assistantUsage.userId, userId),
        eq(assistantUsage.day, quotaDay(now))
      )
    );
  return Number(row?.total ?? 0);
}

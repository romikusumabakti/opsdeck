import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { assistantUsage } from "@/lib/db/schema";
import { APP_TIMEZONE } from "@/lib/timezone";
import { costUsd, type TokenUsage } from "./pricing";
import type { Prices } from "./providers";

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

/**
 * Records one model response's usage, priced at the configured `prices`, and
 * returns its cost in USD. `estimated` marks tokens estimated because the
 * provider reported none.
 */
export async function recordUsage(params: {
  messageId: string | null;
  userId: string;
  /** The model that served the response. */
  modelId: string;
  prices: Prices;
  usage: TokenUsage;
  estimated: boolean;
  now?: Date;
}): Promise<number> {
  const cost = costUsd(params.prices, params.usage);
  await db.insert(assistantUsage).values({
    messageId: params.messageId,
    userId: params.userId,
    model: params.modelId,
    inputTokens: params.usage.input,
    cacheReadTokens: params.usage.cacheRead,
    cacheWriteTokens: params.usage.cacheWrite,
    outputTokens: params.usage.output,
    costUsd: cost.toFixed(6),
    estimated: params.estimated,
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

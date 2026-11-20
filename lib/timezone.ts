import { isValidTimeZone } from "@/lib/iana-time-zone";

export { isValidTimeZone };

export const APP_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Jakarta";

/** The zone a user reads dates in: their own if set and valid, else the app's. */
export function effectiveTimeZone(
  user: { timezone?: string | null } | null | undefined
): string {
  const tz = user?.timezone;
  return tz && isValidTimeZone(tz) ? tz : APP_TIMEZONE;
}

/** How far `timeZone`'s wall clock is ahead of UTC at `at`, in ms. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
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

/**
 * The UTC instant of local midnight starting `ymd` (YYYY-MM-DD) in
 * `timeZone`. The offset is corrected a second time so a DST change between
 * the guess and the real instant does not shift the result.
 */
export function zonedDayStart(ymd: string, timeZone: string): Date {
  const [year, month, day] = ymd.split("-").map(Number);
  const midnightAsUtc = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
  let at = midnightAsUtc - zoneOffsetMs(new Date(midnightAsUtc), timeZone);
  at = midnightAsUtc - zoneOffsetMs(new Date(at), timeZone);
  return new Date(at);
}

/** The calendar date (YYYY-MM-DD) `now` falls on in `timeZone`. */
export function zonedToday(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

import { isValidTimeZone } from "@/lib/iana-time-zone";

export { isValidTimeZone };

export const APP_TIMEZONE = process.env.APP_TIMEZONE ?? "Asia/Jakarta";

/** The zone a user reads dates in: their own if set and valid, else the app's. */
export function effectiveTimeZone(
  user: { timezone?: string | null } | null | undefined
): string {
  const tz = user?.timezone;
  return tz && isValidTimeZone(tz) ? tz : APP_TIMEZONE;
}

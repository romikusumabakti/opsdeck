export const APP_TIMEZONE = process.env.APP_TIMEZONE ?? "Asia/Jakarta";

// IANA names only. Recent engines also accept UTC offsets ("+07:00") as a
// timeZone, which have no DST rules and no name to show, so they are refused.
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

export function isValidTimeZone(value: string): boolean {
  if (!IANA_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The zone a user reads dates in: their own if set and valid, else the app's. */
export function effectiveTimeZone(
  user: { timezone?: string | null } | null | undefined
): string {
  const tz = user?.timezone;
  return tz && isValidTimeZone(tz) ? tz : APP_TIMEZONE;
}

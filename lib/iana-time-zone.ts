// Client-safe: no env reads. The app's own zone (APP_TIMEZONE) is server
// config in lib/timezone.ts; the SPA gets it from `/api/bootstrap`.

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

import type { DateTimeFormatOptions } from "use-intl";

// The one set of absolute date formats. Pass to use-intl's
// `useFormatter().dateTime(date, DATE_TIME)`; the time zone comes from the
// IntlProvider, so every surface renders in the reader's zone.
export const DATE_TIME: DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "short",
};
export const DATE_ONLY: DateTimeFormatOptions = { dateStyle: "medium" };
export const DATE_TIME_SECONDS: DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "medium",
};

// Wall-clock values built with Date#setHours (a date-picker selection) live in
// the browser's zone, so they must be formatted there, not in the app zone.
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

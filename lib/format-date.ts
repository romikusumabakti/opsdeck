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

// Fixed-shape, en-US instant for audit text (run descriptions): always
// `yyyy-MM-dd HH:mm <zone>`, independent of the reader's locale. Pure Intl, so
// it is safe to import from both server and client code.
export function formatAuditInstant(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${part("timeZoneName")}`;
}

// Wall-clock values built with Date#setHours (a date-picker selection) live in
// the browser's zone, so they must be formatted there, not in the app zone.
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

import { useFormatter, useNow } from "use-intl";
import { DATE_TIME } from "@/lib/format-date";

// How often relative labels ("5 minutes ago") are recomputed while mounted.
const UPDATE_INTERVAL_MS = 60_000;

type DateInput = Date | string | number;

/**
 * Relative time ("5 minutes ago") with the absolute time on hover. The one
 * display surface for relative dates.
 */
export function RelativeTime({
  date,
  className,
}: {
  date: DateInput;
  className?: string;
}) {
  const format = useFormatter();
  const now = useNow({ updateInterval: UPDATE_INTERVAL_MS });
  const value = new Date(date);
  return (
    <time
      dateTime={value.toISOString()}
      title={format.dateTime(value, DATE_TIME)}
      className={className}
    >
      {format.relativeTime(value, now)}
    </time>
  );
}

/**
 * Same text as <RelativeTime> for the few places that must build a string
 * (translated sentences, joined captions).
 */
export function useRelativeTimeText(): (date: DateInput) => string {
  const format = useFormatter();
  const now = useNow({ updateInterval: UPDATE_INTERVAL_MS });
  return (date) => format.relativeTime(new Date(date), now);
}

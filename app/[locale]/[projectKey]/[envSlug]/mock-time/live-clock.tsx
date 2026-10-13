"use client";

import {
  format,
  formatDuration,
  intervalToDuration,
  type Locale,
} from "date-fns";
import { useTranslations } from "next-intl";
import * as React from "react";

/**
 * Renders a ticking clock label. The per-second state lives here so the tick
 * only re-renders this component — not the parent, which would otherwise close
 * an open date-picker dropdown every second.
 *
 * Anchors on the server's mocked `now` rather than `new Date()`; the environment
 * clock may be time-traveled. Pauses when `frozen`.
 */
export function LiveClock({
  now,
  frozen = false,
  dateFnsLocale,
}: {
  now: string;
  frozen?: boolean;
  dateFnsLocale: Locale | undefined;
}) {
  const [displayed, setDisplayed] = React.useState<Date>(() => new Date(now));

  React.useEffect(() => {
    const serverMs = new Date(now).getTime();
    const localMs = Date.now();
    setDisplayed(new Date(serverMs));
    if (frozen) return;
    const id = setInterval(() => {
      setDisplayed(new Date(serverMs + (Date.now() - localMs)));
    }, 1000);
    return () => clearInterval(id);
  }, [now, frozen]);

  return <>{format(displayed, "PPP HH:mm:ss", { locale: dateFnsLocale })}</>;
}

const OFFSET_UNITS = ["years", "months", "days", "hours", "minutes"] as const;

/**
 * How far the environment clock is from real time, e.g. "3 days 2 hours
 * ahead". Constant while the clock runs; drifts (and so ticks) while frozen.
 */
export function ClockOffset({
  now,
  frozen = false,
  dateFnsLocale,
}: {
  now: string;
  frozen?: boolean;
  dateFnsLocale: Locale | undefined;
}) {
  const t = useTranslations("mockTime.clockState");
  const [offsetMs, setOffsetMs] = React.useState<number | null>(null);

  React.useEffect(() => {
    const serverMs = new Date(now).getTime();
    setOffsetMs(serverMs - Date.now());
    if (!frozen) return;
    const id = setInterval(() => setOffsetMs(serverMs - Date.now()), 1000);
    return () => clearInterval(id);
  }, [now, frozen]);

  if (offsetMs === null) return null;
  const abs = Math.abs(offsetMs);
  // Sub-minute differences are request latency and browser clock skew.
  if (abs < 60_000) return <>{t("inSync")}</>;
  const parts = intervalToDuration({ start: 0, end: abs });
  // Two most significant units are enough to read at a glance.
  const units = OFFSET_UNITS.filter((u) => parts[u]).slice(0, 2);
  const duration = formatDuration(parts, {
    format: units,
    locale: dateFnsLocale,
  });
  return <>{t(offsetMs > 0 ? "ahead" : "behind", { duration })}</>;
}

"use client";

import { Clock } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  isWithinWorkingHours,
  nextWorkingStart,
  type WorkingHours,
} from "@/lib/user-display";
import { cn } from "@/lib/utils";

/**
 * The current time, refreshed each minute. Null until mounted: the server
 * can't know the viewer's clock minute, so rendering it would mismatch.
 */
export function useMinuteClock(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Two lines, ticking each minute:
 *   🕐 14:03 local time · GMT+8
 *   ● Outside working hours · back Mon 09:00   (only when hours are set)
 */
export function LocalTime({
  timeZone,
  workingHours,
}: {
  timeZone: string;
  workingHours: WorkingHours | null;
}) {
  const t = useTranslations("people");
  const format = useFormatter();
  const locale = useLocale();
  const now = useMinuteClock();

  // Rendered after mount only: the server can't know the viewer's clock minute.
  if (!now) return <div className="text-muted-foreground">&nbsp;</div>;

  // 24-hour, matching the header's server clock and working-hours times.
  const time = format.dateTime(now, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const offset = new Intl.DateTimeFormat(locale, {
    timeZone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value;
  const working =
    workingHours !== null && isWithinWorkingHours(workingHours, timeZone, now);
  let back: string | null = null;
  if (workingHours && !working) {
    const next = nextWorkingStart(workingHours, timeZone, now);
    if (next) {
      const day = format.dateTime(
        new Date(now.getTime() + next.daysAhead * 86_400_000),
        { timeZone, weekday: "short" }
      );
      back =
        next.daysAhead === 0
          ? t("backToday", { time: next.start })
          : next.daysAhead === 1
            ? t("backTomorrow", { time: next.start })
            : t("backOn", { day, time: next.start });
    }
  }
  return (
    <div className="flex flex-col gap-0.5 text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Clock className="size-3.5 shrink-0" aria-hidden="true" />
        {t("localTime", { time })} · {offset}
      </span>
      {workingHours && (
        <span className="flex items-center gap-1.5">
          {/* Same colours as the directory's AvailabilityDot. */}
          <span
            aria-hidden="true"
            className={cn(
              "mx-[3px] size-2 shrink-0 rounded-full",
              working ? "bg-emerald-500" : "bg-muted-foreground/50"
            )}
          />
          {working ? t("workingHoursNow") : t("outsideWorkingHours")}
          {back && <> · {back}</>}
        </span>
      )}
    </div>
  );
}

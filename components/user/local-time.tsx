"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { isWithinWorkingHours, nextWorkingStart, type WorkingHours } from "@/lib/user-display";

/** "14:03 local time · GMT+8 · outside working hours, back Mon 09:00". Ticks each minute. */
export function LocalTime({ timeZone, workingHours }: { timeZone: string; workingHours: WorkingHours | null }) {
  const t = useTranslations("people");
  const format = useFormatter();
  const locale = useLocale();
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Rendered after mount only: the server can't know the viewer's clock minute.
  if (!now) return <span className="text-muted-foreground">&nbsp;</span>;

  const time = format.dateTime(now, { timeZone, hour: "2-digit", minute: "2-digit" });
  const offset = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value;
  let state: string | null = null;
  if (workingHours) {
    if (isWithinWorkingHours(workingHours, timeZone, now)) state = t("workingNow");
    else {
      const next = nextWorkingStart(workingHours, timeZone, now);
      if (next) {
        const day = format.dateTime(new Date(now.getTime() + next.daysAhead * 86_400_000), { timeZone, weekday: "short" });
        state =
          next.daysAhead === 0
            ? t("backToday", { time: next.start })
            : next.daysAhead === 1
              ? t("backTomorrow", { time: next.start })
              : t("backOn", { day, time: next.start });
      }
    }
  }
  return (
    <span className="text-muted-foreground">
      {t("localTime", { time })} · {offset}
      {state && <> · {state}</>}
    </span>
  );
}

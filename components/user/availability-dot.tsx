"use client";

import { useTranslations } from "next-intl";
import { isWithinWorkingHours, type WorkingHours } from "@/lib/user-display";
import { cn } from "@/lib/utils";
import { useMinuteClock } from "./local-time";

/**
 * Small dot for the corner of an avatar: green inside the person's working
 * hours, muted outside them, nothing when they haven't set any. Computed after
 * mount, against the viewer's clock.
 */
export function AvailabilityDot({
  timeZone,
  workingHours,
  className,
}: {
  timeZone: string;
  workingHours: WorkingHours | null;
  className?: string;
}) {
  const t = useTranslations("people");
  const now = useMinuteClock();
  if (!now || !workingHours) return null;
  const working = isWithinWorkingHours(workingHours, timeZone, now);
  const label = working ? t("workingHoursNow") : t("outsideWorkingHours");
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "absolute bottom-0 end-0 size-3.5 rounded-full ring-2 ring-card",
        working ? "bg-emerald-500" : "bg-muted-foreground/50",
        className
      )}
    />
  );
}

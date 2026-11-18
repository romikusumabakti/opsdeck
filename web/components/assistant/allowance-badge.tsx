import { useTranslations } from "use-intl";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { Allowance } from "@/web/api/assistant";

/** Whether the caller has used up the day's limit. */
export const capReached = (allowance: Allowance) => allowance.capReached;

/** Used share from which the meter warns. */
const WARN_AT = 0.8;

/** Whether the meter is worth showing: from the warning share, or at the cap. */
export const showMeter = (allowance: Allowance) =>
  allowance.enabled &&
  (allowance.capReached || allowance.usedFraction >= WARN_AT);

/**
 * A compact meter of today's limit: the share used and when it resets (in the
 * reader's zone, via the intl time format), amber from 80%, destructive once
 * the limit is reached. Never shows dollars.
 */
export function AllowanceBadge({ allowance }: { allowance: Allowance }) {
  const t = useTranslations("assistant");
  const reached = allowance.capReached;
  // Rounded down, so 100% means the limit is really reached.
  const percent = reached ? 100 : Math.floor(allowance.usedFraction * 100);
  const time = new Date(allowance.resetsAt);
  return (
    <div
      className="flex w-44 flex-col gap-1"
      title={t("usageHint")}
      role={reached ? "status" : undefined}
    >
      <Progress
        value={percent}
        aria-label={t("usageHint")}
        className={cn(
          "gap-0",
          reached
            ? "[&_[data-slot=progress-indicator]]:bg-destructive"
            : allowance.usedFraction >= WARN_AT &&
                "[&_[data-slot=progress-indicator]]:bg-amber-500"
        )}
      />
      <p
        className={cn(
          "text-xs leading-tight text-muted-foreground",
          reached && "text-destructive"
        )}
      >
        {t("usageUsed", { percent })} · {t("usageResets", { time })}
      </p>
    </div>
  );
}

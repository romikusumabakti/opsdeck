import { useTranslations } from "use-intl";
import { Progress } from "@/components/ui/progress";
import { Link } from "@/i18n/navigation";
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
 * What a meter of today's limit shows, for the badge and the Usage card alike:
 * the share used (rounded down, so 100% means the limit is really reached),
 * the share left, and the tone (amber from 80%, destructive at the cap).
 */
export function allowanceMeter(allowance: Allowance) {
  const reached = allowance.capReached;
  const percent = reached ? 100 : Math.floor(allowance.usedFraction * 100);
  return {
    reached,
    percent,
    left: 100 - percent,
    warn: !reached && allowance.usedFraction >= WARN_AT,
  };
}

/** The progress bar of today's limit, coloured by `allowanceMeter`. */
export function AllowanceBar({
  allowance,
  label,
  className,
}: {
  allowance: Allowance;
  label: string;
  className?: string;
}) {
  const { reached, percent, warn } = allowanceMeter(allowance);
  return (
    <Progress
      value={percent}
      aria-label={label}
      className={cn(
        "gap-0",
        reached
          ? "[&_[data-slot=progress-indicator]]:bg-destructive"
          : warn && "[&_[data-slot=progress-indicator]]:bg-amber-500",
        className
      )}
    />
  );
}

/**
 * A compact meter of today's limit: the share used and when it resets (in the
 * reader's zone, via the intl time format), amber from 80%, destructive once
 * the limit is reached. Links to the Usage tab in Account. Never shows
 * dollars.
 */
export function AllowanceBadge({ allowance }: { allowance: Allowance }) {
  const t = useTranslations("assistant");
  const { reached, percent } = allowanceMeter(allowance);
  const time = new Date(allowance.resetsAt);
  return (
    <div className="w-44">
      <Link
        href="/account?tab=usage"
        className="flex flex-col gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={t("usageHint")}
      >
        <AllowanceBar allowance={allowance} label={t("usageHint")} />
        <p
          className={cn(
            "text-xs leading-tight text-muted-foreground",
            reached && "text-destructive"
          )}
        >
          {t("usageUsed", { percent })} · {t("usageResets", { time })}
        </p>
      </Link>
      {/* Announced at the cap; kept off the link so it stays a link. */}
      {reached && (
        <span role="status" className="sr-only">
          {t("usageCapReached", { time })}
        </span>
      )}
    </div>
  );
}

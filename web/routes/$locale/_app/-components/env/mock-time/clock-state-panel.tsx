import { Clock, RefreshCw } from "lucide-react";
import type * as React from "react";
import { useLocale, useTranslations } from "use-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { cn } from "@/lib/utils";
import type { ClockState } from "@/web/api/mock-time";
import { ClockOffset, LiveClock } from "./live-clock";

export function ClockStatePanel({
  clock,
  clockError,
  clockLoading,
  disabled,
  showFrozen = false,
  sticky = true,
  onRefresh,
  children,
}: {
  clock: ClockState | null;
  clockError: string | null;
  clockLoading: boolean;
  disabled: boolean;
  showFrozen?: boolean;
  sticky?: boolean;
  onRefresh: () => void;
  /** Actions rendered below the state, e.g. reset. */
  children?: React.ReactNode;
}) {
  const t = useTranslations("mockTime");
  const locale = useLocale();
  const dateFnsLocale = getDateFnsLocale(locale);

  const isMocked = clock?.mocked === true;
  const isFrozen = clock?.frozen === true;

  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-md border bg-card p-4",
        sticky && "lg:sticky lg:top-0"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Clock className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">{t("clockState.title")}</h3>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={disabled || clockLoading}
          aria-label={t("clockState.refresh")}
        >
          <RefreshCw className={cn("size-4", clockLoading && "animate-spin")} />
          {t("clockState.refresh")}
        </Button>
      </div>
      {clockLoading && !clock ? (
        <div
          role="status"
          aria-label={t("clockState.loading")}
          className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2"
        >
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-5 w-16 rounded-full" />
          {showFrozen ? (
            <>
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </>
          ) : null}
        </div>
      ) : clockError ? (
        <p className="text-sm text-destructive">
          {t("clockState.loadError")}: {clockError}
        </p>
      ) : clock ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t("clockState.now")}</dt>
          <dd className="tabular-nums">
            <LiveClock
              now={clock.now}
              frozen={showFrozen ? clock.frozen : undefined}
              dateFnsLocale={dateFnsLocale}
            />
          </dd>
          <dt className="text-muted-foreground">{t("clockState.mocked")}</dt>
          <dd>
            <Badge variant={isMocked ? "default" : "secondary"}>
              {isMocked ? t("clockState.yes") : t("clockState.real")}
            </Badge>
          </dd>
          {showFrozen ? (
            <>
              <dt className="text-muted-foreground">
                {t("clockState.frozen")}
              </dt>
              <dd>
                <Badge variant={isFrozen ? "default" : "secondary"}>
                  {isFrozen ? t("clockState.yes") : t("clockState.running")}
                </Badge>
              </dd>
            </>
          ) : null}
          {isMocked ? (
            <>
              <dt className="text-muted-foreground">
                {t("clockState.offset")}
              </dt>
              <dd className="tabular-nums">
                <ClockOffset
                  now={clock.now}
                  frozen={clock.frozen}
                  dateFnsLocale={dateFnsLocale}
                />
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {children}
    </section>
  );
}

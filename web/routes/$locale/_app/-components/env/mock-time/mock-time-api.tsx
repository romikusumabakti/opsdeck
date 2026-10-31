import { ChevronDown, Clock, RotateCcw, Snowflake } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useFormatter, useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { useProjectCan } from "@/components/project-role";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  browserTimeZone,
  DATE_TIME,
  DATE_TIME_SECONDS,
} from "@/lib/format-date";
import { cn } from "@/lib/utils";
import type { EnvironmentWithServers } from "@/web/api/environments";
import {
  advanceClock,
  type ClockState,
  freezeClock,
  getClockState,
  resetClock,
  travelClock,
} from "@/web/api/mock-time";
import { AdvanceFields } from "./advance-fields";
import { ClockStatePanel } from "./clock-state-panel";
import { BrowserZoneHint, DateTimePicker } from "./date-time-picker";
import {
  type AdvanceDirection,
  type AdvanceUnit,
  buildDuration,
} from "./duration";

export function MockTimeApi({
  environment,
}: {
  environment: EnvironmentWithServers;
}) {
  const t = useTranslations("mockTime");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const dialog = useDialog();

  const [date, setDate] = React.useState<Date | undefined>(() => new Date());
  const [hour, setHour] = React.useState<number>(() => new Date().getHours());
  const [minute, setMinute] = React.useState<number>(() =>
    new Date().getMinutes()
  );

  const [clock, setClock] = React.useState<ClockState | null>(null);
  const [clockError, setClockError] = React.useState<string | null>(null);
  const [clockLoading, setClockLoading] = React.useState(true);
  const [pendingAction, setPendingAction] = React.useState<
    | null
    | "travel"
    | "freezeAt"
    | "freezeNow"
    | `advance:${AdvanceDirection}`
    | "reset"
    | "refresh"
  >(null);

  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  const [advanceAmount, setAdvanceAmount] = React.useState<string>("1");
  const [advanceUnit, setAdvanceUnit] = React.useState<AdvanceUnit>("hours");

  const combined = React.useMemo(() => {
    const next = new Date(date ?? new Date());
    next.setHours(hour, minute, 0, 0);
    return next;
  }, [date, hour, minute]);

  const displayLabel = format.dateTime(combined, {
    ...DATE_TIME,
    timeZone: browserTimeZone(),
  });

  const refreshClock = React.useCallback(
    async (silent = false) => {
      if (!silent) setPendingAction("refresh");
      setClockLoading(true);
      setClockError(null);
      try {
        const result = await getClockState(environment.id);
        if (!result.success) {
          setClock(null);
          setClockError(result.error);
          return;
        }
        setClock(result.data);
      } catch (err) {
        // A thrown action (not an ApiResult failure) must not leave the panel
        // stuck loading with every control disabled.
        setClock(null);
        setClockError(
          err instanceof Error ? err.message : tCommon("errorGeneric")
        );
      } finally {
        setClockLoading(false);
        if (!silent) setPendingAction(null);
      }
    },
    [environment, tCommon]
  );

  React.useEffect(() => {
    refreshClock(true);
  }, [refreshClock]);

  function handleResult(
    result:
      | { success: true; data: ClockState | null }
      | {
          success: false;
          error: string;
        },
    success: { title: string; description?: string }
  ) {
    if (!result.success) {
      toast.error(t("failureTitle"), { description: result.error });
      return false;
    }
    if (result.data) setClock(result.data);
    toast.success(success.title, { description: success.description });
    return true;
  }

  async function onTravel() {
    const ok = await dialog.confirm({
      title: t("travel.title"),
      description: t("travel.confirm", { dateTime: displayLabel }),
      confirmText: t("travel.submit"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;
    setPendingAction("travel");
    try {
      const target = combined.toISOString();
      const result = await travelClock(environment.id, target);
      handleResult(result, {
        title: t("travel.successTitle"),
        description: t("travel.successDescription", { dateTime: displayLabel }),
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function onFreezeAt() {
    const ok = await dialog.confirm({
      title: t("freeze.title"),
      description: t("freeze.confirmAt", { dateTime: displayLabel }),
      confirmText: t("freeze.submitAt"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;
    setPendingAction("freezeAt");
    try {
      const at = combined.toISOString();
      const result = await freezeClock(environment.id, at);
      handleResult(result, {
        title: t("freeze.successTitle"),
        description: t("freeze.successDescriptionAt", {
          dateTime: displayLabel,
        }),
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function onFreezeNow() {
    const ok = await dialog.confirm({
      title: t("freeze.title"),
      description: t("freeze.confirmNow"),
      confirmText: t("freeze.submitNow"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;
    setPendingAction("freezeNow");
    try {
      const result = await freezeClock(environment.id, null);
      handleResult(result, {
        title: t("freeze.successTitle"),
        description: t("freeze.successDescriptionNow"),
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function onAdvance(direction: AdvanceDirection) {
    const amount = Number(advanceAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t("failureTitle"), {
        description: t("advance.amountInvalid"),
      });
      return;
    }
    setPendingAction(`advance:${direction}`);
    try {
      const duration = buildDuration(amount, advanceUnit, direction);
      const result = await advanceClock(environment.id, duration);
      if (!result.success) {
        toast.error(t("failureTitle"), { description: result.error });
        return;
      }
      setClock(result.data);
      const nowLabel = format.dateTime(
        new Date(result.data.now),
        DATE_TIME_SECONDS
      );
      toast.success(t("advance.successTitle"), {
        description: t("advance.successDescription", { dateTime: nowLabel }),
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function onReset() {
    const ok = await dialog.confirm({
      title: t("reset.title"),
      description: t("reset.confirm"),
      confirmText: t("reset.submit"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;
    setPendingAction("reset");
    try {
      const result = await resetClock(environment.id);
      if (!result.success) {
        toast.error(t("failureTitle"), { description: result.error });
        return;
      }
      // DELETE /clock returns 204, so we need to refresh state explicitly.
      await refreshClock(true);
      toast.success(t("reset.successTitle"), {
        description: t("reset.successDescription"),
      });
    } finally {
      setPendingAction(null);
    }
  }

  const canRunOps = useProjectCan({ clock: ["control"] });
  // Don't act on a clock whose state we haven't seen yet.
  const clockUnknown = clockLoading && !clock;
  const anyPending = pendingAction !== null || !canRunOps || clockUnknown;
  const isFrozen = clock?.frozen === true;
  const isMocked = clock?.mocked === true;
  const advancing =
    pendingAction === "advance:forward"
      ? "forward"
      : pendingAction === "advance:backward"
        ? "backward"
        : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr] lg:items-start">
        <ClockStatePanel
          clock={clock}
          clockError={clockError}
          clockLoading={clockLoading}
          disabled={anyPending}
          showFrozen
          onRefresh={() => refreshClock(false)}
        >
          {isMocked || isFrozen ? (
            <Button
              variant="destructive"
              size="sm"
              className="self-start"
              onClick={onReset}
              disabled={anyPending}
            >
              <RotateCcw className="size-4" />
              {pendingAction === "reset"
                ? t("reset.submitting")
                : t("reset.submit")}
            </Button>
          ) : null}
        </ClockStatePanel>

        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <header className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">{t("target.title")}</h3>
              <p className="text-xs text-muted-foreground">
                {t("target.description")}
              </p>
            </header>
            <div className="flex flex-row items-end gap-2 flex-wrap">
              <DateTimePicker
                date={date}
                hour={hour}
                minute={minute}
                onDateChange={setDate}
                onTimeChange={(h, m) => {
                  setHour(h);
                  setMinute(m);
                }}
                idPrefix="mock-time-api"
              />
              <div className="flex gap-2">
                <Button onClick={onTravel} disabled={anyPending}>
                  <Clock className="size-4" />
                  {pendingAction === "travel"
                    ? t("travel.submitting")
                    : t("travel.submit")}
                </Button>
                <Button
                  variant="outline"
                  onClick={onFreezeAt}
                  disabled={anyPending}
                >
                  <Snowflake className="size-4" />
                  {pendingAction === "freezeAt"
                    ? t("freeze.submitting")
                    : t("freeze.submitAt")}
                </Button>
              </div>
            </div>
            <BrowserZoneHint />
          </section>

          <Separator />

          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
            className="flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                "size-4 transition-transform",
                advancedOpen && "rotate-180"
              )}
            />
            {t("advancedOptions")}
          </button>

          {advancedOpen && (
            <>
              <section className="flex flex-col gap-3">
                <header className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium">{t("freeze.title")}</h3>
                  <p className="text-xs text-muted-foreground">
                    {t("freeze.description")}
                  </p>
                </header>
                <div>
                  <Button
                    variant="outline"
                    onClick={onFreezeNow}
                    disabled={anyPending}
                  >
                    <Snowflake className="size-4" />
                    {pendingAction === "freezeNow"
                      ? t("freeze.submitting")
                      : t("freeze.submitNow")}
                  </Button>
                </div>
              </section>

              <Separator />

              <section className="flex flex-col gap-3">
                <header className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium">{t("advance.title")}</h3>
                  <p className="text-xs text-muted-foreground">
                    {t("advance.description")}
                  </p>
                </header>
                {!isFrozen && clock ? (
                  <p className="text-xs text-muted-foreground italic">
                    {t("advance.notFrozen")}
                  </p>
                ) : null}
                <AdvanceFields
                  idPrefix="api"
                  amount={advanceAmount}
                  unit={advanceUnit}
                  disabled={!isFrozen || anyPending}
                  submitting={advancing}
                  onAmountChange={setAdvanceAmount}
                  onUnitChange={setAdvanceUnit}
                  onSubmit={onAdvance}
                />
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

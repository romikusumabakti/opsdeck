"use client";

import { format } from "date-fns";
import { ChevronDown, Clock, RotateCcw, Snowflake } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import {
  advanceClock,
  type ClockState,
  freezeClock,
  getClockState,
  resetClock,
  travelClock,
} from "@/actions/mock-time";
import { useDialog } from "@/components/dialog-provider";
import { useCanRunOps } from "@/components/ops-capability";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import type { SafeEnvironmentWithServers } from "@/lib/db/schema";
import { cn } from "@/lib/utils";
import { AdvanceFields } from "./advance-fields";
import { ClockStatePanel } from "./clock-state-panel";
import { DateTimePicker } from "./date-time-picker";
import {
  type AdvanceDirection,
  type AdvanceUnit,
  buildDuration,
} from "./duration";

export function MockTimeApi({
  environment,
}: {
  environment: SafeEnvironmentWithServers;
}) {
  const t = useTranslations("mockTime");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const dateFnsLocale = getDateFnsLocale(locale);
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
    null | "travel" | "freezeAt" | "freezeNow" | "advance" | "reset" | "refresh"
  >(null);

  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  const [advanceAmount, setAdvanceAmount] = React.useState<string>("1");
  const [advanceUnit, setAdvanceUnit] = React.useState<AdvanceUnit>("hours");
  const [advanceDirection, setAdvanceDirection] =
    React.useState<AdvanceDirection>("forward");

  const combined = React.useMemo(() => {
    const next = new Date(date ?? new Date());
    next.setHours(hour, minute, 0, 0);
    return next;
  }, [date, hour, minute]);

  const displayLabel = format(combined, "PPP HH:mm", {
    locale: dateFnsLocale,
  });

  const refreshClock = React.useCallback(
    async (silent = false) => {
      if (!silent) setPendingAction("refresh");
      setClockLoading(true);
      setClockError(null);
      const result = await getClockState(environment.id);
      setClockLoading(false);
      if (!silent) setPendingAction(null);
      if (!result.success) {
        setClock(null);
        setClockError(result.error);
        return;
      }
      setClock(result.data);
    },
    [environment]
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

  async function onAdvance() {
    const amount = Number(advanceAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t("failureTitle"), {
        description: t("advance.amountInvalid"),
      });
      return;
    }
    setPendingAction("advance");
    try {
      const duration = buildDuration(amount, advanceUnit, advanceDirection);
      const result = await advanceClock(environment.id, duration);
      if (!result.success) {
        toast.error(t("failureTitle"), { description: result.error });
        return;
      }
      setClock(result.data);
      const nowLabel = format(new Date(result.data.now), "PPP HH:mm", {
        locale: dateFnsLocale,
      });
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

  const canRunOps = useCanRunOps();
  const anyPending = pendingAction !== null || !canRunOps;
  const isFrozen = clock?.frozen === true;
  const isMocked = clock?.mocked === true;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr] lg:items-start">
        <ClockStatePanel
          clock={clock}
          clockError={clockError}
          clockLoading={clockLoading}
          refreshing={pendingAction === "refresh"}
          disabled={anyPending}
          showFrozen
          onRefresh={() => refreshClock(false)}
        />

        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <header className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">{t("travel.title")}</h3>
              <p className="text-xs text-muted-foreground">
                {t("travel.description")}
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
              <Button onClick={onTravel} disabled={anyPending}>
                <Clock className="size-4" />
                {pendingAction === "travel"
                  ? t("travel.submitting")
                  : t("travel.submit")}
              </Button>
            </div>
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
                <div className="flex flex-row gap-2 flex-wrap">
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
                  direction={advanceDirection}
                  disabled={!isFrozen || anyPending}
                  submitting={pendingAction === "advance"}
                  onAmountChange={setAdvanceAmount}
                  onUnitChange={setAdvanceUnit}
                  onDirectionChange={setAdvanceDirection}
                  onSubmit={onAdvance}
                />
              </section>

              <Separator />
            </>
          )}

          <section className="flex flex-col gap-3">
            <header className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">{t("reset.title")}</h3>
              <p className="text-xs text-muted-foreground">
                {t("reset.description")}
              </p>
            </header>
            <div>
              <Button
                variant="destructive"
                onClick={onReset}
                disabled={anyPending || (!isMocked && !isFrozen)}
              >
                <RotateCcw className="size-4" />
                {pendingAction === "reset"
                  ? t("reset.submitting")
                  : t("reset.submit")}
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

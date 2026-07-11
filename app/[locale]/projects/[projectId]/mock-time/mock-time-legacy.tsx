"use client";

import { format } from "date-fns";
import { ChevronDown, Clock, Info, RotateCcw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import {
  advanceClockLegacy,
  type ClockState,
  getClockStateLegacy,
  mockProjectTimeLegacy,
  resetClockLegacy,
} from "@/actions/mock-time";
import { useDialog } from "@/components/dialog-provider";
import { LiveRunDialog } from "@/components/live-run-dialog";
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

export function MockTimeLegacy({
  project,
}: {
  project: SafeEnvironmentWithServers;
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
    null | "travel" | "advance" | "reset" | "refresh"
  >(null);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [activeTaskLabel, setActiveTaskLabel] = React.useState<string>("");

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
      const result = await getClockStateLegacy(project.id);
      setClockLoading(false);
      if (!silent) setPendingAction(null);
      if (!result.success) {
        setClock(null);
        setClockError(result.error);
        return;
      }
      setClock(result.data);
    },
    [project]
  );

  React.useEffect(() => {
    refreshClock(true);
  }, [refreshClock]);

  async function onTravel() {
    const ok = await dialog.confirm({
      title: t("travel.title"),
      description: t("travel.confirmLegacy", { dateTime: displayLabel }),
      confirmText: t("travel.submit"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;
    setPendingAction("travel");
    try {
      const result = await mockProjectTimeLegacy(
        project.id,
        combined.toISOString()
      );
      if (!result.success) {
        toast.error(t("failureTitle"), { description: result.error });
        return;
      }
      setActiveTaskLabel(displayLabel);
      setActiveTaskId(result.runId);
      toast.success(t("successTitle"), {
        description: t("travel.queuedDescriptionLegacy", {
          dateTime: displayLabel,
        }),
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
    const duration = buildDuration(amount, advanceUnit, advanceDirection);
    const ok = await dialog.confirm({
      title: t("advance.title"),
      description: t("advance.confirmLegacy", { duration }),
      confirmText: t("advance.submit"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;
    setPendingAction("advance");
    try {
      const result = await advanceClockLegacy(project.id, duration);
      if (!result.success) {
        toast.error(t("failureTitle"), { description: result.error });
        return;
      }
      setActiveTaskLabel(duration);
      setActiveTaskId(result.runId);
      toast.success(t("advance.successTitle"), {
        description: t("advance.queuedDescriptionLegacy", { duration }),
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function onReset() {
    const ok = await dialog.confirm({
      title: t("reset.title"),
      description: t("reset.confirmLegacy"),
      confirmText: t("reset.submit"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;
    setPendingAction("reset");
    try {
      const result = await resetClockLegacy(project.id);
      if (!result.success) {
        toast.error(t("failureTitle"), { description: result.error });
        return;
      }
      setActiveTaskLabel(t("reset.title"));
      setActiveTaskId(result.runId);
      toast.success(t("reset.successTitle"), {
        description: t("reset.queuedDescriptionLegacy"),
      });
    } finally {
      setPendingAction(null);
    }
  }

  const canRunOps = useCanRunOps();
  const anyPending = pendingAction !== null || !canRunOps;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr] lg:items-start">
        <div className="flex flex-col gap-3 lg:sticky lg:top-0">
          <ClockStatePanel
            clock={clock}
            clockError={clockError}
            clockLoading={clockLoading}
            refreshing={pendingAction === "refresh"}
            disabled={anyPending}
            sticky={false}
            onRefresh={() => refreshClock(false)}
          />
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <Info className="size-4 shrink-0 mt-0.5" />
            <p>{t("legacyWarning")}</p>
          </div>
        </div>

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
                idPrefix="mock-time-legacy"
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
                  <h3 className="text-sm font-medium">{t("advance.title")}</h3>
                  <p className="text-xs text-muted-foreground">
                    {t("advance.descriptionLegacy")}
                  </p>
                </header>
                <AdvanceFields
                  idPrefix="legacy"
                  amount={advanceAmount}
                  unit={advanceUnit}
                  direction={advanceDirection}
                  disabled={anyPending}
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
                {t("reset.descriptionLegacy")}
              </p>
            </header>
            <div>
              <Button
                onClick={onReset}
                disabled={anyPending}
                variant="destructive"
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

      <LiveRunDialog
        runId={activeTaskId}
        onOpenChange={(open) => {
          if (!open) {
            setActiveTaskId(null);
            // After a legacy run completes, the clock may have changed —
            // pull the new state so the user doesn't have to refresh manually.
            refreshClock(true);
          }
        }}
        title={t("title")}
        description={<span>{activeTaskLabel}</span>}
      />
    </div>
  );
}

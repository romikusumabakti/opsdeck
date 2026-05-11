"use client";

import { format } from "date-fns";
import { id as idLocale } from "date-fns/locale";
import { Clock, FastForward, RefreshCw, RotateCcw } from "lucide-react";
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
import { LiveTaskDialog } from "@/components/live-task-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { ProjectWithServers } from "@/lib/db/schema";
import { DateTimePicker } from "./date-time-picker";

type AdvanceUnit = "minutes" | "hours" | "days";
type AdvanceDirection = "forward" | "backward";

function buildDuration(
  amount: number,
  unit: AdvanceUnit,
  direction: AdvanceDirection
): string {
  const sign = direction === "backward" ? "-" : "";
  switch (unit) {
    case "days":
      return `${sign}P${amount}D`;
    case "hours":
      return `${sign}PT${amount}H`;
    case "minutes":
      return `${sign}PT${amount}M`;
  }
}

export function MockTimeLegacy({ project }: { project: ProjectWithServers }) {
  const t = useTranslations("mockTime");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const dateFnsLocale = locale === "id" ? idLocale : undefined;
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
      const result = await getClockStateLegacy(project);
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
        project,
        combined.toISOString()
      );
      if (!result.success) {
        toast.error(t("failureTitle"), { description: result.error });
        return;
      }
      setActiveTaskLabel(displayLabel);
      setActiveTaskId(result.taskId);
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
      const result = await advanceClockLegacy(project, duration);
      if (!result.success) {
        toast.error(t("failureTitle"), { description: result.error });
        return;
      }
      setActiveTaskLabel(duration);
      setActiveTaskId(result.taskId);
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
      const result = await resetClockLegacy(project);
      if (!result.success) {
        toast.error(t("failureTitle"), { description: result.error });
        return;
      }
      setActiveTaskLabel(t("reset.title"));
      setActiveTaskId(result.taskId);
      toast.success(t("reset.successTitle"), {
        description: t("reset.queuedDescriptionLegacy"),
      });
    } finally {
      setPendingAction(null);
    }
  }

  const anyPending = pendingAction !== null;
  const isMocked = clock?.mocked === true;
  const nowLabel = clock
    ? format(new Date(clock.now), "PPP HH:mm:ss", { locale: dateFnsLocale })
    : null;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Clock className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">{t("clockState.title")}</h3>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refreshClock(false)}
            disabled={anyPending}
            aria-label={t("clockState.refresh")}
          >
            <RefreshCw
              className={`size-4 ${
                pendingAction === "refresh" ? "animate-spin" : ""
              }`}
            />
            {t("clockState.refresh")}
          </Button>
        </div>
        {clockLoading && !clock ? (
          <p className="text-sm text-muted-foreground">
            {t("clockState.loading")}
          </p>
        ) : clockError ? (
          <p className="text-sm text-destructive">
            {t("clockState.loadError")}: {clockError}
          </p>
        ) : clock ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t("clockState.now")}</dt>
            <dd className="tabular-nums">{nowLabel}</dd>
            <dt className="text-muted-foreground">{t("clockState.mocked")}</dt>
            <dd>
              <Badge variant={isMocked ? "default" : "secondary"}>
                {isMocked ? t("clockState.yes") : t("clockState.real")}
              </Badge>
            </dd>
          </dl>
        ) : null}
      </section>

      <Separator />

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
          <Button
            onClick={onTravel}
            disabled={anyPending}
            variant="destructive"
          >
            <Clock className="size-4" />
            {pendingAction === "travel"
              ? t("travel.submitting")
              : t("travel.submit")}
          </Button>
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">{t("advance.title")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("advance.descriptionLegacy")}
          </p>
        </header>
        <FieldGroup className="flex-row items-end gap-2 flex-wrap">
          <Field className="flex-1">
            <FieldLabel htmlFor="legacy-advance-amount">
              {t("advance.amountLabel")}
            </FieldLabel>
            <Input
              id="legacy-advance-amount"
              type="number"
              min={1}
              step={1}
              value={advanceAmount}
              onChange={(e) => setAdvanceAmount(e.target.value)}
              disabled={anyPending}
              className="tabular-nums"
            />
          </Field>
          <Field className="flex-1">
            <FieldLabel htmlFor="legacy-advance-unit">
              {t("advance.unitLabel")}
            </FieldLabel>
            <Select
              value={advanceUnit}
              onValueChange={(v) => setAdvanceUnit(v as AdvanceUnit)}
              disabled={anyPending}
            >
              <SelectTrigger id="legacy-advance-unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="minutes">
                  {t("advance.units.minutes")}
                </SelectItem>
                <SelectItem value="hours">
                  {t("advance.units.hours")}
                </SelectItem>
                <SelectItem value="days">{t("advance.units.days")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field className="flex-1">
            <FieldLabel htmlFor="legacy-advance-direction">
              {t("advance.directionLabel")}
            </FieldLabel>
            <Select
              value={advanceDirection}
              onValueChange={(v) => setAdvanceDirection(v as AdvanceDirection)}
              disabled={anyPending}
            >
              <SelectTrigger id="legacy-advance-direction">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="forward">{t("advance.forward")}</SelectItem>
                <SelectItem value="backward">
                  {t("advance.backward")}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Button
            onClick={onAdvance}
            disabled={anyPending}
            variant="destructive"
          >
            <FastForward className="size-4" />
            {pendingAction === "advance"
              ? t("advance.submitting")
              : t("advance.submit")}
          </Button>
        </FieldGroup>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">{t("reset.title")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("reset.descriptionLegacy")}
          </p>
        </header>
        <div>
          <Button onClick={onReset} disabled={anyPending} variant="outline">
            <RotateCcw className="size-4" />
            {pendingAction === "reset"
              ? t("reset.submitting")
              : t("reset.submit")}
          </Button>
        </div>
      </section>

      <LiveTaskDialog
        taskId={activeTaskId}
        onOpenChange={(open) => {
          if (!open) {
            setActiveTaskId(null);
            // After a legacy task completes, the clock may have changed —
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

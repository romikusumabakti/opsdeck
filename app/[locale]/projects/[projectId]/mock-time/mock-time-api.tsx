"use client";

import { format } from "date-fns";
import {
  Clock,
  FastForward,
  RefreshCw,
  RotateCcw,
  Snowflake,
} from "lucide-react";
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
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import type { SafeProjectWithServers } from "@/lib/db/schema";
import { DateTimePicker } from "./date-time-picker";
import { LiveClock } from "./live-clock";

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

export function MockTimeApi({ project }: { project: SafeProjectWithServers }) {
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
      const result = await getClockState(project.id);
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
      const result = await travelClock(project.id, target);
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
      const result = await freezeClock(project.id, at);
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
      const result = await freezeClock(project.id, null);
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
      const result = await advanceClock(project.id, duration);
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
      const result = await resetClock(project.id);
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

  const anyPending = pendingAction !== null;
  const isFrozen = clock?.frozen === true;
  const isMocked = clock?.mocked === true;

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
            <dd className="tabular-nums">
              <LiveClock
                now={clock.now}
                frozen={clock.frozen}
                dateFnsLocale={dateFnsLocale}
              />
            </dd>
            <dt className="text-muted-foreground">{t("clockState.mocked")}</dt>
            <dd>
              <Badge variant={isMocked ? "default" : "secondary"}>
                {isMocked ? t("clockState.yes") : t("clockState.real")}
              </Badge>
            </dd>
            <dt className="text-muted-foreground">{t("clockState.frozen")}</dt>
            <dd>
              <Badge variant={isFrozen ? "default" : "secondary"}>
                {isFrozen ? t("clockState.yes") : t("clockState.running")}
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

      <section className="flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">{t("freeze.title")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("freeze.description")}
          </p>
        </header>
        <div className="flex flex-row gap-2 flex-wrap">
          <Button variant="outline" onClick={onFreezeAt} disabled={anyPending}>
            <Snowflake className="size-4" />
            {pendingAction === "freezeAt"
              ? t("freeze.submitting")
              : t("freeze.submitAt")}
          </Button>
          <Button variant="outline" onClick={onFreezeNow} disabled={anyPending}>
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
        <FieldGroup className="flex-row items-end gap-2 flex-wrap">
          <Field className="flex-1">
            <FieldLabel htmlFor="advance-amount">
              {t("advance.amountLabel")}
            </FieldLabel>
            <Input
              id="advance-amount"
              type="number"
              min={1}
              step={1}
              value={advanceAmount}
              onChange={(e) => setAdvanceAmount(e.target.value)}
              disabled={!isFrozen || anyPending}
              className="tabular-nums"
            />
          </Field>
          <Field className="flex-1">
            <FieldLabel htmlFor="advance-unit">
              {t("advance.unitLabel")}
            </FieldLabel>
            <Select
              value={advanceUnit}
              onValueChange={(v) => setAdvanceUnit(v as AdvanceUnit)}
              disabled={!isFrozen || anyPending}
            >
              <SelectTrigger id="advance-unit">
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
            <FieldLabel htmlFor="advance-direction">
              {t("advance.directionLabel")}
            </FieldLabel>
            <Select
              value={advanceDirection}
              onValueChange={(v) => setAdvanceDirection(v as AdvanceDirection)}
              disabled={!isFrozen || anyPending}
            >
              <SelectTrigger id="advance-direction">
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
          <Button onClick={onAdvance} disabled={!isFrozen || anyPending}>
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
  );
}

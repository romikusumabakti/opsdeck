"use client";

import { format } from "date-fns";
import { id as idLocale } from "date-fns/locale";
import { ChevronDownIcon, Clock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { mockProjectTime } from "@/actions/mock-time";
import { useDialog } from "@/components/dialog-provider";
import { LiveTaskDialog } from "@/components/live-task-dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ProjectWithServers } from "@/lib/db/schema";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function formatDigits(digits: string) {
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
}

function parseDigits(digits: string) {
  const h = Number(digits.slice(0, 2) || "0");
  const m = Number(digits.slice(2, 4) || "0");
  return { h, m, valid: digits.length > 0 && h <= 23 && m <= 59 };
}

function TimeInput({
  id,
  hour,
  minute,
  onChange,
  ariaLabel,
}: {
  id?: string;
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  ariaLabel: string;
}) {
  const canonical = `${pad(hour)}:${pad(minute)}`;
  const [display, setDisplay] = React.useState(canonical);

  React.useEffect(() => {
    setDisplay(canonical);
  }, [canonical]);

  return (
    <Input
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      maxLength={5}
      placeholder="HH:MM"
      value={display}
      aria-label={ariaLabel}
      className="w-20 text-center tabular-nums"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, "").slice(0, 4);
        setDisplay(formatDigits(digits));
        const { h, m, valid } = parseDigits(digits);
        if (valid) onChange(h, m);
      }}
      onBlur={() => {
        const digits = display.replace(/\D/g, "");
        const { h, m, valid } = parseDigits(digits);
        if (!valid) {
          setDisplay(canonical);
          return;
        }
        setDisplay(`${pad(h)}:${pad(m)}`);
        onChange(h, m);
      }}
    />
  );
}

export function MockTime({ project }: { project: ProjectWithServers }) {
  const t = useTranslations("mockTime");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const dateFnsLocale = locale === "id" ? idLocale : undefined;
  const dialog = useDialog();
  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState<Date | undefined>(() => new Date());
  const [hour, setHour] = React.useState<number>(() => new Date().getHours());
  const [minute, setMinute] = React.useState<number>(() =>
    new Date().getMinutes()
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);

  const isLegacy = !project.backendMockTimeApiUrl?.trim();

  const combined = React.useMemo(() => {
    const next = new Date(date ?? new Date());
    next.setHours(hour, minute, 0, 0);
    return next;
  }, [date, hour, minute]);

  const displayLabel = format(combined, "PPP HH:mm", {
    locale: dateFnsLocale,
  });

  async function onSubmit() {
    const ok = await dialog.confirm({
      title: t("confirmTitle"),
      description: isLegacy
        ? t("confirmDescriptionLegacy", { dateTime: displayLabel })
        : t("confirmDescriptionApi", { dateTime: displayLabel }),
      confirmText: t("submit"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;

    setSubmitting(true);
    try {
      const result = await mockProjectTime(project, combined.toISOString());
      if (!result.success) {
        toast.error(t("failureTitle"), { description: result.error });
        return;
      }
      if (result.mode === "legacy") {
        setActiveTaskId(result.taskId);
      }
      toast.success(t("successTitle"), {
        description:
          result.mode === "api"
            ? t("successDescriptionApi", { dateTime: displayLabel })
            : t("successDescriptionLegacy", { dateTime: displayLabel }),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <FieldGroup className="flex-row items-end gap-4">
        <Field>
          <FieldLabel htmlFor="mock-time-date">{t("dateLabel")}</FieldLabel>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                id="mock-time-date"
                className="w-40 justify-between font-normal"
              >
                {date
                  ? format(date, "PPP", { locale: dateFnsLocale })
                  : t("selectDate")}
                <ChevronDownIcon />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-auto overflow-hidden p-0"
              align="start"
            >
              <Calendar
                mode="single"
                selected={date}
                captionLayout="dropdown"
                defaultMonth={date}
                locale={dateFnsLocale}
                onSelect={(d) => {
                  setDate(d);
                  setOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
        </Field>
        <Field className="w-fit">
          <FieldLabel htmlFor="mock-time-time">{t("timeLabel")}</FieldLabel>
          <TimeInput
            id="mock-time-time"
            hour={hour}
            minute={minute}
            onChange={(h, m) => {
              setHour(h);
              setMinute(m);
            }}
            ariaLabel={t("timeLabel")}
          />
        </Field>
        <Button
          onClick={onSubmit}
          disabled={submitting}
          variant={isLegacy ? "destructive" : "default"}
        >
          <Clock className="size-4" />
          {submitting ? t("submitting") : t("submit")}
        </Button>
      </FieldGroup>
      <LiveTaskDialog
        taskId={activeTaskId}
        onOpenChange={(open) => {
          if (!open) setActiveTaskId(null);
        }}
        title={t("title")}
        description={<span>{displayLabel}</span>}
      />
    </div>
  );
}

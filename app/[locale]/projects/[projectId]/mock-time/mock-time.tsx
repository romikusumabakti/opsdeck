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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProjectWithServers } from "@/lib/db/schema";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

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
      <FieldGroup className="flex-row">
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
          <FieldLabel htmlFor="mock-time-hour">{t("timeLabel")}</FieldLabel>
          <div className="flex items-center gap-1">
            <Select
              value={String(hour)}
              onValueChange={(v) => setHour(Number(v))}
            >
              <SelectTrigger
                id="mock-time-hour"
                aria-label={t("hourLabel")}
                className="w-[4.5rem] tabular-nums"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {HOURS.map((h) => (
                  <SelectItem
                    key={h}
                    value={String(h)}
                    className="tabular-nums"
                  >
                    {pad(h)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span
              aria-hidden="true"
              className="text-muted-foreground select-none"
            >
              :
            </span>
            <Select
              value={String(minute)}
              onValueChange={(v) => setMinute(Number(v))}
            >
              <SelectTrigger
                aria-label={t("minuteLabel")}
                className="w-[4.5rem] tabular-nums"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {MINUTES.map((m) => (
                  <SelectItem
                    key={m}
                    value={String(m)}
                    className="tabular-nums"
                  >
                    {pad(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Field>
      </FieldGroup>
      <Button
        onClick={onSubmit}
        disabled={submitting}
        variant={isLegacy ? "destructive" : "default"}
        className="self-start"
      >
        <Clock className="size-4" />
        {submitting ? t("submitting") : t("submit")}
      </Button>
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

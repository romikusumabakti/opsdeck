"use client";

import { format } from "date-fns";
import { id as idLocale } from "date-fns/locale";
import { CalendarIcon, Clock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { simulateProjectTime } from "@/actions/simulate-time";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ProjectWithServers } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function timeString(d: Date) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function SimulateTime({ project }: { project: ProjectWithServers }) {
  const t = useTranslations("simulateTime");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const dateFnsLocale = locale === "id" ? idLocale : undefined;
  const dialog = useDialog();
  const [date, setDate] = React.useState<Date>(() => new Date());
  const [time, setTime] = React.useState<string>(() => timeString(new Date()));
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const isLegacy = !project.backendSimulateTimeApiUrl?.trim();

  const combined = React.useMemo(() => {
    const [h, m, s] = time.split(":").map((v) => parseInt(v, 10) || 0);
    const next = new Date(date);
    next.setHours(h, m, s, 0);
    return next;
  }, [date, time]);

  const displayLabel = format(combined, "PPP HH:mm:ss", {
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
      const result = await simulateProjectTime(project, combined.toISOString());
      if (!result.success) {
        toast.error(t("failureTitle"), { description: result.error });
        return;
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
    <div className="flex flex-col gap-3">
      <Label>{t("dateTimeLabel")}</Label>
      <div className="flex flex-col sm:flex-row gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={cn(
                "flex-1 justify-start font-normal",
                !date && "text-muted-foreground"
              )}
            >
              <CalendarIcon className="size-4" />
              {displayLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-0">
            <Calendar
              mode="single"
              selected={date}
              onSelect={(d) => {
                if (d) setDate(d);
              }}
              locale={dateFnsLocale}
              autoFocus
            />
            <div className="border-t p-3 flex items-center gap-2">
              <Clock className="size-4 text-muted-foreground" />
              <Input
                type="time"
                step={1}
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="flex-1"
              />
            </div>
          </PopoverContent>
        </Popover>
        <Button
          onClick={onSubmit}
          disabled={submitting}
          variant={isLegacy ? "destructive" : "default"}
          className="shrink-0"
        >
          <Clock className="size-4" />
          {submitting ? t("submitting") : t("submit")}
        </Button>
      </div>
    </div>
  );
}

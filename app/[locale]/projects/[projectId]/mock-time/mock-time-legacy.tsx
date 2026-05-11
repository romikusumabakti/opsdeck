"use client";

import { format } from "date-fns";
import { id as idLocale } from "date-fns/locale";
import { Clock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { mockProjectTimeLegacy } from "@/actions/mock-time";
import { useDialog } from "@/components/dialog-provider";
import { LiveTaskDialog } from "@/components/live-task-dialog";
import { Button } from "@/components/ui/button";
import type { ProjectWithServers } from "@/lib/db/schema";
import { DateTimePicker } from "./date-time-picker";

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
  const [submitting, setSubmitting] = React.useState(false);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);

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
      description: t("confirmDescriptionLegacy", { dateTime: displayLabel }),
      confirmText: t("submit"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;

    setSubmitting(true);
    try {
      const result = await mockProjectTimeLegacy(
        project,
        combined.toISOString()
      );
      if (!result.success) {
        toast.error(t("failureTitle"), { description: result.error });
        return;
      }
      setActiveTaskId(result.taskId);
      toast.success(t("successTitle"), {
        description: t("successDescriptionLegacy", { dateTime: displayLabel }),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-row items-end gap-4 flex-wrap">
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
        <Button onClick={onSubmit} disabled={submitting} variant="destructive">
          <Clock className="size-4" />
          {submitting ? t("submitting") : t("submit")}
        </Button>
      </div>
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

"use client";

import { format } from "date-fns";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { ChevronDownIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function TimeInput({
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
  return (
    <Input
      id={id}
      type="time"
      step={60}
      lang="en-GB"
      value={`${pad(hour)}:${pad(minute)}`}
      aria-label={ariaLabel}
      className="w-32 tabular-nums"
      onChange={(e) => {
        const v = e.target.value;
        if (!v) return;
        const [h, m] = v.split(":").map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) onChange(h, m);
      }}
    />
  );
}

export function DateTimePicker({
  date,
  hour,
  minute,
  onDateChange,
  onTimeChange,
  idPrefix,
}: {
  date: Date | undefined;
  hour: number;
  minute: number;
  onDateChange: (date: Date | undefined) => void;
  onTimeChange: (hour: number, minute: number) => void;
  idPrefix: string;
}) {
  const t = useTranslations("mockTime");
  const locale = useLocale();
  const dateFnsLocale = getDateFnsLocale(locale);
  const [open, setOpen] = React.useState(false);

  return (
    <FieldGroup className="flex-1 flex-row items-end gap-2">
      <Field className="flex-1">
        <FieldLabel htmlFor={`${idPrefix}-date`}>{t("dateLabel")}</FieldLabel>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              id={`${idPrefix}-date`}
              className="w-full justify-between font-normal"
            >
              {date
                ? format(date, "PPP", { locale: dateFnsLocale })
                : t("selectDate")}
              <ChevronDownIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto overflow-hidden p-0" align="start">
            <Calendar
              mode="single"
              selected={date}
              captionLayout="dropdown"
              defaultMonth={date}
              locale={dateFnsLocale}
              onSelect={(d) => {
                onDateChange(d);
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      </Field>
      <Field className="w-fit">
        <FieldLabel htmlFor={`${idPrefix}-time`}>{t("timeLabel")}</FieldLabel>
        <TimeInput
          id={`${idPrefix}-time`}
          hour={hour}
          minute={minute}
          onChange={onTimeChange}
          ariaLabel={t("timeLabel")}
        />
      </Field>
    </FieldGroup>
  );
}

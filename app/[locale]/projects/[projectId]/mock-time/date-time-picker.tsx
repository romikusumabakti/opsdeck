"use client";

import { format } from "date-fns";
import { id as idLocale } from "date-fns/locale";
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

function formatDigits(digits: string) {
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
}

function parseDigits(digits: string) {
  const h = Number(digits.slice(0, 2) || "0");
  const m = Number(digits.slice(2, 4) || "0");
  return { h, m, valid: digits.length > 0 && h <= 23 && m <= 59 };
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
  const dateFnsLocale = locale === "id" ? idLocale : undefined;
  const [open, setOpen] = React.useState(false);

  return (
    <FieldGroup className="flex-1 flex-row items-end gap-4">
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

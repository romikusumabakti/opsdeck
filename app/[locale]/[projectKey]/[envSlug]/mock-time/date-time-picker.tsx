"use client";

import { format } from "date-fns";
import { ChevronDownIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getDateFnsLocale } from "@/lib/date-fns-locale";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function TimeSegment({
  id,
  inputRef,
  value,
  max,
  ariaLabel,
  onChange,
  onFilled,
}: {
  id?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  value: number;
  max: number;
  ariaLabel: string;
  onChange: (value: number) => void;
  onFilled?: () => void;
}) {
  // Raw keystrokes while focused; the padded committed value otherwise.
  const [draft, setDraft] = React.useState<string | null>(null);
  return (
    <InputGroupInput
      id={id}
      ref={inputRef}
      inputMode="numeric"
      autoComplete="off"
      maxLength={2}
      aria-label={ariaLabel}
      value={draft ?? pad(value)}
      className="w-6 flex-none px-0 text-center tabular-nums"
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, "").slice(0, 2);
        setDraft(digits);
        if (digits) onChange(Math.min(Number(digits), max));
        if (digits.length === 2) onFilled?.();
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const step = e.key === "ArrowUp" ? 1 : -1;
        setDraft(null);
        onChange((value + step + max + 1) % (max + 1));
      }}
    />
  );
}

/**
 * Always 24-hour, unlike `<input type="time">`, which follows the OS locale
 * and can't be forced to match the HH:mm used everywhere else.
 */
export function TimeInput({
  id,
  hour,
  minute,
  onChange,
}: {
  id?: string;
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
}) {
  const t = useTranslations("mockTime");
  const minuteRef = React.useRef<HTMLInputElement>(null);
  return (
    <InputGroup className="w-fit gap-0.5 px-2.5">
      <TimeSegment
        id={id}
        value={hour}
        max={23}
        ariaLabel={t("hourLabel")}
        onChange={(h) => onChange(h, minute)}
        onFilled={() => minuteRef.current?.focus()}
      />
      <span className="text-muted-foreground">:</span>
      <TimeSegment
        inputRef={minuteRef}
        value={minute}
        max={59}
        ariaLabel={t("minuteLabel")}
        onChange={(m) => onChange(hour, m)}
      />
    </InputGroup>
  );
}

/** Rendered below the whole picker row so it doesn't skew field alignment. */
export function BrowserZoneHint() {
  const t = useTranslations("mockTime");
  // Resolved after mount: the server can't know the browser's zone.
  const [browserZone, setBrowserZone] = React.useState<string | null>(null);
  React.useEffect(() => {
    setBrowserZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  if (!browserZone) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {t("browserZone", { zone: browserZone })}
    </p>
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

  // react-day-picker's dropdown layout defaults its year range to end at the
  // current year, so future years are unselectable. Mock-time travel needs the
  // future, so widen the bounds explicitly.
  const currentYear = new Date().getFullYear();
  const startMonth = React.useMemo(() => new Date(2000, 0), []);
  const endMonth = React.useMemo(
    () => new Date(currentYear + 10, 11),
    [currentYear]
  );

  return (
    <FieldGroup className="flex-1 flex-row items-end gap-2">
      <Field className="flex-1">
        <FieldLabel htmlFor={`${idPrefix}-date`}>{t("dateLabel")}</FieldLabel>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                id={`${idPrefix}-date`}
                className="w-full justify-between font-normal"
              />
            }
          >
            {date
              ? format(date, "PPP", { locale: dateFnsLocale })
              : t("selectDate")}
            <ChevronDownIcon />
          </PopoverTrigger>
          <PopoverContent className="w-auto overflow-hidden p-0" align="start">
            <Calendar
              mode="single"
              selected={date}
              captionLayout="dropdown"
              defaultMonth={date}
              startMonth={startMonth}
              endMonth={endMonth}
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
        />
      </Field>
    </FieldGroup>
  );
}

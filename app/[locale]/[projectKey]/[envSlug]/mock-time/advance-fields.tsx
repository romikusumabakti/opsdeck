"use client";

import { FastForward } from "lucide-react";
import { useTranslations } from "next-intl";
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
import type { AdvanceDirection, AdvanceUnit } from "./duration";

export function AdvanceFields({
  idPrefix,
  amount,
  unit,
  direction,
  disabled,
  submitting,
  onAmountChange,
  onUnitChange,
  onDirectionChange,
  onSubmit,
}: {
  idPrefix: string;
  amount: string;
  unit: AdvanceUnit;
  direction: AdvanceDirection;
  disabled: boolean;
  submitting: boolean;
  onAmountChange: (value: string) => void;
  onUnitChange: (value: AdvanceUnit) => void;
  onDirectionChange: (value: AdvanceDirection) => void;
  onSubmit: () => void;
}) {
  const t = useTranslations("mockTime");

  return (
    <FieldGroup className="flex-row items-end gap-2 flex-wrap">
      <Field className="flex-1">
        <FieldLabel htmlFor={`${idPrefix}-advance-amount`}>
          {t("advance.amountLabel")}
        </FieldLabel>
        <Input
          id={`${idPrefix}-advance-amount`}
          type="number"
          min={1}
          step={1}
          value={amount}
          onChange={(e) => onAmountChange(e.target.value)}
          disabled={disabled}
          className="tabular-nums"
        />
      </Field>
      <Field className="flex-1">
        <FieldLabel htmlFor={`${idPrefix}-advance-unit`}>
          {t("advance.unitLabel")}
        </FieldLabel>
        <Select
          value={unit}
          onValueChange={(v) => onUnitChange(v as AdvanceUnit)}
          disabled={disabled}
        >
          <SelectTrigger id={`${idPrefix}-advance-unit`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="minutes">
              {t("advance.units.minutes")}
            </SelectItem>
            <SelectItem value="hours">{t("advance.units.hours")}</SelectItem>
            <SelectItem value="days">{t("advance.units.days")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field className="flex-1">
        <FieldLabel htmlFor={`${idPrefix}-advance-direction`}>
          {t("advance.directionLabel")}
        </FieldLabel>
        <Select
          value={direction}
          onValueChange={(v) => onDirectionChange(v as AdvanceDirection)}
          disabled={disabled}
        >
          <SelectTrigger id={`${idPrefix}-advance-direction`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="forward">{t("advance.forward")}</SelectItem>
            <SelectItem value="backward">{t("advance.backward")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Button onClick={onSubmit} disabled={disabled}>
        <FastForward className="size-4" />
        {submitting ? t("advance.submitting") : t("advance.submit")}
      </Button>
    </FieldGroup>
  );
}

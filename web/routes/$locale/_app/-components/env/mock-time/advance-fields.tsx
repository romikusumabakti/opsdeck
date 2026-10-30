import { FastForward, Rewind } from "lucide-react";
import { useTranslations } from "use-intl";
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
  disabled,
  submitting,
  onAmountChange,
  onUnitChange,
  onSubmit,
}: {
  idPrefix: string;
  amount: string;
  unit: AdvanceUnit;
  disabled: boolean;
  /** The direction whose request is in flight, if any. */
  submitting: AdvanceDirection | null;
  onAmountChange: (value: string) => void;
  onUnitChange: (value: AdvanceUnit) => void;
  onSubmit: (direction: AdvanceDirection) => void;
}) {
  const t = useTranslations("mockTime");

  return (
    <FieldGroup className="flex-row items-end gap-2 flex-wrap">
      <Field className="w-28">
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
      <Field className="w-32">
        <FieldLabel htmlFor={`${idPrefix}-advance-unit`}>
          {t("advance.unitLabel")}
        </FieldLabel>
        <Select
          value={unit}
          onValueChange={(v) => onUnitChange(v as AdvanceUnit)}
          disabled={disabled}
        >
          <SelectTrigger id={`${idPrefix}-advance-unit`} className="w-full">
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
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => onSubmit("backward")}
          disabled={disabled}
        >
          <Rewind className="size-4" />
          {submitting === "backward"
            ? t("advance.submitting")
            : t("advance.backward")}
        </Button>
        <Button
          variant="outline"
          onClick={() => onSubmit("forward")}
          disabled={disabled}
        >
          {submitting === "forward"
            ? t("advance.submitting")
            : t("advance.forward")}
          <FastForward className="size-4" />
        </Button>
      </div>
    </FieldGroup>
  );
}

import * as React from "react";
import { useTranslations } from "use-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export type TemplateConflictOption = {
  componentKeys: string[];
  kind: "plain" | "secret" | "generated";
  defaultValue: string | null;
};

export type TemplateConflict = {
  name: string;
  required: boolean;
  options: TemplateConflictOption[];
};

/**
 * Fill from template, second step: the names the environment's services
 * define differently (kind or default). One definition is picked per
 * variable, by the first service giving it; required and escrow still follow
 * the strictest service whichever is picked. A name left unpicked stays
 * unfilled.
 */
export function TemplateConflictsDialog({
  conflicts,
  busy,
  onFill,
  onOpenChange,
}: {
  /** Open while non-null. */
  conflicts: TemplateConflict[] | null;
  busy: boolean;
  onFill: (choices: Record<string, string>) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("variables.conflicts");
  const tVariables = useTranslations("variables");
  const [choices, setChoices] = React.useState<Record<string, string>>({});
  const [syncedFrom, setSyncedFrom] = React.useState(conflicts);
  // A new list starts with nothing picked.
  if (syncedFrom !== conflicts) {
    setSyncedFrom(conflicts);
    setChoices({});
  }
  const picked = Object.keys(choices).length;

  return (
    <Dialog open={conflicts !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("escrowNote")}</p>
        <div className="flex flex-col gap-5">
          {(conflicts ?? []).map((conflict) => (
            <FieldSet key={conflict.name}>
              <FieldLegend variant="label" className="flex items-center gap-2">
                <code className="font-mono text-sm">{conflict.name}</code>
                {conflict.required && (
                  <Badge variant="secondary">{t("required")}</Badge>
                )}
              </FieldLegend>
              <RadioGroup
                aria-label={conflict.name}
                value={choices[conflict.name] ?? null}
                onValueChange={(value) =>
                  setChoices((prev) => ({
                    ...prev,
                    [conflict.name]: String(value),
                  }))
                }
              >
                {conflict.options.map((option) => {
                  const value = option.componentKeys[0] ?? "";
                  const id = `conflict-${conflict.name}-${value}`;
                  return (
                    <label
                      key={value}
                      htmlFor={id}
                      className="flex items-start gap-2 text-sm"
                    >
                      <RadioGroupItem
                        id={id}
                        value={value}
                        className="mt-0.5"
                      />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-mono">
                          {option.componentKeys.join(", ")}
                        </span>
                        <span className="text-muted-foreground">
                          {tVariables(`kind.${option.kind}`)}
                          {option.kind === "plain" &&
                            ` · ${
                              option.defaultValue === null
                                ? t("noDefault")
                                : t("default", { value: option.defaultValue })
                            }`}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </RadioGroup>
            </FieldSet>
          ))}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t("skip")}
          </Button>
          <Button
            disabled={busy || picked === 0}
            onClick={() => onFill(choices)}
          >
            {t("fill")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

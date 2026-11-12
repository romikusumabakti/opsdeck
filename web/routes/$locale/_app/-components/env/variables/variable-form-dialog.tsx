import { zodResolver } from "@hookform/resolvers/zod";
import { Lock } from "lucide-react";
import * as React from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { useDialog } from "@/components/dialog-provider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  ESCROW_REMOVAL_MESSAGE,
  ESCROWED_MESSAGE,
  NO_APP_MESSAGE,
  NOT_GENERATED_MESSAGE,
  RESERVED_PREFIX_MESSAGE,
  SECRET_TO_PLAIN_MESSAGE,
} from "@/lib/variables/errors";
import {
  hasReservedPrefix,
  variableNameSchema,
  variableValueSchema,
} from "@/lib/variables/validation";
import { ApiError } from "@/web/api/client";
import { putVariable, type VariableRow } from "@/web/api/variables";

export const VARIABLE_KINDS = ["plain", "secret", "generated"] as const;
type Kind = (typeof VARIABLE_KINDS)[number];

/** Localized text for a variables API failure (the API's messages are English). */
export function useVariableErrorText() {
  const t = useTranslations("variables");
  const tCommon = useTranslations("common");
  return (error: unknown): string => {
    if (error instanceof ApiError) {
      switch (error.message) {
        case ESCROWED_MESSAGE:
          return t("escrowedError");
        case ESCROW_REMOVAL_MESSAGE:
          return t("escrowRemovalError");
        case NOT_GENERATED_MESSAGE:
          return t("notGeneratedError");
        case NO_APP_MESSAGE:
          return t("noAppHint");
        case SECRET_TO_PLAIN_MESSAGE:
          return t("form.valueRequiredForPlain");
        case RESERVED_PREFIX_MESSAGE:
          return t("form.nameReservedPrefix");
      }
      return error.message;
    }
    return error instanceof Error ? error.message : tCommon("errorGeneric");
  };
}

type Values = { name: string; kind: Kind; value: string; escrow: boolean };

function defaults(variable: VariableRow | null): Values {
  return {
    name: variable?.name ?? "",
    kind: variable?.kind ?? "plain",
    // Secret and generated values are never in the listing; leaving the field
    // empty keeps the stored value.
    value: variable?.kind === "plain" ? (variable.value ?? "") : "",
    escrow: variable?.escrow ?? false,
  };
}

/** Add a variable (`variable` null) or edit one. */
export function VariableFormDialog({
  open,
  onOpenChange,
  environmentId,
  variable,
  canClearEscrow,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  variable: VariableRow | null;
  canClearEscrow: boolean;
}) {
  const t = useTranslations("variables");
  const tForm = useTranslations("variables.form");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const errorText = useVariableErrorText();
  const escrowed = variable?.escrow ?? false;

  const schema = z
    .object({
      name: z
        .string()
        .trim()
        .min(1, tCommon("required"))
        .refine(
          (name) =>
            hasReservedPrefix(name) ||
            variableNameSchema().safeParse(name).success,
          tForm("nameInvalid")
        )
        .refine(
          (name) => !hasReservedPrefix(name),
          tForm("nameReservedPrefix")
        ),
      kind: z.enum(VARIABLE_KINDS),
      value: z
        .string()
        .refine(
          (value) => variableValueSchema.safeParse(value).success,
          tForm("valueInvalid")
        ),
      escrow: z.boolean(),
    })
    .refine(
      // A new secret needs its value; plain may be empty, generated is made.
      (values) =>
        variable !== null || values.kind !== "secret" || values.value !== "",
      { path: ["value"], message: tCommon("required") }
    )
    .refine(
      // Turning a secret or generated variable plain needs its new value:
      // an empty one would replace the secret with "" (the API refuses it).
      (values) =>
        variable === null ||
        variable.kind === "plain" ||
        values.kind !== "plain" ||
        values.value !== "",
      { path: ["value"], message: tForm("valueRequiredForPlain") }
    );

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: defaults(variable),
  });

  React.useEffect(() => {
    if (open) form.reset(defaults(variable));
  }, [open, variable, form]);

  const kind = form.watch("kind");

  async function onSubmit(values: Values) {
    // Empty keeps the stored secret (or generates a new generated value);
    // a plain value is sent as typed, empty included.
    const value =
      values.kind === "plain" || values.value !== "" ? values.value : undefined;
    try {
      await putVariable(environmentId, values.name.trim(), {
        kind: values.kind,
        value,
        escrow: values.escrow,
      });
      toast.success(tForm("saved", { name: values.name.trim() }));
      onOpenChange(false);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 400 &&
        error.message === RESERVED_PREFIX_MESSAGE
      ) {
        form.setError("name", { message: tForm("nameReservedPrefix") });
      } else if (error instanceof ApiError && error.status === 400) {
        form.setError("value", { message: error.message });
      } else {
        toast.error(errorText(error));
      }
    }
  }

  async function onClearEscrow() {
    if (!variable) return;
    const ok = await dialog.confirm({
      title: tForm("clearEscrowConfirmTitle", { name: variable.name }),
      description: tForm("clearEscrowConfirmDescription"),
      confirmText: tForm("clearEscrow"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await putVariable(environmentId, variable.name, {
        kind: variable.kind,
        escrow: false,
        confirmEscrowRemoval: true,
      });
      toast.success(tForm("escrowCleared", { name: variable.name }));
      onOpenChange(false);
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  const valueHint =
    kind === "generated"
      ? tForm(variable ? "valueHintGeneratedKeep" : "valueHintGenerated")
      : kind === "secret" && variable
        ? tForm("valueHintSecretKeep")
        : tForm("valueHint");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {variable
              ? tForm("editTitle", { name: variable.name })
              : tForm("createTitle")}
          </DialogTitle>
          <DialogDescription>{tForm("description")}</DialogDescription>
        </DialogHeader>
        {escrowed && (
          <Alert>
            <Lock />
            <AlertDescription>{t("escrowWarning")}</AlertDescription>
          </Alert>
        )}
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-col gap-4"
        >
          <FieldGroup>
            <Controller
              name="name"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="variable-name">
                    {tForm("name")}
                  </FieldLabel>
                  <Input
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    placeholder="DB_PASSWORD"
                    disabled={variable !== null}
                    {...field}
                    id="variable-name"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>{tForm("nameHint")}</FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              name="kind"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="variable-kind">
                    {tForm("kind")}
                  </FieldLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => field.onChange(value ?? "plain")}
                    disabled={escrowed}
                  >
                    <SelectTrigger
                      id="variable-kind"
                      aria-invalid={fieldState.invalid}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VARIABLE_KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {t(`kind.${k}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {tForm(`kindHint.${kind}`)}
                  </FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              name="value"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="variable-value">
                    {tForm("value")}
                  </FieldLabel>
                  <Input
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    type={kind === "plain" ? "text" : "password"}
                    disabled={escrowed}
                    {...field}
                    id="variable-value"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>{valueHint}</FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              name="escrow"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field
                  orientation="horizontal"
                  data-invalid={fieldState.invalid}
                >
                  <Switch
                    id="variable-escrow"
                    aria-invalid={fieldState.invalid}
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    // Escrow is only ever cleared explicitly (below).
                    disabled={escrowed}
                  />
                  <FieldContent>
                    <FieldLabel
                      htmlFor="variable-escrow"
                      className="font-normal"
                    >
                      {tForm("escrow")}
                    </FieldLabel>
                    <FieldDescription>{tForm("escrowHint")}</FieldDescription>
                  </FieldContent>
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            {escrowed && canClearEscrow && (
              <Button
                type="button"
                variant="destructive"
                className="sm:me-auto"
                onClick={() => void onClearEscrow()}
              >
                {tForm("clearEscrow")}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={escrowed || form.formState.isSubmitting}
            >
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

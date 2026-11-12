import { zodResolver } from "@hookform/resolvers/zod";
import * as React from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
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
import { RESERVED_PREFIX_MESSAGE } from "@/lib/variables/errors";
import {
  hasReservedPrefix,
  variableNameSchema,
  variableValueSchema,
} from "@/lib/variables/validation";
import { ApiError } from "@/web/api/client";
import {
  putVariableTemplate,
  type VariableTemplateRow,
} from "@/web/api/variables";
import { VARIABLE_KINDS } from "../env/variables/variable-form-dialog";

type Kind = (typeof VARIABLE_KINDS)[number];

// Must match server/services/variables.ts (GENERATED_LENGTH_MIN/MAX).
const LENGTH_MIN = 16;
const LENGTH_MAX = 128;

type Values = {
  name: string;
  kind: Kind;
  required: boolean;
  defaultValue: string;
  generatedLength: string;
  escrow: boolean;
  description: string;
};

function defaults(template: VariableTemplateRow | null): Values {
  return {
    name: template?.name ?? "",
    kind: template?.kind ?? "plain",
    required: template?.required ?? false,
    defaultValue: template?.defaultValue ?? "",
    generatedLength:
      template?.generatedLength == null ? "" : String(template.generatedLength),
    escrow: template?.escrow ?? false,
    description: template?.description ?? "",
  };
}

/** Add a variable template (`template` null) or edit one. */
export function TemplateFormDialog({
  open,
  onOpenChange,
  appKey,
  template,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appKey: string;
  template: VariableTemplateRow | null;
}) {
  const t = useTranslations("variableTemplates.form");
  const tVariables = useTranslations("variables");
  const tCommon = useTranslations("common");

  const schema = z.object({
    name: z
      .string()
      .trim()
      .min(1, tCommon("required"))
      .refine(
        (name) =>
          hasReservedPrefix(name) ||
          variableNameSchema().safeParse(name).success,
        t("nameInvalid")
      )
      .refine((name) => !hasReservedPrefix(name), t("nameReservedPrefix")),
    kind: z.enum(VARIABLE_KINDS),
    required: z.boolean(),
    defaultValue: z
      .string()
      .refine(
        (value) => variableValueSchema.safeParse(value).success,
        t("defaultInvalid")
      ),
    generatedLength: z.string().refine(
      (value) => {
        if (value.trim() === "") return true;
        const n = Number(value);
        return Number.isInteger(n) && n >= LENGTH_MIN && n <= LENGTH_MAX;
      },
      t("lengthInvalid", { min: LENGTH_MIN, max: LENGTH_MAX })
    ),
    escrow: z.boolean(),
    description: z.string().max(500),
  });

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: defaults(template),
  });

  React.useEffect(() => {
    if (open) form.reset(defaults(template));
  }, [open, template, form]);

  const kind = form.watch("kind");

  async function onSubmit(values: Values) {
    // Only the field the kind uses is sent (the API refuses the others).
    const name = values.name.trim();
    try {
      await putVariableTemplate(appKey, name, {
        kind: values.kind,
        required: values.required,
        defaultValue:
          values.kind === "plain" && values.defaultValue !== ""
            ? values.defaultValue
            : null,
        generatedLength:
          values.kind === "generated" && values.generatedLength.trim() !== ""
            ? Number(values.generatedLength)
            : null,
        escrow: values.escrow,
        description: values.description.trim() || null,
      });
      toast.success(t("saved", { name }));
      onOpenChange(false);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.message === RESERVED_PREFIX_MESSAGE
      ) {
        form.setError("name", { message: t("nameReservedPrefix") });
        return;
      }
      toast.error(
        error instanceof ApiError ? error.message : tCommon("errorGeneric")
      );
    }
  }

  const toggle = (name: "required" | "escrow") => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <Field orientation="horizontal" data-invalid={fieldState.invalid}>
          <Switch
            id={`template-${name}`}
            aria-invalid={fieldState.invalid}
            checked={field.value}
            onCheckedChange={field.onChange}
          />
          <FieldContent>
            <FieldLabel htmlFor={`template-${name}`} className="font-normal">
              {t(name)}
            </FieldLabel>
            <FieldDescription>{t(`${name}Hint`)}</FieldDescription>
          </FieldContent>
        </Field>
      )}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {template
              ? t("editTitle", { name: template.name })
              : t("createTitle")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
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
                  <FieldLabel htmlFor="template-name">{t("name")}</FieldLabel>
                  <Input
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    placeholder="APP_URL"
                    disabled={template !== null}
                    {...field}
                    id="template-name"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              name="kind"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="template-kind">{t("kind")}</FieldLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => field.onChange(value ?? "plain")}
                  >
                    <SelectTrigger
                      id="template-kind"
                      aria-invalid={fieldState.invalid}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VARIABLE_KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {tVariables(`kind.${k}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            {kind === "plain" && (
              <Controller
                name="defaultValue"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="template-default-value">
                      {t("defaultValue")}
                    </FieldLabel>
                    <Input
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono"
                      placeholder="{url}/api"
                      {...field}
                      id="template-default-value"
                      aria-invalid={fieldState.invalid}
                    />
                    <FieldDescription>{t("defaultValueHint")}</FieldDescription>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
            )}
            {kind === "generated" && (
              <Controller
                name="generatedLength"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="template-generated-length">
                      {t("generatedLength")}
                    </FieldLabel>
                    <Input
                      inputMode="numeric"
                      placeholder="32"
                      {...field}
                      id="template-generated-length"
                      aria-invalid={fieldState.invalid}
                    />
                    <FieldDescription>
                      {t("generatedLengthHint", {
                        min: LENGTH_MIN,
                        max: LENGTH_MAX,
                      })}
                    </FieldDescription>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
            )}
            {toggle("required")}
            {toggle("escrow")}
            <Controller
              name="description"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="template-description">
                    {t("descriptionLabel")}
                  </FieldLabel>
                  <Input
                    autoComplete="off"
                    {...field}
                    id="template-description"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

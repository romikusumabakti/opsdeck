import { zodResolver } from "@hookform/resolvers/zod";
import * as React from "react";
import { useForm } from "react-hook-form";
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
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
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
        (name) => variableNameSchema().safeParse(name).success,
        t("nameInvalid")
      ),
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
      toast.error(
        error instanceof ApiError ? error.message : tCommon("errorGeneric")
      );
    }
  }

  const toggle = (name: "required" | "escrow") => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <div className="flex items-center gap-2">
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
            <FormLabel className="font-normal">{t(name)}</FormLabel>
          </div>
          <FormDescription>{t(`${name}Hint`)}</FormDescription>
        </FormItem>
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
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("name")}</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono"
                      placeholder="APP_URL"
                      disabled={template !== null}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("kind")}</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => field.onChange(value ?? "plain")}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {VARIABLE_KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {tVariables(`kind.${k}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {kind === "plain" && (
              <FormField
                control={form.control}
                name="defaultValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("defaultValue")}</FormLabel>
                    <FormControl>
                      <Input
                        autoComplete="off"
                        spellCheck={false}
                        className="font-mono"
                        placeholder="{url}/api"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>{t("defaultValueHint")}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {kind === "generated" && (
              <FormField
                control={form.control}
                name="generatedLength"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("generatedLength")}</FormLabel>
                    <FormControl>
                      <Input inputMode="numeric" placeholder="32" {...field} />
                    </FormControl>
                    <FormDescription>
                      {t("generatedLengthHint", {
                        min: LENGTH_MIN,
                        max: LENGTH_MAX,
                      })}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {toggle("required")}
            {toggle("escrow")}
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("descriptionLabel")}</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
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
        </Form>
      </DialogContent>
    </Dialog>
  );
}

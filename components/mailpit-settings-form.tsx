import { zodResolver } from "@hookform/resolvers/zod";
import { PlugZap } from "lucide-react";
import { useTransition } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import {
  type MailpitSettings,
  saveMailpitSettings,
  testMailpitConnection,
} from "@/web/api/mailpit-settings";

export function MailpitSettingsForm({
  environmentId,
  settings,
}: {
  environmentId: string;
  settings: MailpitSettings | null;
}) {
  const t = useTranslations("mailpitSettings");
  const tCommon = useTranslations("common");
  const [testing, startTesting] = useTransition();

  const schema = z.object({
    url: z.union([
      z.literal(""),
      z
        .string()
        .trim()
        .url(tCommon("urlInvalid"))
        .refine((v) => /^https?:\/\//i.test(v), tCommon("urlInvalid")),
    ]),
    username: z.string(),
    // Blank = keep the stored password (see actions/mailpit-settings).
    password: z.string(),
  });
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      url: settings?.url ?? "",
      username: settings?.username ?? "",
      password: "",
    },
  });
  const url = useWatch({ control: form.control, name: "url" });
  const username = useWatch({ control: form.control, name: "username" });
  // The server keeps the stored password only while the URL is unchanged and a
  // username remains (see actions/mailpit-settings).
  const keepsPassword =
    url.trim() === settings?.url && username.trim().length > 0;
  const saving = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !saving);

  function payload(values: Values) {
    return {
      url: values.url.trim(),
      username: values.username.trim() || null,
      password: values.password || undefined,
    };
  }

  async function onSubmit(values: Values) {
    const result = await saveMailpitSettings(environmentId, payload(values));
    if (!result.success) {
      toast.error(result.message || t("saveFailed"));
      return;
    }
    toast.success(values.url.trim() ? t("saved") : t("removed"));
    form.reset({ ...values, password: "" });
  }

  function onTest() {
    startTesting(async () => {
      if (!(await form.trigger("url"))) return;
      const result = await testMailpitConnection(
        environmentId,
        payload(form.getValues())
      );
      if (result.success) {
        toast.success(
          t("testOk", {
            version: result.data.version,
            count: result.data.messages,
          })
        );
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup>
        <Controller
          name="url"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="mailpit-url">{t("url")}</FieldLabel>
              <Input
                type="url"
                placeholder="https://mail-qa.example.com/"
                {...field}
                id="mailpit-url"
                aria-invalid={fieldState.invalid}
              />
              <p className="text-xs text-muted-foreground">{t("urlHint")}</p>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Controller
            name="username"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="mailpit-username">
                  {t("username")}
                </FieldLabel>
                <Input
                  autoComplete="off"
                  {...field}
                  id="mailpit-username"
                  aria-invalid={fieldState.invalid}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          <Controller
            name="password"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="mailpit-password">
                  {t("password")}
                </FieldLabel>
                <PasswordInput
                  autoComplete="new-password"
                  placeholder={
                    settings?.hasPassword && keepsPassword
                      ? t("passwordKeepPlaceholder")
                      : ""
                  }
                  {...field}
                  id="mailpit-password"
                  aria-invalid={fieldState.invalid}
                />
                {settings?.hasPassword && !keepsPassword && (
                  <p className="text-xs text-muted-foreground">
                    {t("passwordReenter")}
                  </p>
                )}
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("authHint")}</p>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onTest}
            disabled={testing || saving || !url.trim()}
          >
            <PlugZap className="size-4" />
            {testing ? t("testing") : t("test")}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

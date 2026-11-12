import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/password-input";
import { PasswordStrength } from "@/components/ui/password-strength";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { authClient } from "@/lib/auth-client";
import { resetSession } from "@/web/api/session";

export function ChangePasswordForm() {
  const t = useTranslations("changePassword");
  const tCommon = useTranslations("common");

  const schema = z
    .object({
      currentPassword: z.string().min(1, tCommon("required")),
      newPassword: z.string().min(8, tCommon("passwordTooShort", { min: 8 })),
      confirm: z.string(),
      revokeOther: z.boolean(),
    })
    .refine((d) => d.newPassword === d.confirm, {
      message: t("passwordMismatch"),
      path: ["confirm"],
    });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirm: "",
      revokeOther: false,
    },
  });

  useUnsavedChanges(form.formState.isDirty && !form.formState.isSubmitting);

  async function onSubmit(values: z.infer<typeof schema>) {
    const { error } = await authClient.changePassword({
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
      revokeOtherSessions: values.revokeOther,
    });

    if (error) {
      toast.error(error.message ?? t("errorGeneric"));
      return;
    }

    toast.success(t("success"));
    form.reset({
      currentPassword: "",
      newPassword: "",
      confirm: "",
      revokeOther: values.revokeOther,
    });
    // Revoking the other sessions makes better-auth issue this browser a new
    // one, so drop everything cached under the old session.
    if (values.revokeOther) await resetSession();
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup>
        <Controller
          name="currentPassword"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="change-password-current">
                {t("currentPassword")}
              </FieldLabel>
              <PasswordInput
                autoComplete="current-password"
                {...field}
                id="change-password-current"
                aria-invalid={fieldState.invalid}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="newPassword"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="change-password-new">
                {t("newPassword")}
              </FieldLabel>
              <PasswordInput
                autoComplete="new-password"
                {...field}
                id="change-password-new"
                aria-invalid={fieldState.invalid}
              />
              <PasswordStrength value={field.value} />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="confirm"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="change-password-confirm">
                {t("confirmPassword")}
              </FieldLabel>
              <PasswordInput
                autoComplete="new-password"
                {...field}
                id="change-password-confirm"
                aria-invalid={fieldState.invalid}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="revokeOther"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field orientation="horizontal" data-invalid={fieldState.invalid}>
              <Checkbox
                id="change-password-revoke-other"
                name={field.name}
                checked={field.value}
                aria-invalid={fieldState.invalid}
                onCheckedChange={(checked) => field.onChange(checked === true)}
              />
              <FieldLabel
                htmlFor="change-password-revoke-other"
                className="font-normal"
              >
                {t("revokeOtherSessions")}
              </FieldLabel>
            </Field>
          )}
        />
        <Button
          type="submit"
          disabled={form.formState.isSubmitting}
          className="self-start"
        >
          {form.formState.isSubmitting ? t("submitting") : t("submit")}
        </Button>
      </FieldGroup>
    </form>
  );
}

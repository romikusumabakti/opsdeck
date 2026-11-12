import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/password-input";
import { PasswordStrength } from "@/components/ui/password-strength";
import { useRouter } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";

export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations("resetPassword");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const schema = z
    .object({
      password: z.string().min(8, tCommon("passwordTooShort", { min: 8 })),
      confirm: z.string(),
    })
    .refine((d) => d.password === d.confirm, {
      message: t("passwordMismatch"),
      path: ["confirm"],
    });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { password: "", confirm: "" },
    mode: "onTouched",
    reValidateMode: "onChange",
  });

  async function onSubmit(values: z.infer<typeof schema>) {
    setSubmitError(null);
    const { error } = await authClient.resetPassword({
      newPassword: values.password,
      token,
    });

    if (error) {
      setSubmitError(error.message ?? tCommon("errorGeneric"));
      return;
    }

    toast.success(t("success"));
    router.push("/sign-in");
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup>
        {submitError && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}
        <Controller
          name="password"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="reset-password-password">
                {t("newPassword")}
              </FieldLabel>
              <PasswordInput
                autoComplete="new-password"
                {...field}
                id="reset-password-password"
                aria-invalid={fieldState.invalid}
                onChange={(e) => {
                  setSubmitError(null);
                  field.onChange(e);
                }}
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
              <FieldLabel htmlFor="reset-password-confirm">
                {t("confirmPassword")}
              </FieldLabel>
              <PasswordInput
                autoComplete="new-password"
                {...field}
                id="reset-password-confirm"
                aria-invalid={fieldState.invalid}
                onChange={(e) => {
                  setSubmitError(null);
                  field.onChange(e);
                }}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? t("submitting") : t("submit")}
        </Button>
      </FieldGroup>
    </form>
  );
}

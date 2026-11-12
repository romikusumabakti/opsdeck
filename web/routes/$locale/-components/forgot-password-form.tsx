import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert, CircleCheck } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useLocale, useTranslations } from "use-intl";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";

export function ForgotPasswordForm() {
  const t = useTranslations("forgotPassword");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const schema = z.object({
    email: z.string().email(tCommon("emailInvalid")),
  });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
    mode: "onTouched",
    reValidateMode: "onChange",
  });

  async function onSubmit(values: z.infer<typeof schema>) {
    setSubmitError(null);
    const { error } = await authClient.requestPasswordReset({
      email: values.email,
      redirectTo: `/${locale}/reset-password`,
    });

    if (error) {
      setSubmitError(error.message ?? tCommon("errorGeneric"));
      return;
    }

    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="flex flex-col gap-4">
        <Alert>
          <CircleCheck />
          <AlertDescription>{t("successMessage")}</AlertDescription>
        </Alert>
        <Button
          render={<Link href="/sign-in" />}
          nativeButton={false}
          variant="outline"
        >
          {t("backToSignIn")}
        </Button>
      </div>
    );
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
          name="email"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="forgot-password-email">
                {t("email")}
              </FieldLabel>
              <Input
                type="email"
                autoComplete="email"
                placeholder={t("emailPlaceholder")}
                {...field}
                id="forgot-password-email"
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
        <Link
          href="/sign-in"
          className="text-sm text-muted-foreground hover:text-foreground text-center"
        >
          {t("backToSignIn")}
        </Link>
      </FieldGroup>
    </form>
  );
}

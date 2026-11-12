import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
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
import { PasswordStrength } from "@/components/ui/password-strength";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useRouter } from "@/i18n/navigation";
import { authClient } from "@/lib/auth-client";
import { resetSession } from "@/web/api/session";
import { createInitialUser } from "@/web/api/users";

export function SetupForm() {
  const t = useTranslations("setup");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const schema = z
    .object({
      name: z.string().min(1, tCommon("required")),
      email: z.string().email(tCommon("emailInvalid")),
      password: z.string().min(8, tCommon("passwordTooShort", { min: 8 })),
      confirm: z.string(),
    })
    .refine((d) => d.password === d.confirm, {
      message: t("passwordMismatch"),
      path: ["confirm"],
    });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", password: "", confirm: "" },
    // Match the rest of the unauthenticated forms: validate a field on blur,
    // then keep it live while the user corrects it.
    mode: "onTouched",
    reValidateMode: "onChange",
  });

  useUnsavedChanges(form.formState.isDirty && !form.formState.isSubmitting);

  async function onSubmit(values: z.infer<typeof schema>) {
    const result = await createInitialUser({
      name: values.name,
      email: values.email,
      password: values.password,
    });

    if (!result.success) {
      toast.error(result.message);
      return;
    }

    const { error: signInErr } = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    });

    if (signInErr) {
      router.push("/sign-in");
      return;
    }

    await resetSession();
    router.push("/");
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup>
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="setup-name">{t("name")}</FieldLabel>
              <Input
                placeholder={t("namePlaceholder")}
                {...field}
                id="setup-name"
                aria-invalid={fieldState.invalid}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="email"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="setup-email">{t("email")}</FieldLabel>
              <Input
                type="email"
                autoComplete="email"
                placeholder={t("emailPlaceholder")}
                {...field}
                id="setup-email"
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
              <FieldLabel htmlFor="setup-password">{t("password")}</FieldLabel>
              <PasswordInput
                autoComplete="new-password"
                {...field}
                id="setup-password"
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
              <FieldLabel htmlFor="setup-confirm">
                {t("confirmPassword")}
              </FieldLabel>
              <PasswordInput
                autoComplete="new-password"
                {...field}
                id="setup-confirm"
                aria-invalid={fieldState.invalid}
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

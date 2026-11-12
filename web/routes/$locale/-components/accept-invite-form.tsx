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
import { acceptInvitation } from "@/web/api/users";

export function AcceptInviteForm({
  token,
  email,
  name,
}: {
  token: string;
  email: string;
  name: string;
}) {
  const t = useTranslations("acceptInvite");
  const tCommon = useTranslations("common");
  const router = useRouter();

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

  useUnsavedChanges(form.formState.isDirty && !form.formState.isSubmitting);

  async function onSubmit(values: z.infer<typeof schema>) {
    const result = await acceptInvitation({ token, password: values.password });

    if (!result.success) {
      toast.error(result.message);
      return;
    }

    const { error: signInErr } = await authClient.signIn.email({
      email,
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
        <Field>
          <FieldLabel htmlFor="accept-invite-name">{t("name")}</FieldLabel>
          <Input id="accept-invite-name" value={name} disabled />
        </Field>
        <Field>
          <FieldLabel htmlFor="accept-invite-email">{t("email")}</FieldLabel>
          <Input id="accept-invite-email" value={email} disabled />
        </Field>
        <Controller
          name="password"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="accept-invite-password">
                {t("newPassword")}
              </FieldLabel>
              <PasswordInput
                autoComplete="new-password"
                {...field}
                id="accept-invite-password"
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
              <FieldLabel htmlFor="accept-invite-confirm">
                {t("confirmPassword")}
              </FieldLabel>
              <PasswordInput
                autoComplete="new-password"
                {...field}
                id="accept-invite-confirm"
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

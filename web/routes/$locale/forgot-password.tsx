import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { AuthShell } from "@/components/auth-shell";
import { redirect } from "@/i18n/navigation";
import { meQuery } from "@/web/api/session";
import { ForgotPasswordForm } from "./-components/forgot-password-form";

export const Route = createFileRoute("/$locale/forgot-password")({
  beforeLoad: async ({ params: { locale }, context: { queryClient } }) => {
    if (await queryClient.query(meQuery())) redirect("/", locale);
  },
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const t = useTranslations("forgotPassword");
  return (
    <AuthShell title={t("title")} description={t("description")}>
      <ForgotPasswordForm />
    </AuthShell>
  );
}

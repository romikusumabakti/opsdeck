import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthShell } from "@/components/auth-shell";
import { redirect } from "@/i18n/navigation";
import { getServerSession } from "@/lib/auth-session";
import { ForgotPasswordForm } from "./forgot-password-form";

export default async function ForgotPasswordPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await getServerSession();
  if (session) {
    await redirect("/");
  }

  const t = await getTranslations("forgotPassword");

  return (
    <AuthShell title={t("title")} description={t("description")}>
      <ForgotPasswordForm />
    </AuthShell>
  );
}

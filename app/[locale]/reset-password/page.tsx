import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthShell } from "@/components/auth-shell";
import { Link, redirect } from "@/i18n/navigation";
import { getServerSession } from "@/lib/auth-session";
import { ResetPasswordForm } from "./reset-password-form";

export default async function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { locale } = await params;
  const { token, error } = await searchParams;
  setRequestLocale(locale);

  const session = await getServerSession();
  if (session) {
    await redirect("/");
  }

  const t = await getTranslations("resetPassword");

  const invalid = !token || error === "INVALID_TOKEN";

  return (
    <AuthShell
      title={invalid ? t("invalidTitle") : t("title")}
      description={invalid ? t("invalidDescription") : t("description")}
    >
      {invalid ? (
        <Link
          href="/forgot-password"
          className="text-sm underline hover:no-underline"
        >
          {t("requestAgain")}
        </Link>
      ) : (
        <ResetPasswordForm token={token} />
      )}
    </AuthShell>
  );
}

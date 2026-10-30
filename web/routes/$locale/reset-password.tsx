import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { AuthShell } from "@/components/auth-shell";
import { Link, redirect } from "@/i18n/navigation";
import { meQuery } from "@/web/api/session";
import { ResetPasswordForm } from "./-components/reset-password-form";

// The link in the reset email lands here with `?token=`; better-auth sends
// `?error=INVALID_TOKEN` instead when the token has expired or been used.
export const Route = createFileRoute("/$locale/reset-password")({
  validateSearch: (
    search: Record<string, unknown>
  ): { token?: string; error?: string } => ({
    token: typeof search.token === "string" ? search.token : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  beforeLoad: async ({ params: { locale }, context: { queryClient } }) => {
    if (await queryClient.query(meQuery())) redirect("/", locale);
  },
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const t = useTranslations("resetPassword");
  const { token, error } = Route.useSearch();

  if (!token || error === "INVALID_TOKEN") {
    return (
      <AuthShell
        title={t("invalidTitle")}
        description={t("invalidDescription")}
      >
        <Link
          href="/forgot-password"
          className="text-sm underline hover:no-underline"
        >
          {t("requestAgain")}
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t("title")} description={t("description")}>
      <ResetPasswordForm token={token} />
    </AuthShell>
  );
}

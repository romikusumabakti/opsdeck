import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { AuthShell } from "@/components/auth-shell";
import { redirect } from "@/i18n/navigation";
import { meQuery } from "@/web/api/session";
import { hasAnyUserQuery } from "@/web/api/users";
import { SetupForm } from "./-components/setup-form";

// Creates the first account. Open only while there is none.
export const Route = createFileRoute("/$locale/setup")({
  beforeLoad: async ({ params: { locale }, context: { queryClient } }) => {
    if (await queryClient.query(meQuery())) redirect("/", locale);
    if (await queryClient.query(hasAnyUserQuery())) {
      redirect("/sign-in", locale);
    }
  },
  component: SetupPage,
});

function SetupPage() {
  const t = useTranslations("setup");
  return (
    <AuthShell title={t("title")} description={t("description")}>
      <SetupForm />
    </AuthShell>
  );
}

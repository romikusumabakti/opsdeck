import { getTranslations, setRequestLocale } from "next-intl/server";
import { hasAnyUser } from "@/actions/users";
import { AuthShell } from "@/components/auth-shell";
import { redirect } from "@/i18n/navigation";
import { SetupForm } from "./setup-form";

export default async function SetupPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  if (await hasAnyUser()) {
    await redirect("/sign-in");
  }

  const t = await getTranslations("setup");

  return (
    <AuthShell title={t("title")} description={t("description")}>
      <SetupForm />
    </AuthShell>
  );
}

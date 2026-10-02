import { Lock, Mail } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getEnvironmentById } from "@/actions/environments";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import { getEffectiveRole, isAdmin, requireSession } from "@/lib/auth-session";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";
import { loadMailpitConfig } from "@/lib/mailpit/config";
import { roleHasCapability } from "@/lib/roles";
import { MailInbox } from "./mail-inbox";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
}) {
  const { locale, projectKey, envSlug } = await params;
  const environmentId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  setRequestLocale(locale);

  const [session, environment, role] = await Promise.all([
    requireSession(),
    getEnvironmentById(environmentId),
    getEffectiveRole({ environmentId }),
  ]);
  const t = await getTranslations("mail");
  const tCommon = await getTranslations("common");

  if (!environment) return <p>{tCommon("environmentNotFound")}</p>;

  const header = (
    <PageHeader
      title={t("title")}
      subtitle={t("subtitle", { name: environment.name })}
    />
  );

  if (!roleHasCapability(role, "mail")) {
    return (
      <>
        {header}
        <EmptyState
          icon={Lock}
          title={t("forbiddenTitle")}
          description={t("forbiddenDescription")}
        />
      </>
    );
  }

  if (!(await loadMailpitConfig(environmentId))) {
    return (
      <>
        {header}
        <EmptyState
          icon={Mail}
          title={t("notConfiguredTitle")}
          description={t("notConfiguredDescription")}
          action={
            isAdmin(session) ? (
              <Button
                render={<Link href={`/${projectKey}/${envSlug}/settings`} />}
                variant="outline"
              >
                {t("openSettings")}
              </Button>
            ) : undefined
          }
        />
      </>
    );
  }

  return (
    <>
      {header}
      <MailInbox environmentId={environmentId} />
    </>
  );
}

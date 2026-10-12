import { Mail } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getEnvironmentById } from "@/actions/environments";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import { requireProjectPage } from "@/lib/authz";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";
import { loadMailpitConfig } from "@/lib/mailpit/config";
import { canProject } from "@/lib/permissions";
import { MailInbox } from "./mail-inbox";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
}) {
  const { locale, projectKey, envSlug } = await params;
  const environmentId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  setRequestLocale(locale);

  // 404 for callers whose role cannot read mail (viewers) or cannot see the project.
  const { role } = await requireProjectPage(
    { environmentId },
    { mail: ["read"] }
  );
  const environment = await getEnvironmentById(environmentId);
  const t = await getTranslations("mail");
  const tCommon = await getTranslations("common");

  if (!environment) return <p>{tCommon("environmentNotFound")}</p>;

  const header = (
    <PageHeader
      title={t("title")}
      subtitle={t("subtitle", { name: environment.name })}
    />
  );

  if (!(await loadMailpitConfig(environmentId))) {
    return (
      <>
        {header}
        <EmptyState
          icon={Mail}
          title={t("notConfiguredTitle")}
          description={t("notConfiguredDescription")}
          action={
            canProject(role, { environment: ["update"] }) ? (
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

  // From lg up, lock the page to the viewport so the message list and the
  // reading pane scroll independently instead of the whole page — same cap as
  // the service logs page: the sticky header (h-14 = 3.5rem) plus main's
  // vertical padding (py-6 = 3rem). Below lg the panes stack, so the page
  // scrolls normally and each pane caps its own height.
  return (
    <div className="flex flex-col gap-6 lg:h-[calc(100svh-6.5rem)] lg:min-h-0">
      {header}
      <MailInbox environmentId={environmentId} />
    </div>
  );
}

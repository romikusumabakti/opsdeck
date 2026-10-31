import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Mail } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useProjectName } from "@/hooks/use-project-name";
import { Link } from "@/i18n/navigation";
import { stripProjectPrefix } from "@/lib/nav-path";
import { canProject } from "@/lib/permissions";
import { getEnvironmentByIdQuery } from "@/web/api/environments";
import { getMailConfiguredQuery } from "@/web/api/mail";
import { requireRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { MailInbox } from "./-components/env/mail/mail-inbox";
import { MailPending } from "./-components/env/skeletons";

export const Route = createFileRoute("/$locale/_app/$projectKey/$envSlug/mail")(
  {
    // 404 for callers whose role cannot read mail (viewers).
    beforeLoad: ({ context: { role } }) =>
      requireRole(role, { mail: ["read"] }),
    loader: async ({ context: { queryClient, environmentId } }) => {
      await Promise.all([
        loaderQuery(queryClient, getEnvironmentByIdQuery(environmentId)),
        loaderQuery(queryClient, getMailConfiguredQuery(environmentId)),
      ]);
    },
    pendingComponent: MailPending,
    component: MailPage,
  }
);

function MailPage() {
  const { projectKey, envSlug } = Route.useParams();
  const { environmentId, role } = Route.useRouteContext();
  const t = useTranslations("mail");
  const tCommon = useTranslations("common");
  const environment = useSuspenseQuery(
    getEnvironmentByIdQuery(environmentId)
  ).data;
  const projectName = useProjectName(environment?.projectId ?? "");
  const { configured } = useSuspenseQuery(
    getMailConfiguredQuery(environmentId)
  ).data;

  if (!environment) return <p>{tCommon("environmentNotFound")}</p>;

  const header = (
    <PageHeader
      title={t("title")}
      subtitle={t("subtitle", {
        name: stripProjectPrefix(environment.name, projectName),
      })}
    />
  );

  if (!configured) {
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
                nativeButton={false}
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

import { getTranslations, setRequestLocale } from "next-intl/server";
import { listAllIssues } from "@/actions/issues";
import { listLabels } from "@/actions/labels";
import { listAssignableUsers } from "@/actions/users";
import { GlobalIssuesClient } from "@/components/global-issues-client";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth-session";

export default async function GlobalIssuesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await requireSession();
  const [issues, users, allLabels, t] = await Promise.all([
    listAllIssues(),
    listAssignableUsers(),
    listLabels(),
    getTranslations("issues"),
  ]);

  return (
    <>
      <PageHeader title={t("globalTitle")} subtitle={t("globalSubtitle")} />
      <GlobalIssuesClient
        initialIssues={issues}
        currentUserId={session.user.id}
        users={users}
        allLabels={allLabels}
      />
    </>
  );
}

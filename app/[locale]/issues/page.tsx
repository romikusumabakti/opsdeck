import { getTranslations, setRequestLocale } from "next-intl/server";
import { listAllIssues } from "@/actions/issues";
import { listLabels } from "@/actions/labels";
import { listSavedViews } from "@/actions/saved-views";
import { listAssignableUsers } from "@/actions/users";
import { GlobalIssuesClient } from "@/components/global-issues-client";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth-session";

const FILTER_KEYS = ["status", "project", "label", "mine", "view"] as const;

export default async function GlobalIssuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, sp] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);

  const initialFilters: Record<string, string> = {};
  for (const k of FILTER_KEYS) {
    const v = sp[k];
    if (typeof v === "string" && v) initialFilters[k] = v;
  }

  const session = await requireSession();
  const [issues, users, allLabels, savedViews, t] = await Promise.all([
    listAllIssues(),
    listAssignableUsers(),
    listLabels(),
    listSavedViews(),
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
        initialFilters={initialFilters}
        savedViews={savedViews}
      />
    </>
  );
}

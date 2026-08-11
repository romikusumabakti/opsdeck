import { getTranslations, setRequestLocale } from "next-intl/server";
import { listAllIssues } from "@/actions/issues";
import { listLabels } from "@/actions/labels";
import { listProjects } from "@/actions/project-catalog";
import { listSavedViews } from "@/actions/saved-views";
import { listAssignableUsers } from "@/actions/users";
import { GlobalIssuesClient } from "@/components/global-issues-client";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth-session";
import { BOARD_LIMIT, parseIssueParams } from "@/lib/issue-query";

export default async function GlobalIssuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, sp] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);

  const { filters, sort, desc, pageIndex, pageSize } = parseIssueParams(sp);
  // The board draws every matching issue in status columns, so it can't page —
  // it takes a capped slice instead and says so when the cap bites.
  const isBoard = filters.view === "board";

  const session = await requireSession();
  const [page, users, allLabels, savedViews, projects, t] = await Promise.all([
    listAllIssues({
      q: filters.q,
      status: filters.status,
      projectId: filters.project,
      labelId: filters.label,
      priority: filters.priority,
      assigneeId: filters.mine === "1" ? session.user.id : undefined,
      sort,
      desc,
      offset: isBoard ? 0 : pageIndex * pageSize,
      limit: isBoard ? BOARD_LIMIT : pageSize,
    }),
    listAssignableUsers(),
    listLabels(),
    listSavedViews(),
    // From the project table, not from the loaded issues: a project with no
    // issue on the current page must still be selectable in the filter.
    listProjects(),
    getTranslations("issues"),
  ]);

  return (
    <>
      <PageHeader title={t("globalTitle")} subtitle={t("globalSubtitle")} />
      <GlobalIssuesClient
        issues={page.rows}
        total={page.total}
        users={users}
        allLabels={allLabels}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        savedViews={savedViews}
        filters={filters}
        pageSize={pageSize}
      />
    </>
  );
}

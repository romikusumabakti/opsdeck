import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth-session";
import {
  defaultIssueTarget,
  firstName,
  greetingKey,
  hourIn,
} from "@/lib/home/layout";
import {
  listIssueProjects,
  listRecentEnvironments,
  type RecentEnvironment,
} from "@/lib/home/queries";
import { APP_TIMEZONE } from "@/lib/timezone";
import { HomeIssueDialogProvider } from "./_components/home-issue-dialog";
import { MainColumn } from "./_components/main-column";
import { NewIssueButton } from "./_components/new-issue-button";
import { RecentEnvsSection } from "./_components/recent-envs-section";
import { RunningRail } from "./_components/running-rail";
import { MainColumnSkeleton } from "./_components/skeletons";

// Main column: what needs the user (failures, their issues) — streamed, and
// ordered by what it contains. Rail: context (live runs, recent environments).
export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireSession();

  const [t, issueProjects, recent] = await Promise.all([
    getTranslations("homePage"),
    listIssueProjects(),
    listRecentEnvironments().catch(
      (error: unknown): RecentEnvironment[] | null => {
        console.error("Home recent environments failed:", error);
        return null;
      }
    ),
  ]);
  const target = defaultIssueTarget(
    recent ?? [],
    new Set(issueProjects.map((p) => p.id))
  );
  const greeting = t(
    `greeting.${greetingKey(hourIn(APP_TIMEZONE, new Date()))}`,
    { name: firstName(session.user.name) }
  );

  return (
    <HomeIssueDialogProvider projects={issueProjects} defaultTarget={target}>
      <PageHeader
        title={greeting}
        subtitle={t("subtitle")}
        action={<NewIssueButton />}
      />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Suspense fallback={<MainColumnSkeleton />}>
            <MainColumn />
          </Suspense>
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <RunningRail />
          <RecentEnvsSection environments={recent} />
        </aside>
      </div>
    </HomeIssueDialogProvider>
  );
}

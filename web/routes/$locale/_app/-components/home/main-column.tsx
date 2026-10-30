import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, CircleDot } from "lucide-react";
import { useTranslations } from "use-intl";
import { Link } from "@/i18n/navigation";
import { type SectionMode, sectionOrder } from "@/lib/home/layout";
import {
  type AttentionGroup,
  getAttentionGroupsQuery,
  getHomeAccessQuery,
  listMyOpenIssuesQuery,
  type MyIssue,
} from "@/web/api/home";
import { AttentionList } from "./attention-list";
import { CompactSection, HomeSection } from "./home-section";
import { MyIssuesList } from "./my-issues-list";
import { SectionError } from "./section-error";
import { MainColumnSkeleton } from "./skeletons";

// What one of the three queries came to: the data, or that it failed.
type Result<T> = { ok: true; value: T } | { ok: false };

function settle<T>(q: {
  data: T | undefined;
  isError: boolean;
}): Result<T> | null {
  if (q.data !== undefined) return { ok: true, value: q.data };
  return q.isError ? { ok: false } : null;
}

// The page does not wait for these (the loader only starts them): the
// skeleton shows until all three have settled, as the old Suspense boundary
// did, because the order of the two sections depends on all of them. A failed
// query is a failed section, not a failed page.
export function MainColumn() {
  const attention = settle(useQuery(getAttentionGroupsQuery()));
  const issues = settle(useQuery(listMyOpenIssuesQuery()));
  const access = settle(useQuery(getHomeAccessQuery()));
  if (!(attention && issues && access)) return <MainColumnSkeleton />;

  const order = sectionOrder({
    hasOpsAccess: access.ok && access.value.hasOpsAccess,
    attentionCount: attention.ok ? attention.value.length : 0,
    issueCount: issues.ok ? issues.value.total : 0,
  });

  return (
    <>
      {order.map((s) =>
        s.id === "attention" ? (
          <AttentionSection key="attention" mode={s.mode} result={attention} />
        ) : (
          <MyIssuesSection key="issues" mode={s.mode} result={issues} />
        )
      )}
    </>
  );
}

function AttentionSection({
  mode,
  result,
}: {
  mode: SectionMode;
  result: Result<AttentionGroup[]>;
}) {
  const t = useTranslations("homePage");
  // A failed query counts as 0 and may come out "hidden"; show the error anyway.
  if (mode === "hidden" && result.ok) return null;
  if (result.ok && mode === "compact") {
    return (
      <CompactSection
        icon={CircleCheck}
        iconClassName="text-success"
        title={t("attention.title")}
        text={t("attention.allClear")}
      />
    );
  }
  return (
    <HomeSection
      icon={CircleAlert}
      iconClassName="text-destructive"
      title={t("attention.title")}
      count={result.ok ? result.value.length : undefined}
    >
      {result.ok ? <AttentionList groups={result.value} /> : <SectionError />}
    </HomeSection>
  );
}

function MyIssuesSection({
  mode,
  result,
}: {
  mode: SectionMode;
  result: Result<{ items: MyIssue[]; total: number }>;
}) {
  const t = useTranslations("homePage");
  if (result.ok && mode === "compact") {
    return (
      <CompactSection
        icon={CircleDot}
        title={t("issues.title")}
        text={t("issues.empty")}
      />
    );
  }
  return (
    <HomeSection
      icon={CircleDot}
      title={t("issues.title")}
      action={
        result.ok ? (
          <Link
            href="/issues?mine=1"
            className="text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            {t("issues.viewAll", { count: result.value.total })}
          </Link>
        ) : null
      }
    >
      {result.ok ? (
        <MyIssuesList items={result.value.items} />
      ) : (
        <SectionError />
      )}
    </HomeSection>
  );
}

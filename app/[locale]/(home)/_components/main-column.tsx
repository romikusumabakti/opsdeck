import { CircleAlert, CircleCheck, CircleDot } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { type SectionMode, sectionOrder } from "@/lib/home/layout";
import {
  type AttentionGroup,
  getAttentionGroups,
  getHomeAccess,
  listMyOpenIssues,
  type MyIssue,
} from "@/lib/home/queries";
import { AttentionList } from "./attention-list";
import { CompactSection, HomeSection } from "./home-section";
import { MyIssuesList } from "./my-issues-list";
import { SectionError } from "./section-error";

// Suspends as one unit: the order of its two sections depends on both counts.
export async function MainColumn() {
  const [attention, issues, access] = await Promise.allSettled([
    getAttentionGroups(),
    listMyOpenIssues(),
    getHomeAccess(),
  ]);
  for (const r of [attention, issues, access]) {
    if (r.status === "rejected")
      console.error("Home section failed:", r.reason);
  }
  const order = sectionOrder({
    hasOpsAccess: access.status === "fulfilled" && access.value.hasOpsAccess,
    attentionCount:
      attention.status === "fulfilled" ? attention.value.length : 0,
    issueCount: issues.status === "fulfilled" ? issues.value.total : 0,
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

async function AttentionSection({
  mode,
  result,
}: {
  mode: SectionMode;
  result: PromiseSettledResult<AttentionGroup[]>;
}) {
  if (mode === "hidden") return null;
  const t = await getTranslations("homePage");
  if (result.status === "fulfilled" && mode === "compact") {
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
      count={result.status === "fulfilled" ? result.value.length : undefined}
    >
      {result.status === "fulfilled" ? (
        <AttentionList groups={result.value} />
      ) : (
        <SectionError />
      )}
    </HomeSection>
  );
}

async function MyIssuesSection({
  mode,
  result,
}: {
  mode: SectionMode;
  result: PromiseSettledResult<{ items: MyIssue[]; total: number }>;
}) {
  const t = await getTranslations("homePage");
  if (result.status === "fulfilled" && mode === "compact") {
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
        result.status === "fulfilled" ? (
          <Link
            href="/issues?mine=1"
            className="text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            {t("issues.viewAll", { count: result.value.total })}
          </Link>
        ) : null
      }
    >
      {result.status === "fulfilled" ? (
        <MyIssuesList items={result.value.items} />
      ) : (
        <SectionError />
      )}
    </HomeSection>
  );
}

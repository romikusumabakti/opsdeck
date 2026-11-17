import { useSuspenseQuery } from "@tanstack/react-query";
import { GitCommitHorizontal, PackageCheck, Tag } from "lucide-react";
import { useTranslations } from "use-intl";
import { RelativeTime } from "@/components/relative-time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type EnvironmentRunningItem,
  getEnvironmentRunningQuery,
} from "@/web/api/environments";

const SHORT_SHA = 7;

/**
 * What each deploy target of the environment runs: tag, short commit and
 * when it was deployed. Nothing when the environment has no deploy targets.
 */
export function RunningCard({ environmentId }: { environmentId: string }) {
  const { items } = useSuspenseQuery(
    getEnvironmentRunningQuery(environmentId)
  ).data;
  const t = useTranslations("dashboard");
  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <PackageCheck className="size-4 text-muted-foreground" />
        <CardTitle className="text-base">{t("running")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col">
          {items.map((item, i) => (
            <li
              key={item.componentKey}
              className={i === 0 ? "py-2" : "py-2 border-t border-border/40"}
            >
              <RunningRow item={item} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function RunningRow({ item }: { item: EnvironmentRunningItem }) {
  const t = useTranslations("dashboard");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
      <div className="flex flex-1 basis-48 flex-col min-w-0">
        <span className="text-sm font-medium truncate">
          {item.componentKey}
        </span>
        <span className="text-xs text-muted-foreground truncate">
          {item.repoFullName}
        </span>
      </div>
      {item.deployed ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {item.tag && (
            <span className="inline-flex items-center gap-1 text-foreground">
              <Tag className="size-3 shrink-0" />
              {item.tag}
            </span>
          )}
          {item.commitSha ? (
            <span className="inline-flex items-center gap-1">
              <GitCommitHorizontal className="size-3 shrink-0" />
              <code className="font-mono" title={item.commitSha}>
                {item.commitSha.slice(0, SHORT_SHA)}
              </code>
            </span>
          ) : (
            <span>{t("unknownCommit")}</span>
          )}
          {item.deployedAt && <RelativeTime date={item.deployedAt} />}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">
          {t("notDeployed")}
        </span>
      )}
    </div>
  );
}

export function RunningCardSkeleton() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Skeleton className="size-4 rounded-sm" />
        <Skeleton className="h-5 w-24" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="flex-1 flex flex-col gap-1.5">
              <Skeleton className="h-4 w-1/4" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-4 w-32" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

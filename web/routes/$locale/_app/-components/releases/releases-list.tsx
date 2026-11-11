import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleAlert,
  Download,
  Loader2,
  PackageCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { PageHeader } from "@/components/page-header";
import { useProjectCan } from "@/components/project-role";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { canOrg } from "@/lib/permissions";
import { formatBytes } from "@/lib/utils";
import {
  deleteRelease,
  listProjectReleasesQuery,
  type ReleaseListItem,
  releaseDownloadHref,
} from "@/web/api/releases";
import { useMe } from "@/web/api/session";

// While a release is being prepared, poll so it turns Ready without a reload.
const PREPARING_POLL_MS = 5000;

/** Releases grouped by version, the group of the newest release first. */
function groupByVersion(releases: ReleaseListItem[]) {
  const groups = new Map<string, ReleaseListItem[]>();
  for (const release of releases) {
    const group = groups.get(release.version);
    if (group) group.push(release);
    else groups.set(release.version, [release]);
  }
  return [...groups];
}

/**
 * A project's releases, grouped by version. Download needs the engineer role
 * and a ready release; delete is for org admins. The API enforces the same.
 */
export function ReleasesList({ projectId }: { projectId: string }) {
  const t = useTranslations("releases");
  const { releases, totalBytes } = useSuspenseQuery({
    ...listProjectReleasesQuery(projectId),
    refetchInterval: (query) =>
      query.state.data?.releases.some((r) => r.status === "preparing")
        ? PREPARING_POLL_MS
        : false,
  }).data;
  const canDownload = useProjectCan({ release: ["download"] });
  const canDelete = canOrg(useMe()?.orgRole, { server: ["manage"] });
  const groups = groupByVersion(releases);

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          <p className="text-sm text-muted-foreground">
            {t("totalSize")}:{" "}
            <span className="font-medium text-foreground">
              {formatBytes(totalBytes)}
            </span>
          </p>
        }
      />
      {groups.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={PackageCheck}
            title={t("title")}
            description={t("empty")}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(([version, rows]) => (
            <Card key={version}>
              <CardHeader>
                <CardTitle className="font-mono">
                  {t("versionGroup", { version })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colComponent")}</TableHead>
                      <TableHead>{t("colSource")}</TableHead>
                      <TableHead>{t("testedOn")}</TableHead>
                      <TableHead>{t("colBy")}</TableHead>
                      <TableHead>{t("colStatus")}</TableHead>
                      <TableHead>{t("colSize")}</TableHead>
                      <TableHead>
                        <span className="sr-only">{t("download")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((release) => (
                      <ReleaseRow
                        key={release.id}
                        release={release}
                        canDownload={canDownload}
                        canDelete={canDelete}
                      />
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function ReleaseRow({
  release,
  canDownload,
  canDelete,
}: {
  release: ReleaseListItem;
  canDownload: boolean;
  canDelete: boolean;
}) {
  const t = useTranslations("releases");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const queryClient = useQueryClient();

  async function onDelete() {
    const ok = await dialog.confirm({
      title: t("deleteTitle", { version: release.version }),
      description: t("deleteDescription", { component: release.componentKey }),
      confirmText: t("delete"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteRelease(release.id);
      toast.success(t("deleted"));
      await queryClient.invalidateQueries({ queryKey: ["releases"] });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : tCommon("errorGeneric")
      );
    }
  }

  return (
    <TableRow>
      <TableCell>
        <span className="font-mono text-xs">{release.componentKey}</span>
        {release.notes && (
          <span className="block max-w-[28rem] whitespace-pre-line text-xs text-muted-foreground">
            {release.notes}
          </span>
        )}
      </TableCell>
      <TableCell
        className="font-mono text-xs text-muted-foreground"
        title={release.commitSha}
      >
        {release.branch} · {release.commitSha.slice(0, 7)}
        <span className="block">{release.tag}</span>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {release.environmentName}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {release.createdByName}
        {release.createdByName && " · "}
        <RelativeTime date={release.createdAt} />
      </TableCell>
      <TableCell>
        <ReleaseStatus release={release} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {release.sizeBytes === null ? "" : formatBytes(release.sizeBytes)}
      </TableCell>
      <TableCell className="text-end">
        <div className="flex justify-end gap-2">
          {canDownload && release.status === "ready" && (
            <Button
              variant="outline"
              size="sm"
              render={<a href={releaseDownloadHref(release.id)} download />}
              nativeButton={false}
            >
              <Download data-icon="inline-start" />
              {t("download")}
            </Button>
          )}
          {canDelete && (
            <Button variant="ghost" size="sm" onClick={onDelete}>
              <Trash2 data-icon="inline-start" />
              {t("delete")}
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function ReleaseStatus({ release }: { release: ReleaseListItem }) {
  const t = useTranslations("releases");
  const label = t(`status.${release.status}`);
  switch (release.status) {
    case "ready":
      return (
        <Badge className="bg-success/15 text-success border-transparent">
          <CheckCircle2 data-icon="inline-start" />
          {label}
        </Badge>
      );
    case "failed":
      return (
        <div className="flex flex-col gap-1">
          <Badge variant="destructive">
            <CircleAlert data-icon="inline-start" />
            {label}
          </Badge>
          {release.error && (
            <span className="max-w-[20rem] text-xs text-destructive">
              {release.error}
            </span>
          )}
        </div>
      );
    default:
      return (
        <Badge variant="secondary">
          <Loader2 data-icon="inline-start" className="animate-spin" />
          {label}
        </Badge>
      );
  }
}

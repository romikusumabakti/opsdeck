import { useQuery } from "@tanstack/react-query";
import { Archive, Download } from "lucide-react";
import { useTranslations } from "use-intl";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes } from "@/lib/utils";
import {
  environmentArchiveFileHref,
  listEnvironmentArchivesQuery,
} from "@/web/api/instance";

/**
 * Admin → Instance → Backups, "Deleted environments": what each teardown
 * kept, until it expires. "Incomplete" is a teardown that has not deleted its
 * environment (yet, or ever: the daily prune removes it after 30 days).
 */
export function DeletedEnvironmentsCard() {
  const t = useTranslations("instanceBackups.deletedEnvironments");
  const archives = useQuery(listEnvironmentArchivesQuery());

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {archives.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t("loadFailed")}
          </p>
        ) : !archives.data ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : archives.data.length === 0 ? (
          <EmptyState icon={Archive} title={t("empty")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colProject")}</TableHead>
                <TableHead>{t("colEnvironment")}</TableHead>
                <TableHead>{t("colDeleted")}</TableHead>
                <TableHead>{t("colExpires")}</TableHead>
                <TableHead>{t("colFiles")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {archives.data.map((archive) => (
                <TableRow key={archive.id}>
                  <TableCell>{archive.projectName}</TableCell>
                  <TableCell>{archive.environmentName}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {archive.completedAt ? (
                      <RelativeTime date={archive.completedAt} />
                    ) : (
                      <Badge variant="outline">{t("incomplete")}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <RelativeTime date={archive.expiresAt} />
                  </TableCell>
                  <TableCell>
                    <ul className="flex flex-col gap-1">
                      {archive.files.map((file) => (
                        <li key={file.name}>
                          <a
                            href={environmentArchiveFileHref(
                              archive.id,
                              file.name
                            )}
                            download
                            className="inline-flex items-center gap-1.5 font-mono text-xs underline-offset-4 hover:underline"
                          >
                            <Download className="size-3.5" />
                            {file.name}
                            <span className="text-muted-foreground">
                              {formatBytes(file.size)}
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
